import { Router } from "express";
import { asc, eq, sql } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { requireRoles } from "../auth/middleware.js";
import { hashPassword } from "../auth/password.js";
import { campaigns, courses, teams, users, type User } from "../db/schema.js";
import { one, rows } from "../db/sqlutil.js";
import { badRequest, conflict } from "../lib/errors.js";
import { CAMPAIGN_STATUSES, COURSE_STATUSES, ROLES, TEAM_STATUSES, USER_STATUSES } from "../lib/enums.js";
import { parseBody, pathId, zEnum, zId, zInt, zLocalDate, zStr } from "../lib/validate.js";
import { isBlank } from "./shared.js";

const management = requireRoles("ADMIN", "MANAGER");
const adminOnly = requireRoles("ADMIN");

/** User JSON as Spring rendered it (password is write-only). */
const userJson = (u: User) => ({ id: u.id, fullName: u.fullName, email: u.email, phone: u.phone, role: u.role, status: u.status });
/** Agents only need names for the transfer popup and name lookups — no email/phone of colleagues. */
const userJsonForAgent = (u: User) => ({ id: u.id, fullName: u.fullName, role: u.role, status: u.status });

const EMAIL_RE = /^[A-Za-z0-9+_.-]+@[A-Za-z0-9.-]+$/;

/** Map FK violations (23503) on delete to a clear 400 instead of Spring's leaked SQL message. */
async function guardFk<T>(p: Promise<T>, message: string): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if ((e as { code?: string }).code === "23503") throw badRequest(message);
    throw e;
  }
}

