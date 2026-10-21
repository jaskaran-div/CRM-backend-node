import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/pool.js";
import { NOW_UTC, rows } from "../db/sqlutil.js";
import { dayStartMicros, formatJackson, istNowMicros, jacksonToJavaToString, pgTextToJackson, type Clock } from "../lib/time.js";

// Port of FollowUpReminderScheduler (every 60 s, Asia/Kolkata):
//  1. PENDING follow-ups due within the next 15 minutes -> FOLLOW_UP_REMINDER notification.
//  2. PENDING follow-ups already past due -> mark their reminder read and create FOLLOW_UP_OVERDUE.
//     They stay PENDING (listed by /api/follow-ups/overdue) for the rest of their due date.
//  3. PENDING follow-ups whose due DATE has ended in Asia/Kolkata (follow_up_date < today 00:00 IST)
//     -> status MISSED. (Approved change: Spring marked them MISSED one minute after the due time.)
// Notifications are de-duplicated on (user_id, type, reference_id) like NotificationService.
//
// Safety: disabled unless SCHEDULER_ENABLED=true; a transaction-scoped advisory lock ensures only one
// instance runs a tick; all writes are guarded (NOT EXISTS / status = 'PENDING') so an overlap with
// the Spring scheduler during cutover cannot duplicate notifications or double-process rows.
const LOCK_KEY = 0x43524d01; // "CRM" + 1

export interface ReminderResult { reminded: number; overdue: number; missed: number; skipped: boolean }

export async function runFollowUpReminders(db: Db, clock: Clock): Promise<ReminderResult> {
  const nowUs = istNowMicros(clock);
  const now = formatJackson(nowUs);
  const todayStart = formatJackson(dayStartMicros(now.slice(0, 10)));
  const end = formatJackson(nowUs + 15 * 60 * 1_000_000);

  return db.transaction(async (tx) => {
    const lock = await rows<{ ok: boolean }>(tx as unknown as Db, sql`select pg_try_advisory_xact_lock(${LOCK_KEY}) as ok`);
    if (!lock[0]?.ok) return { reminded: 0, overdue: 0, missed: 0, skipped: true };

    const due = await rows<{ id: number; agent_id: number; follow_up_date: string; purpose: string | null; overdue: boolean }>(
      tx as unknown as Db, sql`
      select id, agent_id, follow_up_date, purpose, follow_up_date < ${now}::timestamp as overdue
      from follow_ups
      where status = 'PENDING' and follow_up_date <= ${end}::timestamp
      for update skip locked`);
    if (due.length === 0) return { reminded: 0, overdue: 0, missed: 0, skipped: false };

    const upcoming = due.filter((f) => !f.overdue);
    const overdue = due.filter((f) => f.overdue);
    const ids = (list: typeof due) => sql`ARRAY[${sql.join(list.map((f) => sql`${f.id}`), sql`, `)}]::bigint[]`;

    if (upcoming.length) {
      // Message embeds LocalDateTime.toString() of the follow-up date, as Spring's string concat did.
      const values = sql.join(upcoming.map((f) => sql`(${f.agent_id}::bigint, ${f.id}::bigint, ${
        `Follow-up #${f.id} is scheduled for ${jacksonToJavaToString(pgTextToJackson(f.follow_up_date))}. Purpose: ${f.purpose ?? "Follow-up"}`
      })`), sql`, `);
      await tx.execute(sql`
        insert into notifications (user_id, type, title, message, reference_id, is_read)
        select v.user_id, 'FOLLOW_UP_REMINDER', 'Upcoming Follow-up', v.message, v.ref, false
        from (values ${values}) as v(user_id, ref, message)
        where not exists (select 1 from notifications n
                          where n.user_id = v.user_id and n.type = 'FOLLOW_UP_REMINDER' and n.reference_id = v.ref)`);
    }

    if (overdue.length) {
      await tx.execute(sql`
        with od as (select id, agent_id from follow_ups where id = any(${ids(overdue)}) and status = 'PENDING'),
        read_reminders as (
          update notifications n set is_read = true from od
          where n.user_id = od.agent_id and n.type = 'FOLLOW_UP_REMINDER' and n.reference_id = od.id and not n.is_read
        ),
        notify as (
          insert into notifications (user_id, type, title, message, reference_id, is_read)
          select od.agent_id, 'FOLLOW_UP_OVERDUE', 'Overdue Follow-up',
                 'Follow-up #' || od.id || ' is overdue. Please complete it.', od.id, false
          from od where not exists (select 1 from notifications n
                                    where n.user_id = od.agent_id and n.type = 'FOLLOW_UP_OVERDUE' and n.reference_id = od.id)
        )
        select 1`);
    }

    // End of the IST due date: PENDING -> MISSED.
    const missed = await rows(tx as unknown as Db, sql`
      update follow_ups set status = 'MISSED', updated_at = ${NOW_UTC}
      where status = 'PENDING' and follow_up_date < ${todayStart}::timestamp
        and id = any(${ids(due)})
      returning id`);
    return { reminded: upcoming.length, overdue: overdue.length, missed: missed.length, skipped: false };
  });
}

export function startFollowUpScheduler(db: Db, clock: Clock, logger: Logger): () => void {
  let running = false;
  const tick = async () => {
    if (running) return; // never overlap ticks
    running = true;
    try {
      const r = await runFollowUpReminders(db, clock);
      if (r.reminded || r.missed) logger.info(r, "follow-up reminders processed");
    } catch (err) {
      logger.error({ err }, "follow-up reminder tick failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
