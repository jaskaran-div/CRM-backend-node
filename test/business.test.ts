import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runFollowUpReminders } from "../src/jobs/followUpReminders.js";
import { auth, createTestEnv, resetAndSeed, type TestEnv } from "./helpers.js";

let env: TestEnv;
let A: string, M: string, G1: string, G2: string; // admin, manager, agent1, agent2 tokens
beforeAll(async () => {
  env = await createTestEnv();
});
beforeEach(async () => {
  env.seed = await resetAndSeed(env.pool);
  env.clock.setIst("2026-10-17T10:00:00");
  A = env.token(env.seed.admin);
  M = env.token(env.seed.manager);
  G1 = env.token(env.seed.agent1);
  G2 = env.token(env.seed.agent2);
});
afterAll(() => env?.close());

const q = async (sql: string, p: unknown[] = []) => (await env.pool.query(sql, p)).rows;
const json = (t: string) => ({ ...auth(t), "Content-Type": "application/json" });

// ======================================================================= LEADS
describe("leads", () => {
  it("agents see only actively assigned leads; management sees all", async () => {
    const a = await env.request.get("/api/leads").set(auth(G1));
    expect(a.body.map((l: { id: number }) => l.id)).toEqual([env.seed.leadA, env.seed.leadB]);
    expect((await env.request.get("/api/leads").set(auth(A))).body).toHaveLength(5);
    expect((await env.request.get(`/api/leads/${env.seed.leadC}`).set(auth(G1))).status).toBe(404);
  });

  it("returns Spring's entity shape with Jackson timestamps", async () => {
    const res = await env.request.get(`/api/leads/${env.seed.leadA}`).set(auth(A));
    expect(Object.keys(res.body).sort()).toEqual(["age", "campaignId", "city", "courseInterested", "createdAt", "currentProfession",
      "customerLookingFor", "education", "email", "fullName", "id", "interestedArea", "leadSource", "phone", "primaryObjective",
      "priority", "status", "tradingInvestmentExperience", "updatedAt"].sort());
    expect(res.body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/);
  });

  it("create validates like Spring and rejects duplicate phones", async () => {
    const post = (b: object) => env.request.post("/api/leads").set(auth(G1)).send(b);
    expect((await post({ phone: "9123456789" })).body).toEqual({ error: "Lead full name is required" });
    expect((await post({ fullName: "X" })).body).toEqual({ error: "Lead phone number is required" });
    expect((await post({ fullName: "X", phone: "12345" })).body).toEqual({ error: "Lead phone number must contain 10 to 15 digits" });
    expect((await post({ fullName: "X", phone: "9000000001" })).body).toEqual({ error: "A lead with this phone number already exists" });
    const ok = await post({ fullName: "X", phone: "+919123456789", id: env.seed.leadA });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "NEW", priority: "MEDIUM" });
    expect(ok.body.id).not.toBe(env.seed.leadA); // client id ignored (Spring would have overwritten leadA)
  });

  it("closing status deactivates the active assignment", async () => {
    const res = await env.request.put(`/api/agent/leads/${env.seed.leadA}/status`).set(json(G1)).send(JSON.stringify("ENROLLED"));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ENROLLED");
    expect(await q("select status from lead_assignments where lead_id = $1", [env.seed.leadA])).toEqual([{ status: "INACTIVE" }]);
  });

  it("agent cannot change status of a lead not assigned to them", async () => {
    const res = await env.request.put(`/api/agent/leads/${env.seed.leadC}/status`).set(json(G1)).send(JSON.stringify("CONTACTED"));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "You are not allowed to update the status of this lead" });
  });

  it("agent details update trims, nulls blanks and validates age", async () => {
    const base = { fullName: "  Lead A2 ", phone: "9000000001", city: "  ", education: " B.Com " };
    expect((await env.request.put(`/api/agent/leads/${env.seed.leadA}/details`).set(auth(G1)).send({ ...base, age: 200 })).body)
      .toEqual({ error: "Age must be between 1 and 120" });
    const res = await env.request.put(`/api/agent/leads/${env.seed.leadA}/details`).set(auth(G1)).send(base);
    expect(res.body).toMatchObject({ fullName: "Lead A2", city: null, education: "B.Com" });
  });

  it("delete cascades to assignments, calls, follow-ups and notes atomically", async () => {
    const id = env.seed.leadA;
    await q("insert into call_logs (lead_id, agent_id, call_start_time) values ($1,$2,now())", [id, env.seed.agent1]);
    await q("insert into follow_ups (lead_id, agent_id, follow_up_date) values ($1,$2,now())", [id, env.seed.agent1]);
    await q("insert into notes (lead_id, user_id, note) values ($1,$2,'n')", [id, env.seed.agent1]);
    expect((await env.request.delete(`/api/leads/${id}`).set(auth(M))).status).toBe(204);
    for (const t of ["lead_assignments", "call_logs", "follow_ups", "notes"]) {
      expect(await q(`select count(*)::int n from ${t} where lead_id = $1`, [id])).toEqual([{ n: 0 }]);
    }
    expect((await env.request.delete(`/api/leads/${id}`).set(auth(M))).body).toEqual({ error: "Lead not found" });
  });

  it("records lead views on the IST date (Spring used UTC)", async () => {
    env.clock.setIst("2026-10-18T00:30:00"); // still 2026-10-17 in UTC
    expect((await env.request.post(`/api/lead-views/${env.seed.leadA}`).set(auth(G1))).body)
      .toEqual({ success: true, message: "Lead view recorded", leadId: env.seed.leadA });
    await env.request.post(`/api/lead-views/${env.seed.leadA}`).set(auth(G1)); // idempotent
    expect(await q("select viewed_date::text d from lead_view_activities")).toEqual([{ d: "2026-10-18" }]);
    expect((await env.request.post(`/api/lead-views/${env.seed.leadC}`).set(auth(G1))).status).toBe(403);
  });
});