export function catalogRoutes(ctx: AppContext): Router {
  const r = Router();
  const { db } = ctx;

  // =================================================================== USERS
  // GET: all roles (agents receive a reduced projection). Writes: ADMIN.
  r.get("/api/users", async (req, res) => {
    const list = await db.select().from(users).orderBy(asc(users.id));
    res.json(list.map(req.user!.role === "AGENT" ? userJsonForAgent : userJson));
  });

  r.get("/api/users/:id", async (req, res) => {
    const [u] = await db.select().from(users).where(eq(users.id, pathId(req.params.id))).limit(1);
    if (!u) return void res.status(404).end();
    res.json(req.user!.role === "AGENT" ? userJsonForAgent(u) : userJson(u));
  });

  const userShape = { fullName: zStr, email: zStr, phone: zStr, password: zStr, role: zEnum(ROLES), status: zEnum(USER_STATUSES) };

  function validatePassword(p: string): void {
    if (p.length < 8) throw badRequest("User password must be at least 8 characters");
    if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) throw badRequest("User password must contain at least one letter and one number");
  }
  function validateCommon(b: { fullName: string | null; email: string | null; phone: string | null }): void {
    if (isBlank(b.fullName)) throw badRequest("User full name is required");
    if (isBlank(b.email)) throw badRequest("User email is required");
    if (!EMAIL_RE.test(b.email!)) throw badRequest("User email format is invalid");
  }
  function validatePhone(phone: string | null): void {
    if (!isBlank(phone) && !/^\d{10}$/.test(phone!)) throw badRequest("User phone number must contain exactly 10 digits");
  }

  r.post("/api/users", adminOnly, async (req, res) => {
    const b = parseBody(userShape, req.body);
    validateCommon(b);
    const [dup] = await db.select({ id: users.id }).from(users).where(eq(users.email, b.email!)).limit(1);
    if (dup) throw badRequest("User email already exists");
    if (isBlank(b.password)) throw badRequest("User password is required");
    validatePassword(b.password!);
    validatePhone(b.phone);
    if (b.role == null) throw badRequest("User role is required");
    const hash = await hashPassword(b.password!, ctx.config.BCRYPT_COST);
    try {
      const [u] = await db.insert(users).values({
        fullName: b.fullName!, email: b.email!, phone: b.phone, password: hash, role: b.role, status: b.status ?? "ACTIVE",
      }).returning();
      ctx.userCache.invalidateAll();
      res.json(userJson(u!));
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw badRequest("User email already exists");
      throw e;
    }
  });

  r.put("/api/users/:id", adminOnly, async (req, res) => {
    const id = pathId(req.params.id);
    const b = parseBody(userShape, req.body);
    const [existing] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!existing) throw badRequest("User not found");
    validateCommon(b);
    const [same] = await db.select({ id: users.id }).from(users).where(eq(users.email, b.email!)).limit(1);
    if (same && same.id !== id) throw badRequest("User email already exists");
    validatePhone(b.phone);
    let password = existing.password;
    if (!isBlank(b.password)) {
      validatePassword(b.password!);
      password = await hashPassword(b.password!, ctx.config.BCRYPT_COST);
    }
    // Spring wrote whatever role/status was sent, including null (role null -> SQL error, status
    // null -> account silently unable to log in). Null now keeps the current value.
    const [u] = await db.update(users).set({
      fullName: b.fullName!, email: b.email!, phone: b.phone, role: b.role ?? existing.role,
      status: b.status ?? existing.status, password,
    }).where(eq(users.id, id)).returning();
    ctx.userCache.invalidateAll();
    res.json(userJson(u!));
  });

  r.delete("/api/users/:id", adminOnly, async (req, res) => {
    const id = pathId(req.params.id);
    if (req.user!.id === id) throw badRequest("You cannot delete your own account");
    const deleted = await guardFk(db.delete(users).where(eq(users.id, id)).returning({ id: users.id }),
      "Cannot delete user because related records exist. Deactivate the user instead.");
    if (deleted.length === 0) throw badRequest("User not found");
    ctx.userCache.invalidateAll();
    res.status(204).end();
  });

  // =================================================================== TEAMS
  // GET list/one: all roles (agents use it in the transfer popup). Members + writes: ADMIN/MANAGER.
  r.get("/api/teams", async (_req, res) => {
    res.json(await db.select().from(teams).orderBy(asc(teams.id)));
  });

  r.get("/api/teams/:id", async (req, res) => {
    const [t] = await db.select().from(teams).where(eq(teams.id, pathId(req.params.id))).limit(1);
    if (!t) throw badRequest("Team not found");
    res.json(t);
  });

  // Members = agents with assignments in this team, with distinct ACTIVE lead counts. One query
  // (Spring: one user lookup per agent). Restricted to ADMIN/MANAGER: it exposes emails/phones.
  r.get("/api/teams/:id/members", management, async (req, res) => {
    const id = pathId(req.params.id);
    const r0 = await one<{ exists: boolean; members: unknown[] }>(db, sql`
      select exists (select 1 from teams where id = ${id}) as exists,
        coalesce((
          select jsonb_agg(jsonb_build_object(
              'id', u.id, 'fullName', u.full_name, 'email', u.email, 'phone', u.phone,
              'role', u.role, 'status', u.status, 'activeLeadCount', g.active_leads) order by g.first_id)
          from (
            select agent_id, min(id) first_id,
              count(distinct lead_id) filter (where status = 'ACTIVE') active_leads
            from lead_assignments where team_id = ${id} group by agent_id
          ) g join users u on u.id = g.agent_id
        ), '[]'::jsonb) as members`);
    if (!r0?.exists) throw badRequest("Team not found");
    res.json(r0.members);
  });

  const teamShape = { teamName: zStr, description: zStr, status: zEnum(TEAM_STATUSES) };

  r.post("/api/teams", management, async (req, res) => {
    const b = parseBody(teamShape, req.body);
    if (isBlank(b.teamName)) throw badRequest("Team name is required");
    const [t] = await db.insert(teams).values({ teamName: b.teamName!, description: b.description, status: b.status ?? "ACTIVE" }).returning();
    res.json(t);
  });

  r.put("/api/teams/:id", management, async (req, res) => {
    const id = pathId(req.params.id);
    const b = parseBody(teamShape, req.body);
    if (isBlank(b.teamName)) throw badRequest("Team name is required");
    const [t] = await db.update(teams).set({
      teamName: b.teamName!, description: b.description,
      ...(b.status != null ? { status: b.status } : {}),
    }).where(eq(teams.id, id)).returning();
    if (!t) throw badRequest("Team not found");
    res.json(t);
  });

  r.delete("/api/teams/:id", management, async (req, res) => {
    const id = pathId(req.params.id);
    const r0 = await one<{ exists: boolean; used: boolean; deleted: boolean }>(db, sql`
      with info as (
        select exists (select 1 from teams where id = ${id}) as exists,
               exists (select 1 from lead_assignments where team_id = ${id}) as used
      ),
      del as (delete from teams where id = ${id} and not (select used from info) returning id)
      select info.exists, info.used, exists (select 1 from del) as deleted from info`);
    if (!r0?.exists) throw badRequest("Team not found");
    if (r0.used) throw conflict("Cannot delete team because it is used by lead assignments.", "message");
    res.status(204).end();
  });

  // =================================================================== COURSES
  // GET: all roles. Writes: ADMIN/MANAGER.
  r.get("/api/courses", async (_req, res) => {
    res.json(await db.select().from(courses).orderBy(asc(courses.id)));
  });

  r.get("/api/courses/:id", async (req, res) => {
    const [c] = await db.select().from(courses).where(eq(courses.id, pathId(req.params.id))).limit(1);
    if (!c) throw badRequest("Course not found");
    res.json(c);
  });

  const courseShape = { courseName: zStr, description: zStr, durationMonths: zInt, status: zEnum(COURSE_STATUSES) };
  function validateCourse(b: { courseName: string | null; durationMonths: number | null }): void {
    if (isBlank(b.courseName)) throw badRequest("Course name is required");
    if (b.durationMonths == null || b.durationMonths <= 0) throw badRequest("Course duration must be greater than 0 months");
  }
  const uniqueCourse = async <T>(p: Promise<T>) => {
    try {
      return await p;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw badRequest("A course with this name already exists");
      throw e;
    }
  };

  r.post("/api/courses", management, async (req, res) => {
    const b = parseBody(courseShape, req.body);
    validateCourse(b);
    const [c] = await uniqueCourse(db.insert(courses).values({
      courseName: b.courseName!, description: b.description, durationMonths: b.durationMonths, status: b.status ?? "ACTIVE",
    }).returning());
    res.json(c);
  });

  r.put("/api/courses/:id", management, async (req, res) => {
    const id = pathId(req.params.id);
    const b = parseBody(courseShape, req.body);
    validateCourse(b);
    const [c] = await uniqueCourse(db.update(courses).set({
      courseName: b.courseName!, description: b.description, durationMonths: b.durationMonths,
      ...(b.status != null ? { status: b.status } : {}),
    }).where(eq(courses.id, id)).returning());
    if (!c) throw badRequest("Course not found");
    res.json(c);
  });

  r.delete("/api/courses/:id", management, async (req, res) => {
    const id = pathId(req.params.id);
    const r0 = await one<{ exists: boolean; used: number }>(db, sql`
      with info as (
        select exists (select 1 from courses where id = ${id}) as exists,
               (select count(*) from campaigns where course_id = ${id}) as used
      ),
      del as (delete from courses where id = ${id} and (select used from info) = 0 returning id)
      select info.exists, info.used from info, (select count(*) from del) d`);
    if (!r0?.exists) throw badRequest("Course not found");
    if (r0.used > 0) throw conflict(`Cannot delete course because it is used by ${r0.used} campaign(s).`, "message");
    res.status(204).end();
  });

  // =================================================================== CAMPAIGNS (ADMIN/MANAGER)
  r.get("/api/campaigns", management, async (_req, res) => {
    res.json(await db.select().from(campaigns).orderBy(asc(campaigns.id)));
  });

  r.get("/api/campaigns/:id", management, async (req, res) => {
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, pathId(req.params.id))).limit(1);
    if (!c) throw badRequest("Campaign not found");
    res.json(c);
  });

  const campaignShape = {
    campaignName: zStr, description: zStr, source: zStr, courseId: zId,
    startDate: zLocalDate, endDate: zLocalDate, status: zEnum(CAMPAIGN_STATUSES),
  };
  function validateCampaign(b: { campaignName: string | null; startDate: string | null; endDate: string | null }): void {
    if (isBlank(b.campaignName)) throw badRequest("Campaign name is required");
    if (b.startDate && b.endDate && b.endDate < b.startDate) throw badRequest("Campaign end date cannot be before start date");
  }
  const courseFk = <T>(p: Promise<T>) => guardFk(p, "Selected course does not exist");

  r.post("/api/campaigns", management, async (req, res) => {
    const b = parseBody(campaignShape, req.body);
    validateCampaign(b);
    const [c] = await courseFk(db.insert(campaigns).values({
      campaignName: b.campaignName!, description: b.description, source: b.source, courseId: b.courseId,
      startDate: b.startDate, endDate: b.endDate, status: b.status ?? "DRAFT",
    }).returning());
    res.json(c);
  });

  r.put("/api/campaigns/:id", management, async (req, res) => {
    const id = pathId(req.params.id);
    const b = parseBody(campaignShape, req.body);
    validateCampaign(b);
    const [c] = await courseFk(db.update(campaigns).set({
      campaignName: b.campaignName!, description: b.description, source: b.source, courseId: b.courseId,
      startDate: b.startDate, endDate: b.endDate, ...(b.status != null ? { status: b.status } : {}),
    }).where(eq(campaigns.id, id)).returning());
    if (!c) throw badRequest("Campaign not found");
    res.json(c);
  });

  // Unlinks leads from the campaign, then deletes it — one atomic statement.
  r.delete("/api/campaigns/:id", management, async (req, res) => {
    const id = pathId(req.params.id);
    const deleted = await rows(db, sql`
      with unlink as (update leads set campaign_id = null where campaign_id = ${id} returning id)
      delete from campaigns where id = ${id} returning id`);
    if (deleted.length === 0) throw badRequest("Campaign not found");
    // Spring's void handler: 200 with an empty body.
    res.status(200).end();
  });

  return r;
}
