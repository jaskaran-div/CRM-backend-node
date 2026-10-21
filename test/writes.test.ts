import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { auth, createTestEnv, PASSWORD, resetAndSeed, type TestEnv } from "./helpers.js";

// Every write endpoint against the disposable test database. The inventory test at the bottom
// fails if the app gains a write route that is not listed here.
const covered = new Set<string>();
const mark = (m: string, p: string) => covered.add(`${m} ${p}`);

let env: TestEnv;
let A: string, M: string, G1: string;
beforeAll(async () => {
  env = await createTestEnv();
});
beforeEach(async () => {
  env.seed = await resetAndSeed(env.pool);
  env.clock.setIst("2026-10-17T10:00:00");
  A = env.token(env.seed.admin);
  M = env.token(env.seed.manager);
  G1 = env.token(env.seed.agent1);
});
afterAll(() => env?.close());
const q = async (sql: string, p: unknown[] = []) => (await env.pool.query(sql, p)).rows;

describe("users", () => {
  it("POST validates, hashes and creates", async () => {
    mark("POST", "/api/users");
    const post = (b: object) => env.request.post("/api/users").set(auth(A)).send(b);
    const base = { fullName: "New Agent", email: "new@crm.test", password: "Abcdefg1", role: "AGENT" };
    expect((await post({ ...base, email: "bad" })).body).toEqual({ error: "User email format is invalid" });
    expect((await post({ ...base, email: "admin@crm.test" })).body).toEqual({ error: "User email already exists" });
    expect((await post({ ...base, password: "short1" })).body).toEqual({ error: "User password must be at least 8 characters" });
    expect((await post({ ...base, password: "abcdefgh" })).body).toEqual({ error: "User password must contain at least one letter and one number" });
    expect((await post({ ...base, phone: "123" })).body).toEqual({ error: "User phone number must contain exactly 10 digits" });
    const ok = await post(base);
    expect(ok.body).toMatchObject({ fullName: "New Agent", role: "AGENT", status: "ACTIVE" });
    expect(ok.body).not.toHaveProperty("password");
    const [{ password }] = await q("select password from users where email = 'new@crm.test'");
    expect(password).toMatch(/^\$2a\$10\$/);
    expect((await env.request.post("/api/auth/login").send({ email: "new@crm.test", password: "Abcdefg1" })).status).toBe(200);
  });

  it("PUT updates, changes password, keeps status when null", async () => {
    mark("PUT", "/api/users/:id");
    const res = await env.request.put(`/api/users/${env.seed.agent2}`).set(auth(A))
      .send({ fullName: "Agent 2b", email: "agent2@crm.test", role: "AGENT", status: null, password: "Newpass99" });
    expect(res.body).toMatchObject({ fullName: "Agent 2b", status: "ACTIVE" });
    expect((await env.request.post("/api/auth/login").send({ email: "agent2@crm.test", password: "Newpass99" })).status).toBe(200);
    expect((await env.request.put("/api/users/999").set(auth(A)).send({ fullName: "x", email: "x@y.z" })).body).toEqual({ error: "User not found" });
  });

  it("DELETE refuses self and users with history, deletes others", async () => {
    mark("DELETE", "/api/users/:id");
    expect((await env.request.delete(`/api/users/${env.seed.admin}`).set(auth(A))).body).toEqual({ error: "You cannot delete your own account" });
    expect((await env.request.delete(`/api/users/${env.seed.agent1}`).set(auth(A))).body)
      .toEqual({ error: "Cannot delete user because related records exist. Deactivate the user instead." });
    expect((await env.request.delete(`/api/users/${env.seed.inactiveAgent}`).set(auth(A))).status).toBe(204);
  });
});

