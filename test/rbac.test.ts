import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createTestEnv, resetAndSeed, type TestEnv } from "./helpers.js";

// Role matrix for every endpoint. "allowed" means the role passes authorization (any status other
// than 401/403); otherwise 403 is expected. Anonymous requests must always get 401 (Spring: 403).
// Rows marked FIXED differ from Spring, which allowed AGENT (or anyone) through.
type Role = "ADMIN" | "MANAGER" | "AGENT";
const ALL: Role[] = ["ADMIN", "MANAGER", "AGENT"];
const MGMT: Role[] = ["ADMIN", "MANAGER"];
const ADMIN: Role[] = ["ADMIN"];

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
beforeEach(async () => {
  env.seed = await resetAndSeed(env.pool);
});
afterAll(() => env?.close());

interface Case {
  method: "get" | "post" | "put" | "delete";
  path: (s: TestEnv["seed"]) => string;
  body?: (s: TestEnv["seed"]) => unknown;
  allowed: Role[];
  note?: string;
}

const C = (method: Case["method"], path: Case["path"], allowed: Role[], body?: Case["body"], note?: string): Case => ({ method, path, allowed, body, note });

const cases: Case[] = [
  // users
  C("get", () => "/api/users", ALL),
  C("get", (s) => `/api/users/${s.admin}`, ALL),
  C("post", () => "/api/users", ADMIN, () => ({ fullName: "New", email: "new@crm.test", password: "Abcdefg1", role: "AGENT" })),
  C("put", (s) => `/api/users/${s.agent2}`, ADMIN, () => ({ fullName: "X", email: "agent2@crm.test", role: "AGENT", status: "ACTIVE" })),
  C("delete", (s) => `/api/users/${s.inactiveAgent}`, ADMIN),
  // teams
  C("get", () => "/api/teams", ALL),
  C("get", (s) => `/api/teams/${s.team}`, ALL),
  C("get", (s) => `/api/teams/${s.team}/members`, MGMT, undefined, "FIXED: exposed emails/phones to agents"),
  C("post", () => "/api/teams", MGMT, () => ({ teamName: "T" })),
  C("put", (s) => `/api/teams/${s.team}`, MGMT, () => ({ teamName: "T2", status: "ACTIVE" })),
  C("delete", (s) => `/api/teams/${s.inactiveTeam}`, MGMT),
  // courses
  C("get", () => "/api/courses", ALL),
  C("post", () => "/api/courses", MGMT, () => ({ courseName: "C1", durationMonths: 3 })),
  // campaigns
  C("get", () => "/api/campaigns", MGMT),
  C("post", () => "/api/campaigns", MGMT, () => ({ campaignName: "Camp" })),
  // leads
  C("get", () => "/api/leads", ALL),
  C("get", (s) => `/api/leads/${s.leadA}`, ALL),
  C("post", () => "/api/leads", ALL, () => ({ fullName: "L", phone: "9111111111" })),
  C("put", (s) => `/api/leads/${s.leadA}`, MGMT, () => ({ fullName: "L", phone: "9000000001" })),
  C("put", (s) => `/api/leads/${s.leadA}/status`, MGMT, () => "CONTACTED"),
  C("delete", (s) => `/api/leads/${s.unassignedLead}`, MGMT),
  C("get", () => "/api/leads/campaign/1", ALL),
  // agent self-service
  C("put", (s) => `/api/agent/leads/${s.leadA}/status`, ALL, () => "CONTACTED"),
  C("get", (s) => `/api/agent/leads/${s.agent1}`, ALL),
  // lead assignments
  C("get", () => "/api/lead-assignments", ALL),
  C("get", (s) => `/api/lead-assignments/lead/${s.leadA}/active`, ALL),
  C("get", (s) => `/api/lead-assignments/team/${s.team}`, MGMT, undefined, "FIXED"),
  C("get", (s) => `/api/lead-assignments/team/${s.team}/active`, MGMT, undefined, "FIXED"),
  C("get", () => "/api/lead-assignments/status/ACTIVE", MGMT, undefined, "FIXED"),
  C("post", () => "/api/lead-assignments", MGMT, (s) => ({ leadId: s.unassignedLead, agentId: s.agent2 }), "FIXED"),
  C("post", () => "/api/lead-assignments/bulk", MGMT, (s) => ({ leadIds: [s.unassignedLead], agentId: s.agent2 }), "FIXED"),
  C("put", (s) => `/api/lead-assignments/${s.leadA}/reassign`, ALL, (s) => ({ newAgentId: s.agent2 })),
  C("put", (s) => `/api/lead-assignments/${s.closedLead}/reopen`, MGMT, (s) => ({ newAgentId: s.agent2 }), "FIXED"),
  C("put", () => "/api/lead-assignments/1/status?status=INACTIVE", MGMT, undefined, "FIXED"),
  C("delete", () => "/api/lead-assignments/1", MGMT, undefined, "FIXED"),
  // activity
  C("get", () => "/api/call-logs", ALL),
  C("get", () => "/api/follow-ups", ALL),
  C("get", () => "/api/follow-ups/today", ALL),
  C("get", () => "/api/notes", ALL),
  C("get", () => "/api/notifications", ALL),
  C("get", () => "/api/notifications/unread/count", ALL),
  C("put", () => "/api/notifications/read-all", ALL),
  C("get", () => "/api/dashboard/summary", ALL),
  // attendance (own id) and admin attendance
  C("get", (s) => `/api/attendance/today?agentId=${s.agent1}`, ALL),
  C("get", (s) => `/api/attendance/break/active?agentId=${s.agent1}`, ALL),
  C("get", () => "/api/admin/attendance", ADMIN),
  C("get", () => "/api/admin/attendance/1", ADMIN),
  C("delete", () => "/api/admin/attendance/1", ADMIN),
];