// ======================================================================= ASSIGNMENTS
describe("lead assignments", () => {
  it("create enforces lead/agent/team rules in Spring's order", async () => {
    const post = (b: object) => env.request.post("/api/lead-assignments").set(auth(A)).send(b);
    expect((await post({ agentId: 1 })).body).toEqual({ error: "Lead is required" });
    expect((await post({ leadId: env.seed.closedLead, agentId: env.seed.agent1 })).body)
      .toEqual({ error: "Closed lead cannot be assigned. Reopen the lead first." });
    expect((await post({ leadId: env.seed.leadA, agentId: env.seed.agent2 })).body).toEqual({ error: "Lead already has an active assignment" });
    expect((await post({ leadId: env.seed.unassignedLead, agentId: env.seed.admin })).body).toEqual({ error: "Selected user is not an agent" });
    expect((await post({ leadId: env.seed.unassignedLead, agentId: env.seed.inactiveAgent })).body).toEqual({ error: "Agent is inactive" });
    expect((await post({ leadId: env.seed.unassignedLead, agentId: env.seed.agent2, teamId: env.seed.inactiveTeam })).body).toEqual({ error: "Team is inactive" });
    const ok = await post({ leadId: String(env.seed.unassignedLead), agentId: env.seed.agent2 });
    expect(ok.body).toMatchObject({ leadId: env.seed.unassignedLead, agentId: env.seed.agent2, status: "ACTIVE" });
  });

  it("bulk skips already-assigned leads, dedupes ids and fails when nothing is assignable", async () => {
    const res = await env.request.post("/api/lead-assignments/bulk").set(auth(M))
      .send({ leadIds: [env.seed.leadA, env.seed.unassignedLead, env.seed.unassignedLead], agentId: env.seed.agent2 });
    expect(res.body).toHaveLength(1);
    expect((await env.request.post("/api/lead-assignments/bulk").set(auth(M)).send({ leadIds: [env.seed.leadA], agentId: env.seed.agent2 })).body)
      .toEqual({ error: "All selected leads are already assigned" });
    expect((await env.request.post("/api/lead-assignments/bulk").set(auth(M)).send({ leadIds: [999], agentId: env.seed.agent2 })).body)
      .toEqual({ error: "Lead not found: 999" });
  });

  it("reassign deactivates the old assignment and notifies the new agent", async () => {
    const res = await env.request.put(`/api/lead-assignments/${env.seed.leadA}/reassign`).set(auth(A))
      .send({ newAgentId: env.seed.agent2, newTeamId: env.seed.team });
    expect(res.body).toMatchObject({ agentId: env.seed.agent2, status: "ACTIVE" });
    expect(await q("select status from lead_assignments where lead_id = $1 order by id", [env.seed.leadA])).toEqual([{ status: "INACTIVE" }, { status: "ACTIVE" }]);
    expect(await q("select user_id, type, message, reference_id from notifications")).toEqual([{
      user_id: env.seed.agent2, type: "LEAD_TRANSFERRED", reference_id: res.body.id,
      message: `Lead #${env.seed.leadA} has been transferred to you. Team ID: ${env.seed.team}`,
    }]);
    // Same agent and team again: no-op returning the current assignment.
    const again = await env.request.put(`/api/lead-assignments/${env.seed.leadA}/reassign`).set(auth(A))
      .send({ newAgentId: env.seed.agent2, newTeamId: env.seed.team });
    expect(again.body.id).toBe(res.body.id);
  });

  it("reopen sets a closed lead back to NEW with a new assignment", async () => {
    const res = await env.request.put(`/api/lead-assignments/${env.seed.closedLead}/reopen`).set(auth(A)).send({ newAgentId: env.seed.agent2 });
    expect(res.body).toMatchObject({ agentId: env.seed.agent2, status: "ACTIVE" });
    expect(await q("select status from leads where id = $1", [env.seed.closedLead])).toEqual([{ status: "NEW" }]);
    expect((await env.request.put(`/api/lead-assignments/${env.seed.leadA}/reopen`).set(auth(A)).send({ newAgentId: env.seed.agent2 })).body)
      .toEqual({ error: "Lead is not closed and does not need reopening." });
  });

  it("team delete returns 409 {message} when referenced", async () => {
    const res = await env.request.delete(`/api/teams/${env.seed.team}`).set(auth(A));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ message: "Cannot delete team because it is used by lead assignments." });
  });
});