describe("teams, courses, campaigns", () => {
  it("teams POST/PUT/DELETE", async () => {
    mark("POST", "/api/teams"); mark("PUT", "/api/teams/:id"); mark("DELETE", "/api/teams/:id");
    expect((await env.request.post("/api/teams").set(auth(M)).send({ teamName: " " })).body).toEqual({ error: "Team name is required" });
    const t = await env.request.post("/api/teams").set(auth(M)).send({ teamName: "Beta" });
    expect(t.body).toMatchObject({ teamName: "Beta", status: "ACTIVE" });
    expect((await env.request.put(`/api/teams/${t.body.id}`).set(auth(M)).send({ teamName: "Beta2", status: "INACTIVE" })).body.status).toBe("INACTIVE");
    expect((await env.request.delete(`/api/teams/${t.body.id}`).set(auth(M))).status).toBe(204);
    expect((await env.request.delete(`/api/teams/${t.body.id}`).set(auth(M))).body).toEqual({ error: "Team not found" });
  });

  it("courses POST/PUT/DELETE incl. duplicate name and 409 when used", async () => {
    mark("POST", "/api/courses"); mark("PUT", "/api/courses/:id"); mark("DELETE", "/api/courses/:id");
    expect((await env.request.post("/api/courses").set(auth(M)).send({ courseName: "C", durationMonths: 0 })).body)
      .toEqual({ error: "Course duration must be greater than 0 months" });
    const c = await env.request.post("/api/courses").set(auth(M)).send({ courseName: "Trading", durationMonths: 6 });
    expect((await env.request.post("/api/courses").set(auth(M)).send({ courseName: "Trading", durationMonths: 6 })).body)
      .toEqual({ error: "A course with this name already exists" });
    expect((await env.request.put(`/api/courses/${c.body.id}`).set(auth(M)).send({ courseName: "Trading 2", durationMonths: 3 })).body)
      .toMatchObject({ courseName: "Trading 2", durationMonths: 3, status: "ACTIVE" });
    await q("insert into campaigns (campaign_name, course_id) values ('X', $1)", [c.body.id]);
    const del = await env.request.delete(`/api/courses/${c.body.id}`).set(auth(M));
    expect(del.status).toBe(409);
    expect(del.body).toEqual({ message: "Cannot delete course because it is used by 1 campaign(s)." });
  });

  it("campaigns POST/PUT/DELETE (delete unlinks leads)", async () => {
    mark("POST", "/api/campaigns"); mark("PUT", "/api/campaigns/:id"); mark("DELETE", "/api/campaigns/:id");
    expect((await env.request.post("/api/campaigns").set(auth(M)).send({ campaignName: "X", startDate: "2026-10-10", endDate: "2026-10-01" })).body)
      .toEqual({ error: "Campaign end date cannot be before start date" });
    expect((await env.request.post("/api/campaigns").set(auth(M)).send({ campaignName: "X", courseId: 999 })).body)
      .toEqual({ error: "Selected course does not exist" });
    const c = await env.request.post("/api/campaigns").set(auth(M)).send({ campaignName: "Diwali", startDate: "2026-10-01" });
    expect(c.body).toMatchObject({ status: "DRAFT", startDate: "2026-10-01" });
    expect((await env.request.put(`/api/campaigns/${c.body.id}`).set(auth(M)).send({ campaignName: "Diwali 2", status: "ACTIVE" })).body.status).toBe("ACTIVE");
    await q("update leads set campaign_id = $1 where id = $2", [c.body.id, env.seed.leadA]);
    const del = await env.request.delete(`/api/campaigns/${c.body.id}`).set(auth(M));
    expect([del.status, del.text]).toEqual([200, ""]);
    expect(await q("select campaign_id from leads where id = $1", [env.seed.leadA])).toEqual([{ campaign_id: null }]);
  });
});

describe("leads (management writes)", () => {
  it("PUT /api/leads/:id validates duplicates and existence; null status keeps value", async () => {
    mark("PUT", "/api/leads/:id");
    const put = (id: number, b: object) => env.request.put(`/api/leads/${id}`).set(auth(M)).send(b);
    expect((await put(env.seed.leadA, { fullName: "A", phone: "9000000002" })).body).toEqual({ error: "A lead with this phone number already exists" });
    expect((await put(999, { fullName: "A", phone: "9111111111" })).body).toEqual({ error: "Lead not found" });
    const ok = await put(env.seed.leadA, { fullName: "A2", phone: "9000000001", city: "Delhi", status: null });
    expect(ok.body).toMatchObject({ fullName: "A2", city: "Delhi", status: "NEW" });
  });

  it("PUT /api/leads/:id/status takes a bare JSON string", async () => {
    mark("PUT", "/api/leads/:id/status");
    const res = await env.request.put(`/api/leads/${env.seed.leadA}/status`).set({ ...auth(M), "Content-Type": "application/json" }).send('"LOST"');
    expect(res.body.status).toBe("LOST");
    expect((await env.request.put(`/api/leads/${env.seed.leadA}/status`).set({ ...auth(M), "Content-Type": "application/json" }).send('"NOPE"')).status).toBe(400);
  });

  it("covered elsewhere: create, delete, agent status/details, lead views", () => {
    for (const r of ["POST /api/leads", "DELETE /api/leads/:id", "PUT /api/agent/leads/:id/status", "PUT /api/agent/leads/:id/details", "POST /api/lead-views/:leadId"]) covered.add(r);
  });
});