const tokenFor = (role: Role) =>
  env.token(role === "ADMIN" ? env.seed.admin : role === "MANAGER" ? env.seed.manager : env.seed.agent1);

describe("role matrix", () => {
  for (const c of cases) {
    const label = `${c.method.toUpperCase()} ${c.path({ admin: 1, manager: 2, agent1: 3, agent2: 4, inactiveAgent: 5, team: 1, inactiveTeam: 2, leadA: 1, leadB: 2, leadC: 3, closedLead: 4, unassignedLead: 5 })}`;
    for (const role of ALL) {
      const expectAllowed = c.allowed.includes(role);
      it(`${label} as ${role} -> ${expectAllowed ? "allowed" : "403"}${c.note ? ` (${c.note})` : ""}`, async () => {
        let req = env.request[c.method](c.path(env.seed)).set(auth(tokenFor(role)));
        if (c.body) req = req.set("Content-Type", "application/json").send(JSON.stringify(c.body(env.seed)));
        const res = await req;
        if (expectAllowed) {
          expect([401, 403], `${res.status} ${JSON.stringify(res.body)}`).not.toContain(res.status);
          expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
        }
        else expect(res.status).toBe(403);
      });
    }
    it(`${label} anonymous -> 401`, async () => {
      const res = await env.request[c.method](c.path(env.seed));
      expect(res.status).toBe(401);
    });
  }
});

describe("FIXED: client-supplied agent ids", () => {
  it("agent cannot read another agent's attendance, breaks or assignments", async () => {
    const t = env.token(env.seed.agent1);
    for (const p of [
      `/api/attendance/today?agentId=${env.seed.agent2}`,
      `/api/attendance/break/active?agentId=${env.seed.agent2}`,
      `/api/attendance/break/summary?agentId=${env.seed.agent2}`,
      `/api/agent/leads/${env.seed.agent2}`,
      `/api/lead-assignments/agent/${env.seed.agent2}`,
      `/api/lead-assignments/agent/${env.seed.agent2}/active`,
    ]) expect((await env.request.get(p).set(auth(t))).status, p).toBe(403);
  });

  it("agent cannot start/end breaks or log in/out for another agent; admin can", async () => {
    const t = env.token(env.seed.agent1);
    const other = env.seed.agent2;
    expect((await env.request.post(`/api/attendance/login?agentId=${other}`).set(auth(t))).status).toBe(403);
    expect((await env.request.post(`/api/attendance/logout?agentId=${other}`).set(auth(t))).status).toBe(403);
    expect((await env.request.post("/api/attendance/break/start").set(auth(t)).send({ agentId: other, breakType: "TEA" })).status).toBe(403);
    expect((await env.request.post("/api/attendance/break/end").set(auth(t)).send({ agentId: other })).status).toBe(403);
    expect((await env.request.post(`/api/attendance/login?agentId=${other}`).set(auth(env.token(env.seed.admin)))).status).toBe(200);
    // Managers may read but not write another agent's attendance.
    expect((await env.request.get(`/api/attendance/today?agentId=${other}`).set(auth(env.token(env.seed.manager)))).status).toBe(200);
    expect((await env.request.post(`/api/attendance/logout?agentId=${other}`).set(auth(env.token(env.seed.manager)))).status).toBe(403);
  });

  it("agent can transfer only leads actively assigned to them", async () => {
    const t = env.token(env.seed.agent1);
    const res = await env.request.put(`/api/lead-assignments/${env.seed.leadC}/reassign`).set(auth(t)).send({ newAgentId: env.seed.agent1 });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "You can only transfer leads assigned to you" });
    const ok = await env.request.put(`/api/lead-assignments/${env.seed.leadA}/reassign`).set(auth(t)).send({ newAgentId: env.seed.agent2 });
    expect(ok.status).toBe(200);
  });

  it("agents receive colleagues without email/phone; management gets full records", async () => {
    const asAgent = await env.request.get("/api/users").set(auth(env.token(env.seed.agent1)));
    expect(Object.keys(asAgent.body[0]).sort()).toEqual(["fullName", "id", "role", "status"]);
    const asAdmin = await env.request.get("/api/users").set(auth(env.token(env.seed.admin)));
    expect(Object.keys(asAdmin.body[0]).sort()).toEqual(["email", "fullName", "id", "phone", "role", "status"]);
    expect(asAdmin.body[0]).not.toHaveProperty("password");
  });

  it("agents see only their own campaign leads and assignment lists", async () => {
    const camp = (await env.pool.query("insert into campaigns (campaign_name, status) values ('C','ACTIVE') returning id")).rows[0].id;
    await env.pool.query("update leads set campaign_id = $1", [camp]);
    const t = env.token(env.seed.agent1);
    const leads = await env.request.get(`/api/leads/campaign/${camp}`).set(auth(t));
    expect(leads.body.map((l: { id: number }) => l.id).sort()).toEqual([env.seed.leadA, env.seed.leadB]);
    const all = await env.request.get("/api/lead-assignments").set(auth(t));
    expect(new Set(all.body.map((a: { agentId: number }) => a.agentId))).toEqual(new Set([env.seed.agent1]));
  });
});