// ======================================================================= CALL LOGS / FOLLOW-UPS / NOTES
describe("call logs", () => {
  it("agent call syncs lead details, maps outcome to status and closes the assignment", async () => {
    const res = await env.request.post("/api/call-logs").set(auth(G1)).send({
      leadId: env.seed.leadA, agentId: env.seed.agent2, callStartTime: "2026-10-17T09:30",
      callStatus: "ANSWERED", callOutcome: "NOT_INTERESTED", city: "  Pune ", education: "",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ agentId: env.seed.agent1, callStartTime: "2026-10-17T09:30:00", city: "  Pune " });
    expect(await q("select city, status from leads where id = $1", [env.seed.leadA])).toEqual([{ city: "Pune", status: "NOT_INTERESTED" }]);
    expect(await q("select status from lead_assignments where lead_id = $1", [env.seed.leadA])).toEqual([{ status: "INACTIVE" }]);
  });

  it("CALL_BACK maps to FOLLOW_UP; agents cannot log calls on others' leads", async () => {
    await env.request.post("/api/call-logs").set(auth(G1)).send({ leadId: env.seed.leadB, callStartTime: "2026-10-17T09:30", callOutcome: "CALL_BACK" });
    expect(await q("select status from leads where id = $1", [env.seed.leadB])).toEqual([{ status: "FOLLOW_UP" }]);
    const res = await env.request.post("/api/call-logs").set(auth(G1)).send({ leadId: env.seed.leadC, callStartTime: "2026-10-17T09:30" });
    expect(res.status).toBe(403);
  });

  it("agents only see and delete their own calls", async () => {
    await q("insert into call_logs (lead_id, agent_id, call_start_time) values ($1,$2,now()),($3,$4,now())", [env.seed.leadA, env.seed.agent1, env.seed.leadC, env.seed.agent2]);
    expect((await env.request.get("/api/call-logs").set(auth(G1))).body).toHaveLength(1);
    expect((await env.request.get("/api/call-logs").set(auth(A))).body).toHaveLength(2);
    expect((await env.request.delete("/api/call-logs/2").set(auth(G1))).status).toBe(403);
  });
});

