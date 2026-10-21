import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/pool.js";
import { agentAttendance, agentBreaks, type AgentAttendance, type AgentBreak } from "../db/schema.js";
import { mapJsonRow, mapRow, one, returningCols, selectCols } from "../db/sqlutil.js";
import { badRequest, conflict } from "../lib/errors.js";
import type { BreakType } from "../lib/enums.js";
import { cleanDetail, isBlank } from "./shared.js";
import {
  addDays, dayStartMicros, formatJackson, formatJavaToString, istNowMicros, istToday, micros,
  secondsBetween, utcNow, type Clock,
} from "../lib/time.js";

// Ported from AgentAttendanceService, AgentBreakService and AgentAttendanceAdminController.
// Wall-clock times are naive Asia/Kolkata; created_at/updated_at keep the UTC wall clock the
// Spring JVM has been writing.

export const LUNCH_LIMIT_SECONDS = 35 * 60;
export const TEA_LIMIT_SECONDS = 30 * 60;
export const BIO_LIMIT_SECONDS = 20 * 60;
export const TOTAL_NORMAL_LIMIT_SECONDS = LUNCH_LIMIT_SECONDS + TEA_LIMIT_SECONDS + BIO_LIMIT_SECONDS;

const LIMITS: Partial<Record<BreakType, number>> = { LUNCH: LUNCH_LIMIT_SECONDS, TEA: TEA_LIMIT_SECONDS, BIO: BIO_LIMIT_SECONDS };
const LABELS: Partial<Record<BreakType, string>> = { LUNCH: "Lunch Break", TEA: "Tea Break", BIO: "Bio Break" };
const NORMAL_TYPES = new Set(["NORMAL", "LUNCH", "TEA", "BIO"]);

/** SET-list ending a break at `t`: end = max(t, start), duration = whole seconds (AgentBreakService.closeBreak). */
const closeBreakAt = (t: SQL, alias = "") => {
  const st = sql.raw(alias ? `${alias}.start_time` : "start_time");
  return sql`end_time = greatest(${t}, ${st}), duration_seconds = floor(extract(epoch from greatest(${t}, ${st}) - ${st}))::bigint`;
};

// ---------------------------------------------------------------- attendance

/** AgentAttendanceService.recordLogin — one statement. */
export async function recordLogin(db: Db, agentId: number, clock: Clock): Promise<AgentAttendance> {
  const nowUs = istNowMicros(clock);
  const now = formatJackson(nowUs);
  const today = now.slice(0, 10);
  const utc = utcNow(clock);
  const r = await one(db, sql`
    with open as (
      select id, attendance_date from agent_attendance
      where agent_id = ${agentId} and logout_time is null
      order by login_time desc limit 1
    ),
    close_stale as (
      update agent_attendance a set logout_time = (o.attendance_date + 1)::timestamp, updated_at = ${utc}
      from open o where a.id = o.id and o.attendance_date <> ${today}::date
      returning a.id
    ),
    close_stale_break as (
      update agent_breaks b set ${closeBreakAt(sql`(o.attendance_date + 1)::timestamp`, "b")}
      from open o
      where o.attendance_date <> ${today}::date and b.attendance_id = o.id and b.agent_id = ${agentId} and b.end_time is null
    ),
    ins as (
      insert into agent_attendance (agent_id, attendance_date, login_time, logout_time, created_at, updated_at)
      select ${agentId}, ${today}::date, ${now}::timestamp, null, ${utc}::timestamp, ${utc}::timestamp
      where not exists (select 1 from open where attendance_date = ${today}::date)
      returning ${returningCols(agentAttendance)}
    )
    select * from ins
    union all
    select ${selectCols(agentAttendance, "a")} from agent_attendance a
    join open o on o.id = a.id where o.attendance_date = ${today}::date`);
  return mapRow(agentAttendance, r!);
}