describe("assignments", () => {
  it("PUT status enforces the single-active rule; DELETE removes", async () => {
    mark("PUT", "/api/lead-assignments/:id/status"); mark("DELETE", "/api/lead-assignments/:id");
    const [old] = await q("select id from lead_assignments where lead_id = $1 and status = 'INACTIVE'", [env.seed.closedLead]);
    expect((await env.request.put(`/api/lead-assignments/${old.id}/status?status=ACTIVE`).set(auth(M))).body)
      .toEqual({ error: "Closed lead cannot have an active assignment. Reopen the lead first." });
    await q("insert into lead_assignments (lead_id, agent_id, status) values ($1, $2, 'INACTIVE')", [env.seed.leadA, env.seed.agent2]);
    const [second] = await q("select id from lead_assignments where lead_id = $1 and status = 'INACTIVE'", [env.seed.leadA]);
    expect((await env.request.put(`/api/lead-assignments/${second.id}/status?status=ACTIVE`).set(auth(M))).body)
      .toEqual({ error: "Lead already has another active assignment" });
    expect((await env.request.put(`/api/lead-assignments/${second.id}/status?status=INACTIVE`).set(auth(M))).body.status).toBe("INACTIVE");
    expect((await env.request.put("/api/lead-assignments/999/status?status=INACTIVE").set(auth(M))).body).toEqual({ error: "Assignment not found" });
    expect((await env.request.delete(`/api/lead-assignments/${second.id}`).set(auth(M))).status).toBe(204);
    expect((await env.request.delete(`/api/lead-assignments/${second.id}`).set(auth(M))).body).toEqual({ error: "Assignment not found" });
  });
  it("covered elsewhere: create, bulk, reassign, reopen", () => {
    for (const r of ["POST /api/lead-assignments", "POST /api/lead-assignments/bulk", "PUT /api/lead-assignments/:leadId/reassign", "PUT /api/lead-assignments/:leadId/reopen"]) covered.add(r);
  });
});

describe("call logs, follow-ups, notes, notifications", () => {
  it("call log PUT re-applies side effects; agent cannot move it to another agent's lead; DELETE", async () => {
    mark("PUT", "/api/call-logs/:id"); mark("DELETE", "/api/call-logs/:id"); covered.add("POST /api/call-logs");
    const c = await env.request.post("/api/call-logs").set(auth(G1)).send({ leadId: env.seed.leadA, callStartTime: "2026-10-17T09:00" });
    const upd = await env.request.put(`/api/call-logs/${c.body.id}`).set(auth(G1))
      .send({ leadId: env.seed.leadA, callStartTime: "2026-10-17T09:05", callOutcome: "INTERESTED", interestedArea: " Options " });
    expect(upd.body).toMatchObject({ callStartTime: "2026-10-17T09:05:00", callOutcome: "INTERESTED" });
    expect(await q("select status, interested_area from leads where id = $1", [env.seed.leadA])).toEqual([{ status: "INTERESTED", interested_area: "Options" }]);
    expect((await env.request.put(`/api/call-logs/${c.body.id}`).set(auth(G1)).send({ leadId: env.seed.leadC, callStartTime: "2026-10-17T09:05" })).body)
      .toEqual({ error: "You are not allowed to move this call log to this lead" });
    expect((await env.request.delete(`/api/call-logs/${c.body.id}`).set(auth(G1))).status).toBe(204);
  });

  it("follow-up PUT / PUT status / DELETE with agent ownership", async () => {
    mark("PUT", "/api/follow-ups/:id"); mark("PUT", "/api/follow-ups/:id/status"); mark("DELETE", "/api/follow-ups/:id"); covered.add("POST /api/follow-ups");
    const f = await env.request.post("/api/follow-ups").set(auth(G1)).send({ leadId: env.seed.leadA, followUpDate: "2026-10-18T11:00" });
    const upd = await env.request.put(`/api/follow-ups/${f.body.id}`).set(auth(G1))
      .send({ leadId: env.seed.leadB, followUpDate: "2026-10-19T11:00", purpose: "Call", status: null });
    expect(upd.body).toMatchObject({ leadId: env.seed.leadB, followUpDate: "2026-10-19T11:00:00", status: "PENDING", agentId: env.seed.agent1 });
    const G2 = env.token(env.seed.agent2);
    expect((await env.request.put(`/api/follow-ups/${f.body.id}/status?status=COMPLETED`).set(auth(G2))).body)
      .toEqual({ error: "You are not allowed to update this follow-up" });
    expect((await env.request.put(`/api/follow-ups/${f.body.id}/status?status=COMPLETED`).set(auth(G1))).body.status).toBe("COMPLETED");
    expect((await env.request.delete(`/api/follow-ups/${f.body.id}`).set(auth(G2))).status).toBe(403);
    expect((await env.request.delete(`/api/follow-ups/${f.body.id}`).set(auth(G1))).status).toBe(204);
  });

  it("note PUT / DELETE", async () => {
    mark("PUT", "/api/notes/:id"); mark("DELETE", "/api/notes/:id"); covered.add("POST /api/notes");
    const n = await env.request.post("/api/notes").set(auth(A)).send({ leadId: env.seed.leadA, userId: env.seed.admin, note: "a" });
    expect((await env.request.post("/api/notes").set(auth(A)).send({ leadId: env.seed.leadA, userId: env.seed.inactiveAgent, note: "a" })).body)
      .toEqual({ error: "User is inactive" });
    expect((await env.request.put(`/api/notes/${n.body.id}`).set(auth(G1)).send({ leadId: env.seed.leadA, note: "b" })).body)
      .toMatchObject({ note: "b", userId: env.seed.agent1 });
    expect((await env.request.delete(`/api/notes/${n.body.id}`).set(auth(env.token(env.seed.agent2)))).status).toBe(403);
    expect((await env.request.delete(`/api/notes/${n.body.id}`).set(auth(A))).status).toBe(204);
  });

  it("notifications read-all only touches the caller's rows", async () => {
    mark("PUT", "/api/notifications/read-all"); covered.add("PUT /api/notifications/:id/read");
    await q("insert into notifications (user_id, type, title, message) values ($1,'T','t','m'),($1,'T','t','m'),($2,'T','t','m')", [env.seed.agent1, env.seed.agent2]);
    expect((await env.request.put("/api/notifications/read-all").set(auth(G1))).status).toBe(204);
    expect(await q("select user_id, bool_and(is_read) r from notifications group by 1 order by 1")).toEqual([
      { user_id: env.seed.agent1, r: true }, { user_id: env.seed.agent2, r: false },
    ]);
  });
});