describe("follow-ups", () => {
  it("create notifies the agent and moves the lead to FOLLOW_UP", async () => {
    const res = await env.request.post("/api/follow-ups").set(auth(G1)).send({ leadId: env.seed.leadA, followUpDate: "2026-10-17T15:00", purpose: "Demo" });
    expect(res.body).toMatchObject({ status: "PENDING", followUpDate: "2026-10-17T15:00:00", agentId: env.seed.agent1 });
    expect(await q("select type, message from notifications")).toEqual([{
      type: "FOLLOW_UP_CREATED", message: `Follow-up #${res.body.id} has been scheduled for 2026-10-17T15:00. Purpose: Demo`,
    }]);
    expect(await q("select status from leads where id = $1", [env.seed.leadA])).toEqual([{ status: "FOLLOW_UP" }]);
  });

  it("today/overdue/upcoming use the IST clock", async () => {
    const add = (d: string) => q("insert into follow_ups (lead_id, agent_id, follow_up_date, status) values ($1,$2,$3,'PENDING')", [env.seed.leadA, env.seed.agent1, d]);
    await add("2026-10-18 01:00:00"); // IST tomorrow 01:00
    await add("2026-10-17 23:00:00");
    env.clock.setIst("2026-10-18T00:30:00"); // UTC is still the 17th
    const today = await env.request.get("/api/follow-ups/today").set(auth(A));
    expect(today.body.map((f: { followUpDate: string }) => f.followUpDate)).toEqual(["2026-10-18T01:00:00"]);
    expect((await env.request.get("/api/follow-ups/overdue").set(auth(A))).body).toHaveLength(1);
    expect((await env.request.get("/api/follow-ups/upcoming").set(auth(A))).body).toHaveLength(1);
  });

  it("agents see only own follow-ups on actively assigned leads", async () => {
    await q("insert into follow_ups (lead_id, agent_id, follow_up_date) values ($1,$2,now()),($3,$2,now())", [env.seed.leadA, env.seed.agent1, env.seed.closedLead]);
    expect((await env.request.get("/api/follow-ups").set(auth(G1))).body).toHaveLength(1);
  });
});

describe("notes and notifications", () => {
  it("agent notes are scoped to assigned leads and owned by the agent", async () => {
    const res = await env.request.post("/api/notes").set(auth(G1)).send({ leadId: env.seed.leadA, userId: env.seed.admin, note: "hi" });
    expect(res.body).toMatchObject({ userId: env.seed.agent1, note: "hi" });
    expect((await env.request.post("/api/notes").set(auth(G1)).send({ leadId: env.seed.leadC, note: "x" })).status).toBe(403);
    expect((await env.request.post("/api/notes").set(auth(G1)).send({ leadId: 999, note: "x" })).status).toBe(404);
    expect((await env.request.get(`/api/notes/lead/${env.seed.leadA}`).set(auth(G2))).body).toEqual([]);
  });

  it("notifications are private to their owner", async () => {
    await q("insert into notifications (user_id, type, title, message) values ($1,'T','t','m')", [env.seed.agent1]);
    expect(await (await env.request.get("/api/notifications/unread/count").set(auth(G1))).body).toBe(1);
    expect((await env.request.put("/api/notifications/1/read").set(auth(G2))).status).toBe(403);
    expect((await env.request.put("/api/notifications/1/read").set(auth(G1))).body.read).toBe(true);
  });
});