/** AgentAttendanceService.recordLogout — closes the latest open session. */
/**
 * AgentAttendanceService.recordLogout + approved change: an active break of the session being
 * closed ends at the logout time (Spring left it open, so it kept counting until midnight).
 */
export async function recordLogout(db: Db, agentId: number, clock: Clock): Promise<AgentAttendance> {
  const now = sql`${formatJackson(istNowMicros(clock))}::timestamp`;
  const r = await one(db, sql`
    with att as (
      update agent_attendance set logout_time = ${now}, updated_at = ${utcNow(clock)}::timestamp
      where id = (select id from agent_attendance where agent_id = ${agentId} and logout_time is null
                  order by login_time desc limit 1)
      returning ${returningCols(agentAttendance)}
    ),
    end_break as (
      update agent_breaks b set ${closeBreakAt(now, "b")}
      from att where b.agent_id = att."agentId" and b.attendance_id = att.id and b.end_time is null
    )
    select * from att`);
  if (!r) throw badRequest("No active attendance session found.");
  return mapRow(agentAttendance, r);
}

export async function getTodayAttendance(db: Db, agentId: number, clock: Clock): Promise<AgentAttendance | null> {
  const r = await one(db, sql`
    select ${returningCols(agentAttendance)} from agent_attendance
    where agent_id = ${agentId} and attendance_date = ${istToday(clock)}::date
    order by login_time desc limit 1`);
  return r ? mapRow(agentAttendance, r) : null;
}

// ---------------------------------------------------------------- break durations

/** AgentBreakService.getEffectiveDuration (used for limits and the agent summary). */
export function serviceDuration(b: AgentBreak, nowUs: number, logoutTime: string | null = null): number {
  if (b.durationSeconds != null) return Math.max(0, b.durationSeconds);
  const start = micros(b.startTime);
  // An open break on a logged-out session (data written before logout ended breaks) stops at logout.
  const end = b.endTime != null ? micros(b.endTime) : logoutTime != null ? Math.min(micros(logoutTime), nowUs) : nowUs;
  return Math.max(0, secondsBetween(start, end));
}

/**
 * AgentAttendanceAdminController.getEffectiveDuration: break time clamped to the attendance day,
 * open breaks run to "now" (today) or day end (past days), and a stored duration caps the value.
 * The controller's separate branch for active normal breaks yields the same result, so one
 * function serves both.
 */
export function adminDuration(b: AgentBreak, attendanceDate: string, nowUs: number, today: string, logoutTime: string | null = null): number {
  const dayStart = dayStartMicros(attendanceDate);
  const dayEnd = dayStartMicros(addDays(attendanceDate, 1));
  let start = micros(b.startTime);
  if (start < dayStart) start = dayStart;
  if (start >= dayEnd) return 0;
  let end: number;
  if (b.endTime != null) end = micros(b.endTime);
  else if (logoutTime != null) end = micros(logoutTime); // open break on a closed session: stop at logout
  else if (attendanceDate < today) end = dayEnd;
  else end = nowUs;
  if (end > dayEnd) end = dayEnd;
  if (end <= start) return 0;
  const calculated = secondsBetween(start, end);
  if (b.endTime != null && b.durationSeconds != null) return Math.min(Math.max(0, b.durationSeconds), calculated);
  return calculated;
}

/** AgentAttendanceAdminController.getGrossWorkingSeconds */
export function grossWorkingSeconds(a: AgentAttendance, nowUs: number, today: string): number {
  if (!a.loginTime || !a.attendanceDate) return 0;
  const dayStart = dayStartMicros(a.attendanceDate);
  const dayEnd = dayStartMicros(addDays(a.attendanceDate, 1));
  let start = micros(a.loginTime);
  if (start < dayStart) start = dayStart;
  let end: number;
  if (a.logoutTime != null) end = micros(a.logoutTime);
  else if (a.attendanceDate < today) end = dayEnd;
  else if (a.attendanceDate > today) return 0;
  else end = nowUs;
  if (end > dayEnd) end = dayEnd;
  if (end <= start) return 0;
  return secondsBetween(start, end);
}

