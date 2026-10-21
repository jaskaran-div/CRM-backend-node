import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/pool.js";
import { leadAssignments, leads } from "../db/schema.js";
import { mapRow, one, returningCols, rows, setAndStamp } from "../db/sqlutil.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { isClosedLead, type LeadStatus } from "../lib/enums.js";
import type { CurrentUser } from "../auth/middleware.js";

/** Java String#trim(): strips leading/trailing chars <= U+0020. */
export function javaTrim(s: string): string {
  return s.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
}
/** Trimmed value, or null when blank (LeadService.cleanLeadDetail). */
export function cleanDetail(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = javaTrim(s);
  return t === "" ? null : t;
}
export const isBlank = (s: string | null | undefined) => s == null || javaTrim(s) === "";

/** SQL predicate: lead `leadExpr` has an ACTIVE assignment owned by `agentId`. */
export const activelyAssignedTo = (leadExpr: ReturnType<typeof sql>, agentId: number) =>
  sql`exists (select 1 from lead_assignments la where la.lead_id = ${leadExpr} and la.status = 'ACTIVE' and la.agent_id = ${agentId})`;

/**
 * Validation reads used before assignment/call/follow-up writes, fetched in ONE round trip:
 * the lead (status), its active assignment owner, a candidate agent user and a candidate team.
 */
export interface Facts {
  leadExists: boolean;
  leadStatus: string | null;
  activeAssignmentId: number | null;
  activeAgentId: number | null;
  activeTeamId: number | null;
  agentExists: boolean;
  agentRole: string | null;
  agentStatus: string | null;
  teamExists: boolean;
  teamStatus: string | null;
}

export async function loadFacts(db: Db, leadId: number | null, agentId: number | null, teamId: number | null): Promise<Facts> {
  const r = await one<Facts>(db, sql`
    select
      exists (select 1 from leads where id = ${leadId}) as "leadExists",
      (select status from leads where id = ${leadId}) as "leadStatus",
      a.id as "activeAssignmentId", a.agent_id as "activeAgentId", a.team_id as "activeTeamId",
      exists (select 1 from users where id = ${agentId}) as "agentExists",
      (select role from users where id = ${agentId}) as "agentRole",
      (select status from users where id = ${agentId}) as "agentStatus",
      exists (select 1 from teams where id = ${teamId}) as "teamExists",
      (select status from teams where id = ${teamId}) as "teamStatus"
    from (select 1) dummy
    left join lateral (
      select id, agent_id, team_id from lead_assignments
      where lead_id = ${leadId} and status = 'ACTIVE' order by id desc limit 1
    ) a on true`);
  return r!;
}

/** Spring: agent must exist (404), be an AGENT (400) and ACTIVE (400). */
export function checkAgent(f: Facts, inactiveMsg = "Agent is inactive"): void {
  if (!f.agentExists) throw notFound("Agent not found");
  if (f.agentRole !== "AGENT") throw badRequest("Selected user is not an agent");
  if (f.agentStatus !== "ACTIVE") throw badRequest(inactiveMsg);
}

/** Spring: team (when given) must exist (404) and be ACTIVE (400). */
export function checkTeam(f: Facts, teamId: number | null): void {
  if (teamId == null) return;
  if (!f.teamExists) throw notFound("Team not found");
  if (f.teamStatus !== "ACTIVE") throw badRequest("Team is inactive");
}

export async function isLeadAssignedTo(db: Db, leadId: number | null, agentId: number): Promise<boolean> {
  if (leadId == null) return false;
  const r = await one<{ ok: boolean }>(db, sql`select ${activelyAssignedTo(sql`${leadId}`, agentId)} as ok`);
  return r?.ok === true;
}

/**
 * CTE "rel": when `status` is a closing status (ENROLLED, NOT_INTERESTED, LOST, WRONG_NUMBER),
 * deactivate the lead's ACTIVE assignment. Shared by every path that can close a lead (status
 * endpoints, admin edit form, agent details form, call outcomes) so they follow one rule.
 */
export function releaseIfClosing(status: string | null | undefined, leadIdExpr: SQL): SQL {
  if (!isClosedLead(status)) return sql`rel as (select 1)`;
  return sql`rel as (update lead_assignments set status = 'INACTIVE' where lead_id = ${leadIdExpr} and status = 'ACTIVE')`;
}

/**
 * LeadService.updateLeadStatus as one atomic statement: set the status and, for a closing status
 * (ENROLLED, NOT_INTERESTED, LOST, WRONG_NUMBER), deactivate the active assignment.
 * Agents may only change leads actively assigned to them.
 */
export async function updateLeadStatus(db: Db, user: CurrentUser, leadId: number, status: LeadStatus) {
  const agentOnly = user.role === "AGENT";
  const closing = isClosedLead(status);
  const r = await one<Record<string, unknown> & { _found: boolean; _allowed: boolean }>(db, sql`
    with target as (
      select l.id, ${agentOnly ? activelyAssignedTo(sql`l.id`, user.id) : sql`true`} as allowed
      from leads l where l.id = ${leadId}
    ),
    upd as (
      update leads set ${setAndStamp([["status", sql`${status}::text`]])}
      where id = (select id from target where allowed)
      returning ${returningCols(leads)}
    ),
    deact as (
      update lead_assignments set status = 'INACTIVE'
      where ${closing} and lead_id = (select id from target where allowed) and status = 'ACTIVE'
      returning id
    )
    select upd.*, exists (select 1 from target) as "_found", coalesce((select allowed from target), false) as "_allowed"
    from (select 1) dummy left join upd on true`);
  if (!r?._found) throw notFound("Lead not found");
  if (!r._allowed) throw forbidden("You are not allowed to update the status of this lead");
  return mapRow(leads, r);
}

export async function activeAssignmentsOf(db: Db, agentId: number) {
  return (await rows(db, sql`select ${returningCols(leadAssignments)} from lead_assignments
      where agent_id = ${agentId} and status = 'ACTIVE' order by id`)).map((r) => mapRow(leadAssignments, r));
}

/** Agents may only act on their own agentId; ADMIN may act for any agent. */
export function assertSelfOrAdmin(user: CurrentUser, agentId: number): void {
  if (user.role !== "ADMIN" && user.id !== agentId) throw forbidden("You can only access your own attendance");
}
/** Reads: agents only their own data; ADMIN/MANAGER any agent. */
export function assertSelfOrManagement(user: CurrentUser, agentId: number): void {
  if (user.role === "AGENT" && user.id !== agentId) throw forbidden("You can only access your own records");
}