// ======================================================================= ATTENDANCE & BREAKS
describe("attendance and breaks", () => {
  const login = () => env.request.post("/api/auth/login").send({ email: "agent1@crm.test", password: "Passw0rd!" });

  it("closes a stale session at its day end on next login", async () => {
    env.clock.setIst("2026-10-16T09:00:00");
    await login();
    env.clock.setIst("2026-10-17T09:00:00");
    await login();
    expect(await q("select attendance_date::text d, logout_time::text o from agent_attendance order by id")).toEqual([
      { d: "2026-10-16", o: "2026-10-17 00:00:00" }, { d: "2026-10-17", o: null },
    ]);
  });

  it("enforces break rules with the {message} envelope", async () => {
    const start = (b: object) => env.request.post("/api/attendance/break/start").set(auth(G1)).send({ agentId: env.seed.agent1, ...b });
    expect((await start({ breakType: "TEA" })).body).toEqual({ message: "No active attendance session. Please log in first." });
    await login();
    expect((await start({})).body).toEqual({ message: "Select a break type." });
    expect((await start({ breakType: "NORMAL" })).body).toEqual({ message: "Select Lunch, Tea, Bio, or Exception Break." });
    expect((await start({ breakType: "EXCEPTION", reason: "  " })).body).toEqual({ message: "Reason is required for an exception break." });
    expect((await start({ breakType: "TEA" })).status).toBe(200);
    const dup = await start({ breakType: "BIO" });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ message: "You already have an active break." });
    env.clock.advance(31 * 60);
    const end = await env.request.post("/api/attendance/break/end").set(auth(G1)).send({ agentId: env.seed.agent1 });
    expect(end.body.durationSeconds).toBe(1860);
    expect((await start({ breakType: "TEA" })).body).toEqual({ message: "Tea Break allowance is exhausted for today." });
  });

  it("summary matches Spring's BreakSummary, including toString start time", async () => {
    await login();
    await env.request.post("/api/attendance/break/start").set(auth(G1)).send({ agentId: env.seed.agent1, breakType: "LUNCH" });
    env.clock.advance(600);
    const res = await env.request.get(`/api/attendance/break/summary?agentId=${env.seed.agent1}`).set(auth(G1));
    expect(res.body).toEqual({
      normalUsedSeconds: 600, normalRemainingSeconds: 4500, exceptionUsedSeconds: 0,
      activeBreakStartTime: "2026-10-17T10:00", activeBreakType: "LUNCH", activeBreakElapsedSeconds: 600,
      lunchUsedSeconds: 600, lunchRemainingSeconds: 1500, teaUsedSeconds: 0, teaRemainingSeconds: 1800,
      bioUsedSeconds: 0, bioRemainingSeconds: 1200,
    });
    expect((await env.request.get(`/api/attendance/break/active?agentId=${env.seed.agent1}`).set(auth(G1))).body.breakType).toBe("LUNCH");
  });

  it("empty active break / today responses keep Spring's shapes", async () => {
    const a = await env.request.get(`/api/attendance/break/active?agentId=${env.seed.agent1}`).set(auth(G1));
    expect(a.status).toBe(200);
    expect(a.text).toBe("");
    const t = await env.request.get(`/api/attendance/today?agentId=${env.seed.agent1}`).set(auth(G1));
    expect(t.text).toBe("null");
  });

  it("admin list computes net working time in one query", async () => {
    await login();
    await env.request.post("/api/attendance/break/start").set(auth(G1)).send({ agentId: env.seed.agent1, breakType: "EXCEPTION", reason: "doctor" });
    env.clock.advance(1200);
    await env.request.post("/api/attendance/break/end").set(auth(G1)).send({ agentId: env.seed.agent1 });
    env.clock.advance(2400);
    const res = await env.request.get("/api/admin/attendance").set(auth(A));
    expect(res.body).toEqual([{
      id: 1, agentId: env.seed.agent1, agentName: "Agent One", attendanceDate: "2026-10-17",
      loginTime: "2026-10-17T10:00", logoutTime: null, workingSeconds: 2400, normalBreakSeconds: 0,
      exceptionBreakSeconds: 1200, onBreak: false, activeBreakType: null, activeBreakStartTime: null,
    }]);
    const d = await env.request.get("/api/admin/attendance/1").set(auth(A));
    expect(d.body).toMatchObject({ grossWorkingSeconds: 3600, workingSeconds: 2400, breaks: [{ breakType: "EXCEPTION", durationSeconds: 1200, reason: "doctor" }] });
    expect((await env.request.delete("/api/admin/attendance/1").set(auth(A))).body).toEqual({ message: "Attendance record deleted successfully." });
    expect(await q("select count(*)::int n from agent_breaks")).toEqual([{ n: 0 }]);
  });
});