// ---------------------------------------------------------------- breaks

interface BreakState {
  attendance: AgentAttendance | null;
  activeBreak: AgentBreak | null;
  breaks: AgentBreak[]; // breaks of `attendance`, ordered by start_time
}

/** Open attendance (or today's attendance), the agent's active break, and that attendance's breaks. */
async function loadBreakState(db: Db, agentId: number, attendanceFilter: "open" | { date: string }): Promise<BreakState> {
  const att = attendanceFilter === "open"
    ? sql`select * from agent_attendance where agent_id = ${agentId} and logout_time is null order by login_time desc limit 1`
    : sql`select * from agent_attendance where agent_id = ${agentId} and attendance_date = ${attendanceFilter.date}::date order by login_time desc limit 1`;
  const r = await one<{ attendance: Record<string, unknown> | null; active: Record<string, unknown> | null; breaks: Record<string, unknown>[] }>(db, sql`
    with att as (${att})
    select
      (select to_jsonb(att) from att) as attendance,
      (select to_jsonb(b) from agent_breaks b where b.agent_id = ${agentId} and b.end_time is null
         order by b.start_time desc limit 1) as active,
      coalesce((select jsonb_agg(to_jsonb(b) order by b.start_time) from agent_breaks b, att
         where b.agent_id = ${agentId} and b.attendance_id = att.id), '[]'::jsonb) as breaks`);
  return {
    attendance: r?.attendance ? mapJsonRow(agentAttendance, r.attendance) : null,
    activeBreak: r?.active ? mapJsonRow(agentBreaks, r.active) : null,
    breaks: (r?.breaks ?? []).map((b) => mapJsonRow(agentBreaks, b)),
  };
}

/** AgentBreakService.startBreak — one read, one atomic write. Errors use the {"message"} envelope. */
export async function startBreak(db: Db, agentId: number, breakType: BreakType, reason: string | null, clock: Clock): Promise<AgentBreak> {
  if (breakType === "EXCEPTION" && isBlank(reason)) {
    throw badRequest("Reason is required for an exception break.", "message");
  }
  if (breakType === "NORMAL") throw badRequest("Select Lunch, Tea, Bio, or Exception Break.", "message");

  const state = await loadBreakState(db, agentId, "open");
  if (!state.attendance) throw conflict("No active attendance session. Please log in first.", "message");
  const nowUs = istNowMicros(clock);
  const now = formatJackson(nowUs);

  // An active break from an earlier attendance is closed automatically; one from this attendance blocks.
  let staleId: number | null = null;
  if (state.activeBreak) {
    if (state.activeBreak.attendanceId !== state.attendance.id) staleId = state.activeBreak.id;
    else throw conflict("You already have an active break.", "message");
  }

  const limit = LIMITS[breakType];
  if (limit != null) {
    const used = state.breaks.filter((b) => b.breakType === breakType).reduce((s, b) => s + serviceDuration(b, nowUs), 0);
    if (used >= limit) throw conflict(`${LABELS[breakType]} allowance is exhausted for today.`, "message");
  }

  const trimmed = cleanDetail(reason);
  const r = await one(db, sql`
    with close_stale as (
      update agent_breaks set end_time = greatest(${now}::timestamp, start_time),
        duration_seconds = floor(extract(epoch from greatest(${now}::timestamp, start_time) - start_time))::bigint
      where id = ${staleId} and end_time is null
      returning id
    )
    insert into agent_breaks (agent_id, attendance_id, break_type, start_time, end_time, duration_seconds, reason, limit_alert_sent, created_at)
    select ${agentId}, ${state.attendance.id}, ${breakType}, ${now}::timestamp, null, null, ${trimmed}, false, ${utcNow(clock)}::timestamp
    where not exists (
      select 1 from agent_breaks where agent_id = ${agentId} and end_time is null and id is distinct from ${staleId}::bigint
    )
    returning ${returningCols(agentBreaks)}`);
  // A concurrent request started a break between our read and write.
  if (!r) throw conflict("You already have an active break.", "message");
  return mapRow(agentBreaks, r);
}

