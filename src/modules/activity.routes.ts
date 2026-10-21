import { Router } from "express";
import { sql, type SQL } from "drizzle-orm";
import type { AppContext } from "../context.js";
import type { CurrentUser } from "../auth/middleware.js";
import { callLogs, followUps, notes, notifications } from "../db/schema.js";
import { mapRow, one, returningCols, rows, setAndStamp } from "../db/sqlutil.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import {
  CALL_OUTCOMES, CALL_STATUSES, FOLLOW_UP_STATUSES, OUTCOME_TO_LEAD_STATUS,
} from "../lib/enums.js";
import { enumParam, parseBody, pathId, zEnum, zId, zInt, zLocalDateTime, zStr } from "../lib/validate.js";
import { dayStartMicros, addDays, formatJackson, istNow, istToday, jacksonToJavaToString } from "../lib/time.js";
import { activelyAssignedTo, releaseIfClosing, checkAgent, cleanDetail, isLeadAssignedTo, loadFacts } from "./shared.js";

// Ownership rules for AGENT are those of CallLogService / FollowUpService / NoteService, ported
// unchanged. Authorization failures that Spring reported as 400 now return 403 (same message).

const isAgent = (u: CurrentUser) => u.role === "AGENT";

export function activityRoutes(ctx: AppContext): Router {
  const r = Router();
  const { db, clock } = ctx;

  // =================================================================== CALL LOGS
  const calls = async (where: SQL) =>
    (await rows(db, sql`select ${returningCols(callLogs)} from call_logs c where ${where} order by c.id`)).map((x) => mapRow(callLogs, x));

  r.get("/api/call-logs", async (req, res) => {
    const u = req.user!;
    res.json(await calls(isAgent(u) ? sql`c.agent_id = ${u.id}` : sql`true`));
  });

  r.get("/api/call-logs/lead/:leadId", async (req, res) => {
    const leadId = pathId(req.params.leadId, "leadId");
    const u = req.user!;
    res.json(await calls(sql`c.lead_id = ${leadId} and ${isAgent(u) ? activelyAssignedTo(sql`c.lead_id`, u.id) : sql`true`}`));
  });

  // Agents: calls (by anyone) on campaign leads actively assigned to them — as in Spring.
  r.get("/api/call-logs/campaign/:campaignId", async (req, res) => {
    const campaignId = pathId(req.params.campaignId, "campaignId");
    const u = req.user!;
    res.json(await calls(sql`c.lead_id in (select id from leads where campaign_id = ${campaignId})
        and ${isAgent(u) ? activelyAssignedTo(sql`c.lead_id`, u.id) : sql`true`}`));
  });

  r.get("/api/call-logs/agent/:agentId", async (req, res) => {
    const agentId = pathId(req.params.agentId, "agentId");
    const u = req.user!;
    if (isAgent(u) && u.id !== agentId) return void res.json([]);
    res.json(await calls(sql`c.agent_id = ${agentId}`));
  });

  r.get("/api/call-logs/status/:callStatus", async (req, res) => {
    const s = enumParam(req.params.callStatus, CALL_STATUSES, "callStatus");
    const u = req.user!;
    res.json(await calls(sql`c.call_status = ${s} ${isAgent(u) ? sql`and c.agent_id = ${u.id}` : sql``}`));
  });

  r.get("/api/call-logs/outcome/:callOutcome", async (req, res) => {
    const o = enumParam(req.params.callOutcome, CALL_OUTCOMES, "callOutcome");
    const u = req.user!;
    res.json(await calls(sql`c.call_outcome = ${o} ${isAgent(u) ? sql`and c.agent_id = ${u.id}` : sql``}`));
  });

  r.get("/api/call-logs/:id", async (req, res) => {
    const u = req.user!;
    const [c] = await calls(sql`c.id = ${pathId(req.params.id)} ${isAgent(u) ? sql`and c.agent_id = ${u.id}` : sql``}`);
    if (!c) return void res.status(404).end();
    res.json(c);
  });

  const callShape = {
    leadId: zId, agentId: zId, callStartTime: zLocalDateTime, callEndTime: zLocalDateTime, durationSeconds: zInt,
    callStatus: zEnum(CALL_STATUSES), callOutcome: zEnum(CALL_OUTCOMES), remarks: zStr,
    education: zStr, interestedArea: zStr, city: zStr,
  };
  type CallBody = ReturnType<typeof parseCall>;
  const parseCall = (body: unknown) => parseBody(callShape, body);

  /**
   * Save + side effects in ONE statement: copy non-blank education/interestedArea/city to the
   * lead, map the outcome to a lead status, and deactivate the assignment for a closing status.
   */
  async function writeCall(b: CallBody, existingId: number | null) {
    const newStatus = b.callOutcome ? OUTCOME_TO_LEAD_STATUS[b.callOutcome] ?? null : null;
    const values = sql`${b.leadId}, ${b.agentId}, ${b.callStartTime}::timestamp, ${b.callEndTime}::timestamp,
      ${b.durationSeconds}::int, ${b.callStatus}, ${b.callOutcome}, ${b.remarks}, ${b.education}, ${b.interestedArea}, ${b.city}`;
    const save = existingId == null
      ? sql`insert into call_logs (lead_id, agent_id, call_start_time, call_end_time, duration_seconds, call_status,
            call_outcome, remarks, education, interested_area, city) values (${values}) returning ${returningCols(callLogs)}`
      : sql`update call_logs set (lead_id, agent_id, call_start_time, call_end_time, duration_seconds, call_status,
            call_outcome, remarks, education, interested_area, city) = (${values}) where id = ${existingId}
            returning ${returningCols(callLogs)}`;
    const row = await one(db, sql`
      with saved as (${save}),
      lead as (
        update leads set ${setAndStamp([
          ["education", sql`coalesce(${cleanDetail(b.education)}::text, education)`],
          ["interested_area", sql`coalesce(${cleanDetail(b.interestedArea)}::text, interested_area)`],
          ["city", sql`coalesce(${cleanDetail(b.city)}::text, city)`],
          ["status", sql`coalesce(${newStatus}::text, status)`],
        ])}
        where id = ${b.leadId}
      ),
      ${releaseIfClosing(newStatus, sql`${b.leadId}::bigint`)}
      select * from saved`);
    return mapRow(callLogs, row!);
  }

  r.post("/api/call-logs", async (req, res) => {
    const b = parseCall(req.body);
    const u = req.user!;
    if (b.leadId == null) throw badRequest("Lead is required");
    if (isAgent(u)) b.agentId = u.id; // always the authenticated agent
    const f = await loadFacts(db, b.leadId, b.agentId, null);
    if (!f.leadExists) throw notFound("Lead not found");
    if (isAgent(u) && f.activeAgentId !== u.id) throw forbidden("You are not allowed to create a call log for this lead");
    if (b.agentId == null) throw badRequest("Agent is required");
    checkAgent(f);
    if (b.callStartTime == null) throw badRequest("Call start time is required");
    res.json(await writeCall(b, null));
  });

  r.put("/api/call-logs/:id", async (req, res) => {
    const id = pathId(req.params.id);
    const b = parseCall(req.body);
    const u = req.user!;
    const [existing] = await calls(sql`c.id = ${id}`);
    if (!existing) throw notFound("Call log not found");
    if (isAgent(u)) {
      if (existing.agentId !== u.id) throw forbidden("You are not allowed to update this call log");
      b.agentId = u.id;
      if (!(await isLeadAssignedTo(db, b.leadId, u.id))) throw forbidden("You are not allowed to move this call log to this lead");
    }
    if (b.leadId == null) throw badRequest("Lead is required");
    const f = await loadFacts(db, b.leadId, null, null);
    if (!f.leadExists) throw notFound("Lead not found");
    if (b.agentId == null) throw badRequest("Agent is required");
    if (b.callStartTime == null) throw badRequest("Call start time is required");
    res.json(await writeCall(b, id));
  });

  r.delete("/api/call-logs/:id", async (req, res) => {
    const id = pathId(req.params.id);
    const u = req.user!;
    const [existing] = await calls(sql`c.id = ${id}`);
    if (!existing) throw notFound("Call log not found");
    if (isAgent(u) && existing.agentId !== u.id) throw forbidden("You are not allowed to delete this call log");
    await db.execute(sql`delete from call_logs where id = ${id}`);
    res.status(204).end();
  });

  // =================================================================== FOLLOW-UPS
  const fus = async (where: SQL) =>
    (await rows(db, sql`select ${returningCols(followUps)} from follow_ups f where ${where} order by f.id`)).map((x) => mapRow(followUps, x));
  /** Agents: their own follow-ups on leads still actively assigned to them. */
  const agentScope = (u: CurrentUser) => sql`f.agent_id = ${u.id} and ${activelyAssignedTo(sql`f.lead_id`, u.id)}`;

  r.get("/api/follow-ups", async (req, res) => {
    const u = req.user!;
    res.json(await fus(isAgent(u) ? agentScope(u) : sql`true`));
  });

  // "now"/"today" are Asia/Kolkata. Spring used the JVM default zone (UTC on EC2) here while the
  // reminder scheduler used IST, so these lists were up to 5.5 h off.
  r.get("/api/follow-ups/overdue", async (req, res) => {
    const u = req.user!;
    res.json(await fus(sql`f.follow_up_date < ${istNow(clock)}::timestamp and f.status = 'PENDING'
        and ${isAgent(u) ? agentScope(u) : sql`true`}`));
  });

  r.get("/api/follow-ups/today", async (req, res) => {
    const u = req.user!;
    const today = istToday(clock);
    const start = formatJackson(dayStartMicros(today));
    const end = formatJackson(dayStartMicros(addDays(today, 1)));
    // Spring's findByFollowUpDateBetween is inclusive at both ends.
    res.json(await fus(sql`f.follow_up_date between ${start}::timestamp and ${end}::timestamp and f.status = 'PENDING'
        and ${isAgent(u) ? agentScope(u) : sql`true`}`));
  });

  r.get("/api/follow-ups/upcoming", async (req, res) => {
    const u = req.user!;
    res.json(await fus(sql`f.follow_up_date > ${istNow(clock)}::timestamp and f.status = 'PENDING'
        and ${isAgent(u) ? agentScope(u) : sql`true`}`));
  });

  // Agents get the lead's full history (any author) when the lead is actively assigned to them.
  r.get("/api/follow-ups/lead/:leadId", async (req, res) => {
    const leadId = pathId(req.params.leadId, "leadId");
    const u = req.user!;
    res.json(await fus(sql`f.lead_id = ${leadId} and ${isAgent(u) ? activelyAssignedTo(sql`f.lead_id`, u.id) : sql`true`}`));
  });

  r.get("/api/follow-ups/agent/:agentId", async (req, res) => {
    const agentId = pathId(req.params.agentId, "agentId");
    const u = req.user!;
    if (isAgent(u) && u.id !== agentId) return void res.json([]);
    res.json(await fus(isAgent(u) ? agentScope(u) : sql`f.agent_id = ${agentId}`));
  });

  r.get("/api/follow-ups/status/:status", async (req, res) => {
    const s = enumParam(req.params.status, FOLLOW_UP_STATUSES, "status");
    const u = req.user!;
    res.json(await fus(sql`f.status = ${s} and ${isAgent(u) ? agentScope(u) : sql`true`}`));
  });

  r.get("/api/follow-ups/agent/:agentId/status/:status", async (req, res) => {
    const agentId = pathId(req.params.agentId, "agentId");
    const s = enumParam(req.params.status, FOLLOW_UP_STATUSES, "status");
    const u = req.user!;
    if (isAgent(u) && u.id !== agentId) return void res.json([]);
    res.json(await fus(sql`f.status = ${s} and ${isAgent(u) ? agentScope(u) : sql`f.agent_id = ${agentId}`}`));
  });

  r.get("/api/follow-ups/:id", async (req, res) => {
    const u = req.user!;
    const [f] = await fus(sql`f.id = ${pathId(req.params.id)} and ${isAgent(u) ? agentScope(u) : sql`true`}`);
    if (!f) return void res.status(404).end();
    res.json(f);
  });

  const fuShape = { leadId: zId, agentId: zId, followUpDate: zLocalDateTime, purpose: zStr, status: zEnum(FOLLOW_UP_STATUSES), remarks: zStr };

  r.post("/api/follow-ups", async (req, res) => {
    const b = parseBody(fuShape, req.body);
    const u = req.user!;
    if (b.leadId == null) throw badRequest("Lead is required");
    if (isAgent(u)) b.agentId = u.id;
    const f = await loadFacts(db, b.leadId, b.agentId, null);
    if (!f.leadExists) throw notFound("Lead not found");
    if (isAgent(u) && f.activeAgentId !== u.id) throw forbidden("You are not allowed to create a follow-up for this lead");
    if (b.agentId == null) throw badRequest("Agent is required");
    checkAgent(f);
    if (b.followUpDate == null) throw badRequest("Follow-up date is required");
    const status = b.status ?? "PENDING";
    const pending = status === "PENDING";
    const purposeText = b.purpose ?? "Follow-up";
    // Follow-up + notification + lead status (PENDING -> FOLLOW_UP) in one atomic statement.
    const row = await one(db, sql`
      with ins as (
        insert into follow_ups (lead_id, agent_id, follow_up_date, purpose, status, remarks)
        values (${b.leadId}, ${b.agentId}, ${b.followUpDate}::timestamp, ${b.purpose}, ${status}, ${b.remarks})
        returning ${returningCols(followUps)}
      ),
      notify as (
        insert into notifications (user_id, type, title, message, reference_id, is_read)
        select ${b.agentId}, 'FOLLOW_UP_CREATED', 'New Follow-up Assigned',
          'Follow-up #' || ins.id || ${` has been scheduled for ${jacksonToJavaToString(b.followUpDate)}. Purpose: ${purposeText}`},
          ins.id, false
        from ins where ${pending}
      ),
      lead as (update leads set ${setAndStamp([["status", sql`'FOLLOW_UP'::text`]])} where ${pending} and id = ${b.leadId})
      select * from ins`);
    res.json(mapRow(followUps, row!));
  });

  async function loadFollowUpForWrite(id: number, u: CurrentUser, verb: "update" | "delete") {
    const [existing] = await fus(sql`f.id = ${id}`);
    if (!existing) throw notFound("Follow-up not found");
    if (isAgent(u)) {
      if (existing.agentId !== u.id) throw forbidden(`You are not allowed to ${verb} this follow-up`);
      if (!(await isLeadAssignedTo(db, existing.leadId, u.id))) {
        throw forbidden(`You are not allowed to ${verb} this follow-up because the lead is not actively assigned to you`);
      }
    }
    return existing;
  }

  r.put("/api/follow-ups/:id", async (req, res) => {
    const id = pathId(req.params.id);
    const b = parseBody(fuShape, req.body);
    const u = req.user!;
    const existing = await loadFollowUpForWrite(id, u, "update");
    if (isAgent(u)) {
      if (!(await isLeadAssignedTo(db, b.leadId, u.id))) throw forbidden("You are not allowed to move this follow-up to this lead");
      b.agentId = u.id;
    }
    if (b.leadId == null) throw badRequest("Lead is required");
    const f = await loadFacts(db, b.leadId, null, null);
    if (!f.leadExists) throw notFound("Lead not found");
    if (b.agentId == null) throw badRequest("Agent is required");
    if (b.followUpDate == null) throw badRequest("Follow-up date is required");
    const row = await one(db, sql`
      update follow_ups set ${setAndStamp([
        ["lead_id", sql`${b.leadId}::bigint`], ["agent_id", sql`${b.agentId}::bigint`],
        ["follow_up_date", sql`${b.followUpDate}::timestamp`], ["purpose", sql`${b.purpose}::text`],
        ["status", sql`${b.status ?? existing.status}::text`], ["remarks", sql`${b.remarks}::text`],
      ])}
      where id = ${id} returning ${returningCols(followUps)}`);
    res.json(mapRow(followUps, row!));
  });

  r.put("/api/follow-ups/:id/status", async (req, res) => {
    const id = pathId(req.params.id);
    const status = enumParam(req.query.status, FOLLOW_UP_STATUSES, "status");
    await loadFollowUpForWrite(id, req.user!, "update");
    const row = await one(db, sql`update follow_ups set ${setAndStamp([["status", sql`${status}::text`]])} where id = ${id} returning ${returningCols(followUps)}`);
    res.json(mapRow(followUps, row!));
  });

  r.delete("/api/follow-ups/:id", async (req, res) => {
    const id = pathId(req.params.id);
    await loadFollowUpForWrite(id, req.user!, "delete");
    await db.execute(sql`delete from follow_ups where id = ${id}`);
    res.status(204).end();
  });

  // =================================================================== NOTES
  const noteList = async (where: SQL) =>
    (await rows(db, sql`select ${returningCols(notes)} from notes n where ${where} order by n.id`)).map((x) => mapRow(notes, x));
  /** Agents: notes (by anyone) on leads actively assigned to them. */
  const noteScope = (u: CurrentUser) => (isAgent(u) ? activelyAssignedTo(sql`n.lead_id`, u.id) : sql`true`);

  r.get("/api/notes", async (req, res) => {
    res.json(await noteList(noteScope(req.user!)));
  });

  r.get("/api/notes/lead/:leadId", async (req, res) => {
    res.json(await noteList(sql`n.lead_id = ${pathId(req.params.leadId, "leadId")} and ${noteScope(req.user!)}`));
  });

  r.get("/api/notes/user/:userId", async (req, res) => {
    const userId = pathId(req.params.userId, "userId");
    const u = req.user!;
    if (isAgent(u) && u.id !== userId) return void res.json([]);
    res.json(await noteList(sql`n.user_id = ${userId}`));
  });

  r.get("/api/notes/:id", async (req, res) => {
    const [n] = await noteList(sql`n.id = ${pathId(req.params.id)} and ${noteScope(req.user!)}`);
    if (!n) return void res.status(404).end();
    res.json(n);
  });

  const noteShape = { leadId: zId, userId: zId, note: zStr };

  async function checkNoteTarget(leadId: number | null, userId: number | null) {
    if (leadId == null) throw badRequest("Lead is required");
    const r0 = await one<{ lead: boolean; user: boolean; status: string | null }>(db, sql`
      select exists (select 1 from leads where id = ${leadId}) as lead,
             exists (select 1 from users where id = ${userId}) as user,
             (select status from users where id = ${userId}) as status`);
    if (!r0!.lead) throw notFound("Lead not found");
    if (userId == null) throw badRequest("User is required");
    if (!r0!.user) throw notFound("User not found");
    if (r0!.status !== "ACTIVE") throw badRequest("User is inactive");
  }

  r.post("/api/notes", async (req, res) => {
    const b = parseBody(noteShape, req.body);
    const u = req.user!;
    if (isAgent(u)) {
      if (b.leadId == null) throw badRequest("Lead is required");
      if (!(await isLeadAssignedTo(db, b.leadId, u.id))) {
        const f = await loadFacts(db, b.leadId, null, null);
        if (!f.leadExists) throw notFound("Lead not found");
        throw forbidden("You are not allowed to create a note for this lead");
      }
      b.userId = u.id;
    }
    await checkNoteTarget(b.leadId, b.userId);
    if (b.note == null) throw badRequest("Note is required");
    const row = await one(db, sql`insert into notes (lead_id, user_id, note) values (${b.leadId}, ${b.userId}, ${b.note})
        returning ${returningCols(notes)}`);
    res.json(mapRow(notes, row!));
  });

  r.put("/api/notes/:id", async (req, res) => {
    const id = pathId(req.params.id);
    const b = parseBody(noteShape, req.body);
    const u = req.user!;
    const [existing] = await noteList(sql`n.id = ${id}`);
    if (!existing) throw notFound("Note not found");
    if (isAgent(u)) {
      if (!(await isLeadAssignedTo(db, existing.leadId, u.id))) throw forbidden("You are not allowed to update this note");
      if (!(await isLeadAssignedTo(db, b.leadId, u.id))) throw forbidden("You are not allowed to move this note to this lead");
      b.userId = u.id;
    }
    await checkNoteTarget(b.leadId, b.userId);
    if (b.note == null) throw badRequest("Note is required");
    const row = await one(db, sql`update notes set lead_id = ${b.leadId}, user_id = ${b.userId}, note = ${b.note}
        where id = ${id} returning ${returningCols(notes)}`);
    res.json(mapRow(notes, row!));
  });

  r.delete("/api/notes/:id", async (req, res) => {
    const id = pathId(req.params.id);
    const u = req.user!;
    const [existing] = await noteList(sql`n.id = ${id}`);
    if (!existing) throw notFound("Note not found");
    if (isAgent(u) && !(await isLeadAssignedTo(db, existing.leadId, u.id))) throw forbidden("You are not allowed to delete this note");
    await db.execute(sql`delete from notes where id = ${id}`);
    res.status(204).end();
  });

  // =================================================================== NOTIFICATIONS (own only)
  const notifs = async (u: CurrentUser, extra: SQL = sql`true`) =>
    (await rows(db, sql`select ${returningCols(notifications)} from notifications where user_id = ${u.id} and ${extra}
        order by created_at desc nulls last, id desc`)).map((x) => mapRow(notifications, x));

  r.get("/api/notifications", async (req, res) => {
    res.json(await notifs(req.user!));
  });

  r.get("/api/notifications/unread", async (req, res) => {
    res.json(await notifs(req.user!, sql`is_read = false`));
  });

  r.get("/api/notifications/unread/count", async (req, res) => {
    const r0 = await one<{ n: number }>(db, sql`select count(*)::int as n from notifications where user_id = ${req.user!.id} and is_read = false`);
    res.json(r0!.n);
  });

  r.put("/api/notifications/read-all", async (req, res) => {
    await db.execute(sql`update notifications set is_read = true where user_id = ${req.user!.id} and is_read = false`);
    res.status(204).end();
  });

  r.put("/api/notifications/:id/read", async (req, res) => {
    const id = pathId(req.params.id);
    const r0 = await one<Record<string, unknown> & { _owner: number | null }>(db, sql`
      with target as (select id, user_id from notifications where id = ${id}),
      upd as (update notifications set is_read = true where id = ${id} and user_id = ${req.user!.id}
              returning ${returningCols(notifications)})
      select upd.*, target.user_id as "_owner" from target left join upd on true`);
    if (!r0) throw notFound("Notification not found");
    if (r0._owner !== req.user!.id) throw forbidden("You are not allowed to modify this notification");
    res.json(mapRow(notifications, r0));
  });

  return r;
}
