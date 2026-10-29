import { Router } from "express";
import { sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { one, rows } from "../db/sqlutil.js";
import { requireRoles } from "../auth/middleware.js";
import { LEAD_STATUSES } from "../lib/enums.js";
import { istToday } from "../lib/time.js";
import {
  attendanceRow,
  loadAttendanceRows,
} from "./attendance.service.js";
import { z } from "zod";
import { badRequest } from "../lib/errors.js";
import { zLocalDate } from "../lib/validate.js";

// GET /api/dashboard/summary — same keys, order and agent/management scoping as Spring's
// DashboardController, computed by ONE SQL statement instead of loading every lead, follow-up and
// call log (twice for admins) into memory.
//
// Agent scope (unchanged semantics):
//   leads           = leads with an ACTIVE assignment to the agent
//   follow-ups      = all follow-ups owned by the agent (any status, any lead)
//   calls           = calls made by the agent
//   unassignedLeads = 0 and analytics arrays are empty
export function dashboardRoutes(ctx: AppContext): Router {
  const r = Router();

  r.get("/api/dashboard/summary", async (req, res) => {
    const u = req.user!;
    const agent = u.role === "AGENT";
    const today = istToday(ctx.clock);

    const activeAssignments = agent
      ? sql`select * from lead_assignments where status = 'ACTIVE' and agent_id = ${u.id}`
      : sql`select * from lead_assignments where status = 'ACTIVE'`;
    const scopedLeads = agent
      ? sql`select * from leads where id in (select lead_id from aa)`
      : sql`select * from leads`;
    const scopedFollowUps = agent ? sql`select * from follow_ups where agent_id = ${u.id}` : sql`select * from follow_ups`;
    const callCount = agent ? sql`(select count(*) from call_logs where agent_id = ${u.id})` : sql`(select count(*) from call_logs)`;
    const views = agent
      ? sql`select lead_id from lead_view_activities where agent_id = ${u.id} and viewed_date = ${today}::date`
      : sql`select lead_id from lead_view_activities where viewed_date = ${today}::date`;

    const statusCounts = sql.join(
      LEAD_STATUSES.map((s) => sql`(select count(*) from l where status = ${s}) as ${sql.identifier("s_" + s)}`),
      sql`, `,
    );

    const analytics = agent
      ? sql`'[]'::jsonb as "agentLeadDistribution", '[]'::jsonb as "agentPerformance",
            '[]'::jsonb as "campaignPerformance", '[]'::jsonb as "leadSourcePerformance"`
      : sql`
        coalesce((select jsonb_agg(jsonb_build_object('agentId', ag.id, 'agentName', ag.full_name,
            'activeLeads', (select count(*) from aa where aa.agent_id = ag.id)) order by ag.id)
          from users ag where ag.role = 'AGENT' and ag.status = 'ACTIVE'), '[]'::jsonb) as "agentLeadDistribution",
        coalesce((select jsonb_agg(jsonb_build_object('agentId', ag.id, 'agentName', ag.full_name,
            'activeLeads', (select count(*) from aa where aa.agent_id = ag.id),
            'totalCalls', (select count(*) from call_logs c where c.agent_id = ag.id),
            'enrolledLeads', (select count(distinct c.lead_id) from call_logs c
                              where c.agent_id = ag.id and c.call_outcome = 'ENROLLED')) order by ag.id)
          from users ag where ag.role = 'AGENT' and ag.status = 'ACTIVE'), '[]'::jsonb) as "agentPerformance",
        coalesce((select jsonb_agg(jsonb_build_object('campaignId', cp.id, 'campaignName', cp.campaign_name,
            'source', cp.source, 'status', cp.status,
            'totalLeads', (select count(*) from l where l.campaign_id = cp.id),
            'enrolledLeads', (select count(*) from l where l.campaign_id = cp.id and l.status = 'ENROLLED')) order by cp.id)
          from campaigns cp), '[]'::jsonb) as "campaignPerformance",
        coalesce((select jsonb_agg(jsonb_build_object('source', g.source, 'totalLeads', g.total,
            'enrolledLeads', g.enrolled,
            'conversionRate', case when g.total = 0 then 0 else round(g.enrolled::numeric * 100 / g.total, 2) end)
            order by g.first_id)
          from (select coalesce(nullif(btrim(lead_source), ''), 'Unknown') as source, count(*) total,
                  count(*) filter (where status = 'ENROLLED') enrolled, min(id) first_id
                from l group by 1) g), '[]'::jsonb) as "leadSourcePerformance"`;

    const row = await one<Record<string, unknown>>(ctx.db, sql`
      with aa as (${activeAssignments}),
           l as (${scopedLeads}),
           f as (${scopedFollowUps}),
           active_leads as (select distinct lead_id from aa),
           viewed as (${views})
      select
        (select count(*) from l) as "totalLeads",
        ${statusCounts},
        (select count(*) from aa) as "assignedLeads",
        ${agent ? sql`0` : sql`(select count(*) from l where l.id not in (select lead_id from aa)
            and (l.status is null or l.status not in ('ENROLLED','NOT_INTERESTED','LOST','WRONG_NUMBER')))`} as "unassignedLeads",
        (select count(*) from f) as "totalFollowUps",
        (select count(*) from f where status = 'PENDING') as "pendingFollowUps",
        (select count(*) from f where status = 'COMPLETED') as "completedFollowUps",
        (select count(*) from f where status = 'MISSED') as "missedFollowUps",
        (select count(*) from f where status = 'CANCELLED') as "cancelledFollowUps",
        (select count(*) from f where status = 'PENDING' and follow_up_date::date = ${today}::date) as "todayFollowUps",
        ${callCount} as "totalCalls",
        (select count(*) from active_leads) as "activeLeadCount",
        (select count(*) from active_leads where lead_id in (select lead_id from viewed)) as "attendedLeads",
        ${analytics}`);

    const n = (k: string) => Number(row![k] ?? 0);
    const counts = Object.fromEntries(LEAD_STATUSES.map((s) => [s, n("s_" + s)]));
    const attended = n("attendedLeads");
    // conversionRate arrives as numeric text; Jackson emitted a double.
    const sources = (row!.leadSourcePerformance as Record<string, unknown>[]).map((s) => ({ ...s, conversionRate: Number(s.conversionRate) }));

    res.json({
      totalLeads: n("totalLeads"),
      newLeads: counts.NEW,
      contactedLeads: counts.CONTACTED,
      interestedLeads: counts.INTERESTED,
      followUpLeads: counts.FOLLOW_UP,
      counsellingLeads: counts.COUNSELLING,
      enrolledLeads: counts.ENROLLED,
      notInterestedLeads: counts.NOT_INTERESTED,
      wrongNumberLeads: counts.WRONG_NUMBER,
      noResponseLeads: counts.NO_RESPONSE,
      lostLeads: counts.LOST,
      assignedLeads: n("assignedLeads"),
      unassignedLeads: n("unassignedLeads"),
      totalFollowUps: n("totalFollowUps"),
      pendingFollowUps: n("pendingFollowUps"),
      completedFollowUps: n("completedFollowUps"),
      missedFollowUps: n("missedFollowUps"),
      cancelledFollowUps: n("cancelledFollowUps"),
      todayFollowUps: n("todayFollowUps"),
      leadStatusCounts: counts,
      totalCalls: n("totalCalls"),
      attendedLeads: attended,
      remainingLeads: n("activeLeadCount") - attended,
      agentLeadDistribution: row!.agentLeadDistribution,
      agentPerformance: row!.agentPerformance,
      campaignPerformance: row!.campaignPerformance,
      leadSourcePerformance: sources,
    });
  });


  // GET /api/dashboard/agent-current-leads — ADMIN/MANAGER only
  r.get(
    "/api/dashboard/agent-current-leads",
    requireRoles("ADMIN", "MANAGER"),
    async (_req, res) => {
      const currentLeads = await rows(ctx.db, sql`
        select
          u.id as "agentId",
          u.full_name as "agentName",
          c.lead_id as "leadId",
          l.full_name as "leadName",
          c.opened_at as "openedAt"
        from users u
        left join agent_current_leads c on c.agent_id = u.id
        left join leads l on l.id = c.lead_id
        where u.role = 'AGENT'
          and u.status = 'ACTIVE'
        order by u.full_name
      `);

      res.json(currentLeads);
    },
  );



  // GET /api/dashboard/reports — ADMIN/MANAGER only
  r.get(
    "/api/dashboard/reports",
    requireRoles("ADMIN", "MANAGER"),
    async (req, res) => {
      const parsed = z.object({
        from: zLocalDate,
        to: zLocalDate,
        agentId: z.coerce.number().int().positive().optional(),
      }).safeParse({
        from: req.query.from,
        to: req.query.to,
        agentId: req.query.agentId,
      });

      if (!parsed.success) {
        throw badRequest(
          "Provide valid from and to dates in YYYY-MM-DD format, and an optional valid agentId."
        );
      }

      const { from, to, agentId } = parsed.data;

      if (!from || !to || from > to) {
        throw badRequest("Both dates are required, and from must be on or before to.");
      }

      const agentFilter = agentId == null
        ? sql`true`
        : sql`agent_id = ${agentId}`;

      const callSummary = await one<Record<string, unknown>>(ctx.db, sql`
        select
          count(*)::int as "totalCalls",
          count(*) filter (where call_status = 'ANSWERED')::int as "answeredCalls",
          count(*) filter (where call_outcome = 'ENROLLED')::int as "enrolledCallOutcomes",
          coalesce(sum(duration_seconds), 0)::bigint as "totalCallDurationSeconds"
        from call_logs
        where call_start_time >= ${from}::date
          and call_start_time < (${to}::date + interval '1 day')
          and ${agentFilter}
      `);

      const callsByAgent = await rows(ctx.db, sql`
        select
          u.id as "agentId",
          u.full_name as "agentName",
          count(c.id)::int as "totalCalls",
          count(c.id) filter (where c.call_status = 'ANSWERED')::int as "answeredCalls",
          count(c.id) filter (where c.call_outcome = 'ENROLLED')::int as "enrolledCallOutcomes",
          coalesce(sum(c.duration_seconds), 0)::bigint as "totalCallDurationSeconds"
        from users u
        left join call_logs c
          on c.agent_id = u.id
          and c.call_start_time >= ${from}::date
          and c.call_start_time < (${to}::date + interval '1 day')
        where u.role = 'AGENT'
          and (${agentId ?? null}::bigint is null or u.id = ${agentId ?? null})
        group by u.id, u.full_name
        order by u.full_name
      `);

      const attendanceRows = await loadAttendanceRows(ctx.db, {
        from,
        to,
        agentNamesOnly: true,
      });

      const followUpSummary = await one<Record<string, unknown>>(ctx.db, sql`
  select
    count(*)::int as "totalFollowUps",
    count(*) filter (where status = 'PENDING')::int as "pendingFollowUps",
    count(*) filter (where status = 'COMPLETED')::int as "completedFollowUps",
    count(*) filter (where status = 'MISSED')::int as "missedFollowUps",
    count(*) filter (where status = 'CANCELLED')::int as "cancelledFollowUps"
  from follow_ups
  where follow_up_date >= ${from}::date
    and follow_up_date < (${to}::date + interval '1 day')
    and (${agentId ?? null}::bigint is null
      or agent_id = ${agentId ?? null})
`);

      const attendance = attendanceRows
        .filter((item) => agentId == null || item.attendance.agentId === agentId)
        .map((item) => attendanceRow(item, ctx.clock));

      res.json({
        from,
        to,
        agentId: agentId ?? null,
        attendance,
        calls: {
          totalCalls: Number(callSummary?.totalCalls ?? 0),
          answeredCalls: Number(callSummary?.answeredCalls ?? 0),
          enrolledCallOutcomes: Number(callSummary?.enrolledCallOutcomes ?? 0),
          totalCallDurationSeconds: Number(callSummary?.totalCallDurationSeconds ?? 0),
        },
        callsByAgent: callsByAgent.map((row) => ({
          ...row,
          totalCalls: Number(row.totalCalls ?? 0),
          answeredCalls: Number(row.answeredCalls ?? 0),
          enrolledCallOutcomes: Number(row.enrolledCallOutcomes ?? 0),
          totalCallDurationSeconds: Number(row.totalCallDurationSeconds ?? 0),
        })),
        followUps: Object.fromEntries(
          Object.entries(followUpSummary ?? {}).map(([key, value]) => [
            key,
            Number(value ?? 0),
          ])
        ),
      });
    },
  );



  return r;
}