describe("attendance writes", () => {
  it("POST /api/attendance/login and /logout", async () => {
    mark("POST", "/api/attendance/login"); mark("POST", "/api/attendance/logout");
    const login = await env.request.post(`/api/attendance/login?agentId=${env.seed.agent1}`).set(auth(G1));
    expect(login.body).toMatchObject({ agentId: env.seed.agent1, attendanceDate: "2026-10-17", loginTime: "2026-10-17T10:00:00", logoutTime: null });
    env.clock.advance(60);
    expect((await env.request.post(`/api/attendance/logout?agentId=${env.seed.agent1}`).set(auth(G1))).body.logoutTime).toBe("2026-10-17T10:01:00");
    expect((await env.request.post(`/api/attendance/logout?agentId=${env.seed.agent1}`).set(auth(G1))).body).toEqual({ error: "No active attendance session found." });
  });
  it("break end without an active break -> 409 {message}", async () => {
    mark("POST", "/api/attendance/break/end");
    const res = await env.request.post("/api/attendance/break/end").set(auth(G1)).send({ agentId: env.seed.agent1 });
    expect([res.status, res.body]).toEqual([409, { message: "No active break found." }]);
  });
  it("covered elsewhere: break start, admin delete, auth login/logout", () => {
    for (const r of ["POST /api/attendance/break/start", "DELETE /api/admin/attendance/:attendanceId", "POST /api/auth/login", "POST /api/auth/logout/:agentId"]) covered.add(r);
  });
});

describe("write-route inventory", () => {
  it("every POST/PUT/DELETE route registered by the app is covered", () => {
    const app = createApp(env.ctx) as unknown as { router: { stack: Layer[] } };
    interface Layer { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: Layer[] } }
    const routes = new Set<string>();
    const walk = (stack: Layer[]) => {
      for (const l of stack) {
        if (l.route) for (const m of Object.keys(l.route.methods)) if (m !== "get") routes.add(`${m.toUpperCase()} ${l.route.path}`);
        if (l.handle?.stack) walk(l.handle.stack);
      }
    };
    walk(app.router.stack);
    expect(routes.size).toBeGreaterThan(40);
    expect([...routes].filter((r) => !covered.has(r)).sort()).toEqual([]);
  });
});

void PASSWORD;