/** AgentBreakService.endBreak */
export async function endBreak(db: Db, agentId: number, clock: Clock): Promise<AgentBreak> {
  const now = formatJackson(istNowMicros(clock));
  const r = await one(db, sql`
    update agent_breaks set end_time = greatest(${now}::timestamp, start_time),
      duration_seconds = floor(extract(epoch from greatest(${now}::timestamp, start_time) - start_time))::bigint
    where id = (select id from agent_breaks where agent_id = ${agentId} and end_time is null order by start_time desc limit 1)
    returning ${returningCols(agentBreaks)}`);
  if (!r) throw conflict("No active break found.", "message");
  return mapRow(agentBreaks, r);
}

export async function getActiveBreak(db: Db, agentId: number): Promise<AgentBreak | null> {
  const r = await one(db, sql`select ${returningCols(agentBreaks)} from agent_breaks
      where agent_id = ${agentId} and end_time is null order by start_time desc limit 1`);
  return r ? mapRow(agentBreaks, r) : null;
}

/** AgentBreakService.getBreakSummary — one round trip (Spring: ~9 queries). */
export async function getBreakSummary(db: Db, agentId: number, clock: Clock) {
  const today = istToday(clock);
  const state = await loadBreakState(db, agentId, { date: today });
  if (!state.attendance) throw conflict("No attendance record found for today.", "message");
  const nowUs = istNowMicros(clock);
  const logoutTime = state.attendance.logoutTime;
  const used = (t: string) => state.breaks.filter((b) => b.breakType === t).reduce((s, b) => s + serviceDuration(b, nowUs, logoutTime), 0);
  const lunch = used("LUNCH"), tea = used("TEA"), bio = used("BIO"), legacy = used("NORMAL");
  const normalUsed = lunch + tea + bio + legacy;
  const active = state.activeBreak && state.activeBreak.attendanceId === state.attendance.id ? state.activeBreak : null;
  return {
    normalUsedSeconds: normalUsed,
    normalRemainingSeconds: Math.max(0, TOTAL_NORMAL_LIMIT_SECONDS - normalUsed),
    exceptionUsedSeconds: used("EXCEPTION"),
    activeBreakStartTime: active ? formatJavaToString(micros(active.startTime)) : null,
    activeBreakType: active ? active.breakType : null,
    activeBreakElapsedSeconds: active ? serviceDuration(active, nowUs, logoutTime) : 0,
    lunchUsedSeconds: lunch,
    lunchRemainingSeconds: Math.max(0, LUNCH_LIMIT_SECONDS - lunch),
    teaUsedSeconds: tea,
    teaRemainingSeconds: Math.max(0, TEA_LIMIT_SECONDS - tea),
    bioUsedSeconds: bio,
    bioRemainingSeconds: Math.max(0, BIO_LIMIT_SECONDS - bio),
  };
}

// ---------------------------------------------------------------- admin views

interface AttendanceWithBreaks {
  attendance: AgentAttendance;
  agentName: string;
  breaks: AgentBreak[];
}

/**
 * All attendance rows with agent names and breaks in ONE query. Spring ran one break query per
 * row (N+1) and the admin page polls this every 15 s. Optional date bounds are additive.
 */
