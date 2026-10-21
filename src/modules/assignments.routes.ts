import { Router } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { requireRoles } from "../auth/middleware.js";
import { leadAssignments } from "../db/schema.js";
import { mapRow, one, returningCols, rows, setAndStamp } from "../db/sqlutil.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { ASSIGNMENT_STATUSES, isClosedLead } from "../lib/enums.js";
import { enumParam, parseBody, pathId, zId } from "../lib/validate.js";
import { assertSelfOrManagement, checkAgent, checkTeam, isLeadAssignedTo, loadFacts } from "./shared.js";

// Authorization (fixed): Spring allowed AGENT every operation under /api/lead-assignments/**.
//   ADMIN/MANAGER: everything.
//   AGENT: read own assignments; transfer (reassign) only leads actively assigned to them.
const management = requireRoles("ADMIN", "MANAGER");

const zIdArray = z.preprocess((v) => (v === undefined ? null : v), z.array(zId).nullable());
/** Parameterised bigint[] literal: ARRAY[$1, $2, ...]::bigint[] */
const bigintArray = (ids: number[]) =>
  ids.length ? sql`ARRAY[${sql.join(ids.map((i) => sql`${i}`), sql`, `)}]::bigint[]` : sql`ARRAY[]::bigint[]`;

export function assignmentRoutes(ctx: AppContext): Router {
  const r = Router();
  const { db } = ctx;

  const list = async (where: ReturnType<typeof sql>) =>
    (await rows(db, sql`select ${returningCols(leadAssignments)} from lead_assignments where ${where} order by id`))
      .map((row) => mapRow(leadAssignments, row));

  // ------------------------------------------------------------ reads
  r.get("/api/lead-assignments", async (req, res) => {
    const u = req.user!;
    res.json(await list(u.role === "AGENT" ? sql`agent_id = ${u.id}` : sql`true`));
  });

  r.get("/api/lead-assignments/agent/:agentId", async (req, res) => {
    const agentId = pathId(req.params.agentId, "agentId");
    assertSelfOrManagement(req.user!, agentId);
    res.json(await list(sql`agent_id = ${agentId}`));
  });

  r.get("/api/lead-assignments/agent/:agentId/active", async (req, res) => {
    const agentId = pathId(req.params.agentId, "agentId");
    assertSelfOrManagement(req.user!, agentId);
    res.json(await list(sql`agent_id = ${agentId} and status = 'ACTIVE'`));
  });

  // Assignment history of a lead. Agents: only for a lead currently assigned to them.
  r.get("/api/lead-assignments/lead/:leadId", async (req, res) => {
    const leadId = pathId(req.params.leadId, "leadId");
    const u = req.user!;
    if (u.role === "AGENT" && !(await isLeadAssignedTo(db, leadId, u.id))) return void res.json([]);
    res.json(await list(sql`lead_id = ${leadId}`));
  });

  r.get("/api/lead-assignments/lead/:leadId/active", async (req, res) => {
    const leadId = pathId(req.params.leadId, "leadId");
    const u = req.user!;
    const row = await one(db, sql`select ${returningCols(leadAssignments)} from lead_assignments
        where lead_id = ${leadId} and status = 'ACTIVE' order by id desc limit 1`);
    // Agents only see the active assignment when it is theirs.
    if (!row || (u.role === "AGENT" && row.agentId !== u.id)) return void res.status(404).end();
    res.json(mapRow(leadAssignments, row));
  });

  r.get("/api/lead-assignments/team/:teamId", management, async (req, res) => {
    res.json(await list(sql`team_id = ${pathId(req.params.teamId, "teamId")}`));
  });

  r.get("/api/lead-assignments/team/:teamId/active", management, async (req, res) => {
    res.json(await list(sql`team_id = ${pathId(req.params.teamId, "teamId")} and status = 'ACTIVE'`));
  });

  r.get("/api/lead-assignments/status/:status", management, async (req, res) => {
    const status = enumParam(req.params.status, ASSIGNMENT_STATUSES, "status");
    res.json(await list(sql`status = ${status}`));
  });

  r.get("/api/lead-assignments/:id", async (req, res) => {
    const u = req.user!;
    const [a] = await list(sql`id = ${pathId(req.params.id)} ${u.role === "AGENT" ? sql`and agent_id = ${u.id}` : sql``}`);
    if (!a) return void res.status(404).end();
    res.json(a);
  });

  // ------------------------------------------------------------ create (ADMIN/MANAGER)
  r.post("/api/lead-assignments", management, async (req, res) => {
    const b = parseBody({ leadId: zId, agentId: zId, teamId: zId }, req.body);
    if (b.leadId == null) throw badRequest("Lead is required");
    if (b.agentId == null) throw badRequest("Agent is required");
    const f = await loadFacts(db, b.leadId, b.agentId, b.teamId);
    if (!f.leadExists) throw notFound("Lead not found");
    if (isClosedLead(f.leadStatus)) throw badRequest("Closed lead cannot be assigned. Reopen the lead first.");
    if (f.activeAssignmentId != null) throw badRequest("Lead already has an active assignment");
    checkAgent(f);
    checkTeam(f, b.teamId);
    const row = await one(db, sql`
      insert into lead_assignments (lead_id, agent_id, team_id, status)
      select ${b.leadId}, ${b.agentId}, ${b.teamId}::bigint, 'ACTIVE'
      where not exists (select 1 from lead_assignments where lead_id = ${b.leadId} and status = 'ACTIVE')
      returning ${returningCols(leadAssignments)}`);
    if (!row) throw badRequest("Lead already has an active assignment");
    res.json(mapRow(leadAssignments, row));
  });

  // Bulk: 2 round trips total (Spring: 2 per lead). Already-assigned leads are skipped.
  r.post("/api/lead-assignments/bulk", management, async (req, res) => {
    const b = parseBody({ leadIds: zIdArray, agentId: zId, teamId: zId }, req.body);
    if (b.leadIds == null || b.leadIds.length === 0) throw badRequest("At least one lead must be selected");
    if (b.agentId == null) throw badRequest("Agent is required");
    const f = await loadFacts(db, null, b.agentId, b.teamId);
    checkAgent(f, "Selected agent is inactive");
    checkTeam(f, b.teamId);

    // De-duplicated, order preserved (Spring would create two assignments for a repeated id).
    const ids = [...new Set(b.leadIds.filter((x): x is number => x != null))];
    const info = await rows<{ id: number; ord: number; exists: boolean; status: string | null; active: boolean }>(db, sql`
      select x.id, x.ord, l.id is not null as exists, l.status,
        exists (select 1 from lead_assignments la where la.lead_id = x.id and la.status = 'ACTIVE') as active
      from unnest(${bigintArray(ids)}) with ordinality as x(id, ord)
      left join leads l on l.id = x.id order by x.ord`);
    const toAssign: number[] = [];
    for (const lead of info) {
      if (!lead.exists) throw notFound(`Lead not found: ${lead.id}`);
      if (isClosedLead(lead.status)) throw badRequest(`Lead ${lead.id} is closed. Reopen the lead first.`);
      if (!lead.active) toAssign.push(lead.id);
    }
    if (toAssign.length === 0) throw badRequest("All selected leads are already assigned");
    const created = await rows(db, sql`
      insert into lead_assignments (lead_id, agent_id, team_id, status)
      select x.id, ${b.agentId}, ${b.teamId}::bigint, 'ACTIVE'
      from unnest(${bigintArray(toAssign)}) with ordinality as x(id, ord)
      where not exists (select 1 from lead_assignments la where la.lead_id = x.id and la.status = 'ACTIVE')
      order by x.ord
      returning ${returningCols(leadAssignments)}`);
    res.json(created.map((row) => mapRow(leadAssignments, row)));
  });

  // ------------------------------------------------------------ transfer / reopen
  const reassignShape = { newAgentId: zId, newTeamId: zId };

  // Transfer: deactivate the current assignment, create a new ACTIVE one, notify the new agent.
  r.put("/api/lead-assignments/:leadId/reassign", async (req, res) => {
    const leadId = pathId(req.params.leadId, "leadId");
    const b = parseBody(reassignShape, req.body);
    const u = req.user!;
    const f = await loadFacts(db, leadId, b.newAgentId, b.newTeamId);
    if (!f.leadExists) throw notFound("Lead not found");
    // Fixed: agents may transfer only a lead that is actively assigned to them.
    if (u.role === "AGENT" && f.activeAgentId !== u.id) throw forbidden("You can only transfer leads assigned to you");
    if (isClosedLead(f.leadStatus)) throw badRequest("Closed lead cannot be reassigned. Reopen the lead first.");
    if (b.newAgentId == null) throw badRequest("New agent is required");
    checkAgent(f);
    checkTeam(f, b.newTeamId);

    // Same agent and team: nothing to do, return the current assignment.
    if (f.activeAssignmentId != null && f.activeAgentId === b.newAgentId && f.activeTeamId === b.newTeamId) {
      const [cur] = await list(sql`id = ${f.activeAssignmentId}`);
      return void res.json(cur);
    }
    const teamText = b.newTeamId != null ? ` Team ID: ${b.newTeamId}` : "";
    const row = await one(db, sql`
      with old as (
        update lead_assignments set status = 'INACTIVE' where lead_id = ${leadId} and status = 'ACTIVE' returning id
      ),
      ins as (
        insert into lead_assignments (lead_id, agent_id, team_id, status)
        values (${leadId}, ${b.newAgentId}, ${b.newTeamId}::bigint, 'ACTIVE')
        returning ${returningCols(leadAssignments)}
      ),
      notify as (
        insert into notifications (user_id, type, title, message, reference_id, is_read)
        select ${b.newAgentId}, 'LEAD_TRANSFERRED', 'Lead Transferred',
               ${`Lead #${leadId} has been transferred to you.${teamText}`}, ins.id, false
        from ins
        where not exists (select 1 from notifications n where n.user_id = ${b.newAgentId}
                          and n.type = 'LEAD_TRANSFERRED' and n.reference_id = ins.id)
      )
      select * from ins`);
    res.json(mapRow(leadAssignments, row!));
  });

  r.put("/api/lead-assignments/:leadId/reopen", management, async (req, res) => {
    const leadId = pathId(req.params.leadId, "leadId");
    const b = parseBody(reassignShape, req.body);
    if (b.newAgentId == null) throw badRequest("New agent is required");
    const f = await loadFacts(db, leadId, b.newAgentId, b.newTeamId);
    if (!f.leadExists) throw notFound("Lead not found");
    if (!isClosedLead(f.leadStatus)) throw badRequest("Lead is not closed and does not need reopening.");
    checkAgent(f);
    checkTeam(f, b.newTeamId);
    const row = await one(db, sql`
      with old as (
        update lead_assignments set status = 'INACTIVE' where lead_id = ${leadId} and status = 'ACTIVE' returning id
      ),
      reopen as (update leads set ${setAndStamp([["status", sql`'NEW'::text`]])} where id = ${leadId} returning id)
      insert into lead_assignments (lead_id, agent_id, team_id, status)
      values (${leadId}, ${b.newAgentId}, ${b.newTeamId}::bigint, 'ACTIVE')
      returning ${returningCols(leadAssignments)}`);
    res.json(mapRow(leadAssignments, row!));
  });

  // ------------------------------------------------------------ status / delete (ADMIN/MANAGER)
  r.put("/api/lead-assignments/:id/status", management, async (req, res) => {
    const id = pathId(req.params.id);
    const status = enumParam(req.query.status, ASSIGNMENT_STATUSES, "status");
    const pre = await one<{ found: boolean; leadExists: boolean; leadStatus: string | null; otherActive: boolean }>(db, sql`
      select a.id is not null as found, l.id is not null as "leadExists", l.status as "leadStatus",
        exists (select 1 from lead_assignments o where o.lead_id = a.lead_id and o.status = 'ACTIVE' and o.id <> a.id) as "otherActive"
      from (select 1) d left join lead_assignments a on a.id = ${id} left join leads l on l.id = a.lead_id`);
    if (!pre!.found) throw badRequest("Assignment not found");
    if (status === "ACTIVE") {
      if (!pre!.leadExists) throw notFound("Lead not found");
      if (isClosedLead(pre!.leadStatus)) throw badRequest("Closed lead cannot have an active assignment. Reopen the lead first.");
      if (pre!.otherActive) throw badRequest("Lead already has another active assignment");
    }
    const row = await one(db, sql`update lead_assignments set status = ${status} where id = ${id}
        returning ${returningCols(leadAssignments)}`);
    res.json(mapRow(leadAssignments, row!));
  });

  r.delete("/api/lead-assignments/:id", management, async (req, res) => {
    const deleted = await rows(db, sql`delete from lead_assignments where id = ${pathId(req.params.id)} returning id`);
    if (deleted.length === 0) throw notFound("Assignment not found");
    res.status(204).end();
  });

  return r;
}

