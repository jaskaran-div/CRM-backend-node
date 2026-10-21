import { Router } from "express";
import { sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { requireRoles, type CurrentUser } from "../auth/middleware.js";
import { leadAssignments, leads } from "../db/schema.js";
import { mapRow, one, returningCols, rows, selectCols, setAndStamp } from "../db/sqlutil.js";
import { badRequest, forbidden, notFound, pgCode } from "../lib/errors.js";
import { LEAD_STATUSES, PRIORITIES } from "../lib/enums.js";
import { enumBody, parseBody, pathId, zEnum, zId, zInt, zStr } from "../lib/validate.js";
import { istToday } from "../lib/time.js";
import { activeAssignmentsOf, activelyAssignedTo, releaseIfClosing, assertSelfOrManagement, cleanDetail, isBlank, javaTrim, updateLeadStatus } from "./shared.js";

const PHONE_RE = /^\+?[0-9]{10,15}$/;
const management = requireRoles("ADMIN", "MANAGER");

/** Agents see only leads actively assigned to them. */
const visibleTo = (u: CurrentUser) => (u.role === "AGENT" ? activelyAssignedTo(sql`l.id`, u.id) : sql`true`);

function validateNameAndPhone(fullName: string | null, phone: string | null): void {
  if (isBlank(fullName)) throw badRequest("Lead full name is required");
  if (isBlank(phone)) throw badRequest("Lead phone number is required");
  if (!PHONE_RE.test(phone!)) throw badRequest("Lead phone number must contain 10 to 15 digits");
}

export function leadRoutes(ctx: AppContext): Router {
  const r = Router();
  const { db, clock } = ctx;

  const listLeads = async (user: CurrentUser, extra = sql`true`) =>
    (await rows(db, sql`select ${selectCols(leads, "l")} from leads l where ${visibleTo(user)} and ${extra} order by l.id`))
      .map((row) => mapRow(leads, row));

  // ------------------------------------------------------------ reads (all roles)
  r.get("/api/leads", async (req, res) => {
    res.json(await listLeads(req.user!));
  });

  // Fixed: Spring returned every lead of the campaign to agents.
  r.get("/api/leads/campaign/:campaignId", async (req, res) => {
    const campaignId = pathId(req.params.campaignId, "campaignId");
    res.json(await listLeads(req.user!, sql`l.campaign_id = ${campaignId}`));
  });

  r.get("/api/leads/:id", async (req, res) => {
    const [lead] = await listLeads(req.user!, sql`l.id = ${pathId(req.params.id)}`);
    if (!lead) return void res.status(404).end();
    res.json(lead);
  });

  // Placeholder kept for compatibility (Spring returned only the id).
  r.get("/api/leads/:id/activity", (req, res) => {
    res.json({ leadId: pathId(req.params.id) });
  });

  // ------------------------------------------------------------ create (all roles)
  const leadShape = {
    fullName: zStr, email: zStr, phone: zStr, courseInterested: zStr, leadSource: zStr,
    status: zEnum(LEAD_STATUSES), priority: zEnum(PRIORITIES), city: zStr, education: zStr,
    interestedArea: zStr, age: zInt, currentProfession: zStr, primaryObjective: zStr,
    tradingInvestmentExperience: zStr, customerLookingFor: zStr, campaignId: zId,
  };

  r.post("/api/leads", async (req, res) => {
    const b = parseBody(leadShape, req.body);
    validateNameAndPhone(b.fullName, b.phone);
    // Duplicate check and insert in one statement (Spring: check, then insert — racy). Any client
    // supplied "id" is ignored; Spring would have merged into (overwritten) that existing lead.
    // Approved rule change: a lead created by an AGENT is assigned to that agent (ACTIVE, no team) in
    // the same statement, so it appears in their own list. Admin/manager-created leads stay unassigned.
    const creatorAgent = req.user!.role === "AGENT" ? req.user!.id : null;
    const row = await one(db, sql`
      with ins as (
      insert into leads (full_name, email, phone, course_interested, lead_source, status, priority, city,
        education, interested_area, age, current_profession, primary_objective,
        trading_investment_experience, customer_looking_for, campaign_id)
      select ${b.fullName}, ${b.email}, ${b.phone}, ${b.courseInterested}, ${b.leadSource},
        ${b.status ?? "NEW"}, ${b.priority ?? "MEDIUM"}, ${b.city}, ${b.education}, ${b.interestedArea},
        ${b.age}::int, ${b.currentProfession}, ${b.primaryObjective}, ${b.tradingInvestmentExperience},
        ${b.customerLookingFor}, ${b.campaignId}::bigint
      where not exists (select 1 from leads where phone = ${b.phone})
      returning ${returningCols(leads)}
      ),
      own as (
        insert into lead_assignments (lead_id, agent_id, team_id, status)
        select ins.id, ${creatorAgent}::bigint, null, 'ACTIVE' from ins where ${creatorAgent}::bigint is not null
      )
      select * from ins`).catch((e) => {
      if (pgCode(e) === "23503") throw badRequest("Selected campaign does not exist");
      throw e;
    });
    if (!row) throw badRequest("A lead with this phone number already exists");
    res.json(mapRow(leads, row));
  });

  // ------------------------------------------------------------ update (ADMIN/MANAGER)
  r.put("/api/leads/:id", management, async (req, res) => {
    const id = pathId(req.params.id);
    const b = parseBody(leadShape, req.body);
    validateNameAndPhone(b.fullName, b.phone);
    // Approved: an omitted campaignId keeps the current link (the admin edit form never sends it, which
    // unlinked every edited lead); an explicit null still clears it.
    const campaign = Object.hasOwn(req.body, "campaignId") ? sql`${b.campaignId}::bigint` : sql`campaign_id`;
    const row = await one<Record<string, unknown> & { _dup: boolean; _found: boolean }>(db, sql`
      with chk as (
        select exists (select 1 from leads where phone = ${b.phone} and id <> ${id}) as dup,
               exists (select 1 from leads where id = ${id}) as found
      ),
      upd as (
        update leads set ${setAndStamp([
          ["full_name", sql`${b.fullName}::text`], ["email", sql`${b.email}::text`], ["phone", sql`${b.phone}::text`],
          ["course_interested", sql`${b.courseInterested}::text`], ["lead_source", sql`${b.leadSource}::text`],
          ["status", sql`coalesce(${b.status}::text, status)`], ["priority", sql`coalesce(${b.priority}::text, priority)`],
          ["city", sql`${b.city}::text`], ["campaign_id", campaign],
        ])}
        where id = ${id} and not (select dup from chk)
        returning ${returningCols(leads)}
      ),
      ${releaseIfClosing(b.status, sql`(select id from upd)`)}
      select upd.*, chk.dup as "_dup", chk.found as "_found" from chk left join upd on true`).catch((e) => {
      if (pgCode(e) === "23503") throw badRequest("Selected campaign does not exist");
      throw e;
    });
    if (row!._dup) throw badRequest("A lead with this phone number already exists");
    if (!row!._found) throw badRequest("Lead not found");
    res.json(mapRow(leads, row!));
  });

  // Body is a bare JSON string, e.g. "ENROLLED".
  r.put("/api/leads/:id/status", management, async (req, res) => {
    const id = pathId(req.params.id);
    const status = enumBody(req.body, LEAD_STATUSES, "Lead status");
    res.json(await updateLeadStatus(db, req.user!, id, status));
  });

  // Deletes the lead and its assignments, call logs, follow-ups and notes atomically.
  r.delete("/api/leads/:id", management, async (req, res) => {
    const id = pathId(req.params.id);
    const deleted = await rows(db, sql`
      with a as (delete from lead_assignments where lead_id = ${id}),
           c as (delete from call_logs where lead_id = ${id}),
           f as (delete from follow_ups where lead_id = ${id}),
           n as (delete from notes where lead_id = ${id})
      delete from leads where id = ${id} returning id`);
    if (deleted.length === 0) throw notFound("Lead not found");
    res.status(204).end();
  });

  // ------------------------------------------------------------ /api/agent (all roles)
  r.put("/api/agent/leads/:id/status", async (req, res) => {
    const id = pathId(req.params.id);
    const status = enumBody(req.body, LEAD_STATUSES, "Lead status");
    res.json(await updateLeadStatus(db, req.user!, id, status));
  });

  const detailsShape = {
    fullName: zStr, email: zStr, phone: zStr, age: zInt, city: zStr, education: zStr,
    currentProfession: zStr, primaryObjective: zStr, tradingInvestmentExperience: zStr,
    customerLookingFor: zStr, interestedArea: zStr, priority: zEnum(PRIORITIES), status: zEnum(LEAD_STATUSES),
  };

  // LeadService.updateLeadDetailsByAgent: agents only their actively assigned leads.
  r.put("/api/agent/leads/:id/details", async (req, res) => {
    const id = pathId(req.params.id);
    if (req.body == null || typeof req.body !== "object") throw badRequest("Lead details are required");
    const b = parseBody(detailsShape, req.body);
    const user = req.user!;
    const pre = await one<{ found: boolean; allowed: boolean; dup: boolean }>(db, sql`
      select exists (select 1 from leads where id = ${id}) as found,
        ${user.role === "AGENT" ? activelyAssignedTo(sql`${id}::bigint`, user.id) : sql`true`} as allowed,
        exists (select 1 from leads where phone = ${b.phone} and id <> ${id}) as dup`);
    if (!pre!.found) throw notFound("Lead not found");
    if (!pre!.allowed) throw forbidden("You are not allowed to update this lead");
    validateNameAndPhone(b.fullName, b.phone);
    if (pre!.dup) throw badRequest("A lead with this phone number already exists");
    if (b.age != null && (b.age < 1 || b.age > 120)) throw badRequest("Age must be between 1 and 120");
    const phone = javaTrim(b.phone!);
    const t = (v: string | null) => sql`${v}::text`;
    const row = await one(db, sql`
      with upd as (
        update leads set ${setAndStamp([
          ["full_name", t(javaTrim(b.fullName!))], ["email", t(cleanDetail(b.email))], ["phone", t(phone)],
          ["age", sql`${b.age}::int`], ["city", t(cleanDetail(b.city))], ["education", t(cleanDetail(b.education))],
          ["current_profession", t(cleanDetail(b.currentProfession))], ["primary_objective", t(cleanDetail(b.primaryObjective))],
          ["trading_investment_experience", t(cleanDetail(b.tradingInvestmentExperience))],
          ["customer_looking_for", t(cleanDetail(b.customerLookingFor))], ["interested_area", t(cleanDetail(b.interestedArea))],
          ["priority", sql`coalesce(${b.priority}::text, priority)`], ["status", sql`coalesce(${b.status}::text, status)`],
        ])}
        where id = ${id} and not exists (select 1 from leads where phone = ${phone} and id <> ${id})
        returning ${returningCols(leads)}
      ),
      ${releaseIfClosing(b.status, sql`(select id from upd)`)}
      select * from upd`);
    if (!row) throw badRequest("A lead with this phone number already exists");
    res.json(mapRow(leads, row));
  });

  // Fixed: any agent could list another agent's assignments.
  r.get("/api/agent/leads/:agentId", async (req, res) => {
    const agentId = pathId(req.params.agentId, "agentId");
    assertSelfOrManagement(req.user!, agentId);
    res.json(await activeAssignmentsOf(db, agentId));
  });

  // ------------------------------------------------------------ /api/lead-views (AGENT)
  // Records that the agent opened an actively assigned lead today (feeds attended/remaining).
  // viewed_date now uses the Asia/Kolkata date, the same "today" the dashboard counts with
  // (Spring wrote the UTC date, so views between 00:00 and 05:30 IST were not counted).
  r.post("/api/lead-views/:leadId", async (req, res) => {
    const leadId = pathId(req.params.leadId, "leadId");
    const user = req.user!;
    if (user.role !== "AGENT") throw forbidden("Only agents can record lead views");
    const r0 = await one<{ ok: boolean }>(db, sql`
      with ok as (select ${activelyAssignedTo(sql`${leadId}::bigint`, user.id)} as ok),
      ins as (
        insert into lead_view_activities (agent_id, lead_id, viewed_date)
        select ${user.id}, ${leadId}, ${istToday(clock)}::date from ok where ok.ok
        on conflict (agent_id, lead_id, viewed_date) do nothing
      )
      select ok from ok`);
    if (!r0?.ok) throw forbidden("This lead is not actively assigned to you");
    res.json({ success: true, message: "Lead view recorded", leadId });
  });

  void leadAssignments;
  return r;
}