export async function loadAttendanceRows(db: Db, opts: { id?: number; from?: string; to?: string; agentNamesOnly?: boolean }): Promise<AttendanceWithBreaks[]> {
  const where = [sql`true`];
  if (opts.id != null) where.push(sql`a.id = ${opts.id}`);
  if (opts.from) where.push(sql`a.attendance_date >= ${opts.from}::date`);
  if (opts.to) where.push(sql`a.attendance_date <= ${opts.to}::date`);
  // List view names only AGENT users (others shown as "Agent #id"); detail view uses any user.
  const nameJoin = opts.agentNamesOnly ? sql`u.id = a.agent_id and u.role = 'AGENT'` : sql`u.id = a.agent_id`;
  const result = await db.execute(sql`
    select to_jsonb(a) as attendance, u.full_name as "agentName",
      coalesce((select jsonb_agg(to_jsonb(b) order by b.start_time) from agent_breaks b
                where b.agent_id = a.agent_id and b.attendance_id = a.id), '[]'::jsonb) as breaks
    from agent_attendance a
    left join users u on ${nameJoin}
    where ${sql.join(where, sql` and `)}
    order by a.attendance_date desc nulls last, a.login_time desc nulls last`);
  return (result.rows as { attendance: Record<string, unknown>; agentName: string | null; breaks: Record<string, unknown>[] }[]).map((r) => {
    const attendance = mapJsonRow(agentAttendance, r.attendance);
    return {
      attendance,
      agentName: r.agentName ?? `Agent #${attendance.agentId}`,
      breaks: r.breaks.map((b) => mapJsonRow(agentBreaks, b)),
    };
  });
}

const toStr = (v: string | null) => (v == null ? null : formatJavaToString(micros(v)));

export function attendanceRow(x: AttendanceWithBreaks, clock: Clock) {
  const { attendance: a, breaks } = x;
  const nowUs = istNowMicros(clock);
  const today = istToday(clock);
  const normal = breaks.filter((b) => NORMAL_TYPES.has(b.breakType)).reduce((s, b) => s + adminDuration(b, a.attendanceDate, nowUs, today, a.logoutTime), 0);
  const exception = breaks.filter((b) => b.breakType === "EXCEPTION").reduce((s, b) => s + adminDuration(b, a.attendanceDate, nowUs, today, a.logoutTime), 0);
  let active: AgentBreak | null = null;
  if (a.attendanceDate === today && a.logoutTime == null) {
    for (const b of breaks) if (b.endTime == null && (!active || micros(b.startTime) > micros(active.startTime))) active = b;
  }
  return {
    id: a.id,
    agentId: a.agentId,
    agentName: x.agentName,
    attendanceDate: a.attendanceDate,
    loginTime: toStr(a.loginTime),
    logoutTime: toStr(a.logoutTime),
    workingSeconds: Math.max(0, grossWorkingSeconds(a, nowUs, today) - normal - exception),
    normalBreakSeconds: normal,
    exceptionBreakSeconds: exception,
    onBreak: active != null,
    activeBreakType: active?.breakType ?? null,
    activeBreakStartTime: active ? toStr(active.startTime) : null,
  };
}

export function attendanceDetails(x: AttendanceWithBreaks, clock: Clock) {
  const { attendance: a, breaks } = x;
  const nowUs = istNowMicros(clock);
  const today = istToday(clock);
  const dur = (b: AgentBreak) => adminDuration(b, a.attendanceDate, nowUs, today, a.logoutTime);
  const normal = breaks.filter((b) => NORMAL_TYPES.has(b.breakType)).reduce((s, b) => s + dur(b), 0);
  const exception = breaks.filter((b) => b.breakType === "EXCEPTION").reduce((s, b) => s + dur(b), 0);
  const gross = grossWorkingSeconds(a, nowUs, today);
  return {
    id: a.id,
    agentId: a.agentId,
    agentName: x.agentName,
    attendanceDate: a.attendanceDate,
    loginTime: toStr(a.loginTime),
    logoutTime: toStr(a.logoutTime),
    grossWorkingSeconds: gross,
    workingSeconds: Math.max(0, gross - normal - exception),
    normalBreakSeconds: normal,
    exceptionBreakSeconds: exception,
    breaks: breaks.map((b) => ({
      id: b.id,
      breakType: b.breakType,
      startTime: toStr(b.startTime),
      endTime: toStr(b.endTime),
      durationSeconds: dur(b),
      reason: b.reason,
    })),
  };
}