// ======================================================================= DASHBOARD
describe("dashboard summary", () => {
  it("management view counts across all data with Spring's keys", async () => {
    await q("insert into call_logs (lead_id, agent_id, call_start_time, call_outcome) values ($1,$2,now(),'ENROLLED')", [env.seed.leadA, env.seed.agent1]);
    await q("insert into lead_view_activities (agent_id, lead_id, viewed_date) values ($1,$2,'2026-10-17')", [env.seed.agent1, env.seed.leadA]);
    const res = await env.request.get("/api/dashboard/summary").set(auth(A));
    expect(Object.keys(res.body)).toEqual(["totalLeads", "newLeads", "contactedLeads", "interestedLeads", "followUpLeads", "counsellingLeads",
      "enrolledLeads", "notInterestedLeads", "wrongNumberLeads", "noResponseLeads", "lostLeads", "assignedLeads", "unassignedLeads",
      "totalFollowUps", "pendingFollowUps", "completedFollowUps", "missedFollowUps", "cancelledFollowUps", "todayFollowUps",
      "leadStatusCounts", "totalCalls", "attendedLeads", "remainingLeads", "agentLeadDistribution", "agentPerformance",
      "campaignPerformance", "leadSourcePerformance"]);
    expect(res.body).toMatchObject({ totalLeads: 5, newLeads: 4, enrolledLeads: 1, assignedLeads: 3, unassignedLeads: 1, totalCalls: 1,
      attendedLeads: 1, remainingLeads: 2 });
    expect(res.body.agentPerformance).toEqual([
      { agentId: env.seed.agent1, agentName: "Agent One", activeLeads: 2, totalCalls: 1, enrolledLeads: 1 },
      { agentId: env.seed.agent2, agentName: "Agent Two", activeLeads: 1, totalCalls: 0, enrolledLeads: 0 },
    ]);
    expect(res.body.leadSourcePerformance).toEqual([
      { source: "Website", totalLeads: 3, enrolledLeads: 1, conversionRate: 33.33 },
      { source: "Referral", totalLeads: 1, enrolledLeads: 0, conversionRate: 0 },
      { source: "Unknown", totalLeads: 1, enrolledLeads: 0, conversionRate: 0 },
    ]);
  });

  it("agent view is scoped and hides analytics", async () => {
    const res = await env.request.get("/api/dashboard/summary").set(auth(G1));
    expect(res.body).toMatchObject({ totalLeads: 2, assignedLeads: 2, unassignedLeads: 0, agentPerformance: [], leadSourcePerformance: [] });
  });
});

// ======================================================================= SCHEDULER
describe("follow-up reminder scheduler", () => {
  it("reminds upcoming, marks overdue MISSED, and is idempotent", async () => {
    const add = (d: string) => q("insert into follow_ups (lead_id, agent_id, follow_up_date, status, purpose) values ($1,$2,$3,'PENDING',null) returning id",
      [env.seed.leadA, env.seed.agent1, d]);
    const [up] = await add("2026-10-17 10:10:00");
    const [od] = await add("2026-10-17 09:00:00");
    await add("2026-10-17 12:00:00"); // outside window
    expect(await runFollowUpReminders(env.ctx.db, env.clock)).toMatchObject({ reminded: 1, missed: 1 });
    expect(await runFollowUpReminders(env.ctx.db, env.clock)).toMatchObject({ reminded: 1, missed: 0 });
    expect(await q("select type, message, reference_id from notifications order by id")).toEqual([
      { type: "FOLLOW_UP_REMINDER", reference_id: up.id, message: `Follow-up #${up.id} is scheduled for 2026-10-17T10:10. Purpose: Follow-up` },
      { type: "FOLLOW_UP_OVERDUE", reference_id: od.id, message: `Follow-up #${od.id} is overdue. Please complete it.` },
    ]);
    expect(await q("select status from follow_ups where id = $1", [od.id])).toEqual([{ status: "MISSED" }]);
    // When the upcoming one becomes overdue, its reminder is marked read.
    env.clock.setIst("2026-10-17T10:20:00");
    await runFollowUpReminders(env.ctx.db, env.clock);
    expect(await q("select is_read from notifications where type = 'FOLLOW_UP_REMINDER'")).toEqual([{ is_read: true }]);
  });
});
