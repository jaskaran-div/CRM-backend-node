import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runFollowUpReminders } from "../src/jobs/followUpReminders.js";
import { auth, createTestEnv, PASSWORD, resetAndSeed, type TestEnv } from "./helpers.js";

// Regression tests for the six APPROVED business-rule changes (migration/FINAL_REVIEW.md §4).
// Each "was:" note records the Spring behaviour that was replaced.

let env: TestEnv;
let A: string, M: string, G1: string, G2: string;
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
const assignments = (leadId: number) => q("select agent_id, team_id, status from lead_assignments where lead_id = $1 order by id", [leadId]);
const json = (t: string) => ({ ...auth(t), "Content-Type": "application/json" });

// =================================================================== 1
describe("R1 closing a lead through either edit form releases the assignment (was: stayed ACTIVE)", () => {
  it.each(["ENROLLED", "NOT_INTERESTED", "LOST", "WRONG_NUMBER"])("admin edit form with %s", async (status) => {
    const res = await env.request.put(`/api/leads/${env.seed.leadA}`).set(auth(A)).send({ fullName: "Lead A", phone: "9000000001", status });
    expect(res.body.status).toBe(status);
    expect(await assignments(env.seed.leadA)).toEqual([{ agent_id: env.seed.agent1, team_id: env.seed.team, status: "INACTIVE" }]);
  });

  it("agent details form with a closing status; the agent then loses access like the status button", async () => {
    const res = await env.request.put(`/api/agent/leads/${env.seed.leadA}/details`).set(auth(G1)).send({ fullName: "Lead A", phone: "9000000001", status: "NOT_INTERESTED" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("NOT_INTERESTED");
    expect(await assignments(env.seed.leadA)).toEqual([{ agent_id: env.seed.agent1, team_id: env.seed.team, status: "INACTIVE" }]);
    expect((await env.request.get(`/api/leads/${env.seed.leadA}`).set(auth(G1))).status).toBe(404);
    const dash = (await env.request.get("/api/dashboard/summary").set(auth(A))).body;
    expect(dash.assignedLeads).toBe(2);
  });

  it("non-closing statuses and an omitted status keep the assignment", async () => {
    await env.request.put(`/api/leads/${env.seed.leadA}`).set(auth(M)).send({ fullName: "Lead A", phone: "9000000001", status: "INTERESTED" });
    await env.request.put(`/api/agent/leads/${env.seed.leadB}/details`).set(auth(G1)).send({ fullName: "Lead B", phone: "9000000002" });
    expect(await assignments(env.seed.leadA)).toEqual([{ agent_id: env.seed.agent1, team_id: env.seed.team, status: "ACTIVE" }]);
    expect(await assignments(env.seed.leadB)).toEqual([{ agent_id: env.seed.agent1, team_id: env.seed.team, status: "ACTIVE" }]);
  });

  it("permissions are unchanged: an agent cannot close another agent's lead via the details form", async () => {
    const res = await env.request.put(`/api/agent/leads/${env.seed.leadC}/details`).set(auth(G1)).send({ fullName: "C", phone: "9000000003", status: "LOST" });
    expect(res.status).toBe(403);
    expect(await assignments(env.seed.leadC)).toEqual([{ agent_id: env.seed.agent2, team_id: env.seed.team, status: "ACTIVE" }]);
    expect((await env.request.put(`/api/leads/${env.seed.leadC}`).set(auth(G1)).send({ fullName: "C", phone: "9000000003", status: "LOST" })).status).toBe(403);
  });

  it("a failed edit (duplicate phone) changes nothing", async () => {
    const res = await env.request.put(`/api/leads/${env.seed.leadA}`).set(auth(A)).send({ fullName: "A", phone: "9000000002", status: "LOST" });
    expect(res.status).toBe(400);
    expect(await assignments(env.seed.leadA)).toEqual([{ agent_id: env.seed.agent1, team_id: env.seed.team, status: "ACTIVE" }]);
    expect(await q("select status from leads where id = $1", [env.seed.leadA])).toEqual([{ status: "NEW" }]);
  });
});

// =================================================================== 2
describe("R2 admin edit keeps the campaign when campaignId is omitted (was: always cleared)", () => {
  let camp1: number, camp2: number;
  beforeEach(async () => {
    [{ id: camp1 }, { id: camp2 }] = await q("insert into campaigns (campaign_name) values ('C1'), ('C2') returning id");
    await q("update leads set campaign_id = $1 where id = $2", [camp1, env.seed.leadA]);
  });
  const put = (body: object) => env.request.put(`/api/leads/${env.seed.leadA}`).set(auth(A)).send({ fullName: "Lead A", phone: "9000000001", ...body });
  const campaign = async () => (await q("select campaign_id from leads where id = $1", [env.seed.leadA]))[0].campaign_id;

  it("omitted -> unchanged (exact payload of the admin lead-edit form)", async () => {
    const res = await put({ email: "", courseInterested: "", leadSource: "Website", status: "CONTACTED", priority: "HIGH", city: "Pune" });
    expect(res.body.campaignId).toBe(camp1);
    expect(await campaign()).toBe(camp1);
  });
  it("explicit id -> moves", async () => {
    expect((await put({ campaignId: camp2 })).body.campaignId).toBe(camp2);
  });
  it("explicit null / empty string -> clears", async () => {
    expect((await put({ campaignId: null })).body.campaignId).toBeNull();
    await q("update leads set campaign_id = $1 where id = $2", [camp1, env.seed.leadA]);
    expect((await put({ campaignId: "" })).body.campaignId).toBeNull();
  });
  it("unknown campaign -> 400, nothing changed", async () => {
    expect((await put({ campaignId: 999 })).body).toEqual({ error: "Selected campaign does not exist" });
    expect(await campaign()).toBe(camp1);
  });
  it("campaign performance keeps counting the edited lead", async () => {
    await put({ city: "Delhi" });
    const perf = (await env.request.get("/api/dashboard/summary").set(auth(A))).body.campaignPerformance;
    expect(perf.find((c: { campaignId: number }) => c.campaignId === camp1).totalLeads).toBe(1);
  });
});

// =================================================================== 3
describe("R3 follow-ups: overdue during the due date, MISSED after it ends in IST (was: MISSED 1 minute after)", () => {
  const add = async (ist: string) =>
    (await q("insert into follow_ups (lead_id, agent_id, follow_up_date, status) values ($1,$2,$3,'PENDING') returning id",
      [env.seed.leadA, env.seed.agent1, ist]))[0].id as number;
  const status = async (id: number) => (await q("select status from follow_ups where id = $1", [id]))[0].status;
  const types = async (id: number) => (await q("select type from notifications where reference_id = $1 order by id", [id])).map((r) => r.type);

  it("past its time: overdue notification, still PENDING and listed as overdue", async () => {
    const id = await add("2026-10-17 09:30:00");
    await runFollowUpReminders(env.ctx.db, env.clock);
    expect(await status(id)).toBe("PENDING");
    expect(await types(id)).toEqual(["FOLLOW_UP_OVERDUE"]);
    expect((await env.request.get("/api/follow-ups/overdue").set(auth(G1))).body.map((f: { id: number }) => f.id)).toEqual([id]);
    await runFollowUpReminders(env.ctx.db, env.clock); // idempotent
    expect(await types(id)).toEqual(["FOLLOW_UP_OVERDUE"]);
  });

  it("IST boundary: still PENDING at 23:59:59 IST, MISSED at 00:00:00 IST on the next day", async () => {
    const id = await add("2026-10-17 23:00:00");
    env.clock.setIst("2026-10-17T23:59:59");
    await runFollowUpReminders(env.ctx.db, env.clock);
    expect(await status(id)).toBe("PENDING");
    env.clock.setIst("2026-10-18T00:00:00");
    await runFollowUpReminders(env.ctx.db, env.clock);
    expect(await status(id)).toBe("MISSED");
    expect((await env.request.get("/api/follow-ups/overdue").set(auth(G1))).body).toEqual([]);
  });

  it("uses the IST date, not UTC: 00:30 IST (still the previous day in UTC) already misses yesterday's follow-ups", async () => {
    const id = await add("2026-10-17 18:00:00");
    env.clock.setIst("2026-10-18T00:30:00"); // 2026-10-17 19:00 UTC
    await runFollowUpReminders(env.ctx.db, env.clock);
    expect(await status(id)).toBe("MISSED");
    expect(await types(id)).toEqual(["FOLLOW_UP_OVERDUE"]); // overdue notice not skipped when catching up
  });

  it("an upcoming reminder is marked read once the follow-up becomes overdue; completed ones are untouched", async () => {
    const id = await add("2026-10-17 10:10:00");
    const done = await add("2026-10-16 10:00:00");
    await q("update follow_ups set status = 'COMPLETED' where id = $1", [done]);
    await runFollowUpReminders(env.ctx.db, env.clock);
    env.clock.setIst("2026-10-17T10:20:00");
    await runFollowUpReminders(env.ctx.db, env.clock);
    expect(await q("select type, is_read from notifications where reference_id = $1 order by id", [id])).toEqual([
      { type: "FOLLOW_UP_REMINDER", is_read: true }, { type: "FOLLOW_UP_OVERDUE", is_read: false },
    ]);
    expect(await status(done)).toBe("COMPLETED");
  });

  it("dashboard: overdue-today counts as pending, not missed", async () => {
    await add("2026-10-17 09:00:00");
    await runFollowUpReminders(env.ctx.db, env.clock);
    const d = (await env.request.get("/api/dashboard/summary").set(auth(G1))).body;
    expect([d.pendingFollowUps, d.missedFollowUps, d.todayFollowUps]).toEqual([1, 0, 1]);
  });
});

// =================================================================== 4
describe("R4 logout ends the active break and attendance is computed correctly (was: break ran until midnight)", () => {
  const login = () => env.request.post("/api/auth/login").send({ email: "agent1@crm.test", password: PASSWORD });
  const startBreak = (type = "TEA", reason?: string) =>
    env.request.post("/api/attendance/break/start").set(auth(G1)).send({ agentId: env.seed.agent1, breakType: type, reason });

  it("auth logout closes the break at the logout time; the report stops counting", async () => {
    await login();
    env.clock.advance(1800); // 30 min working
    await startBreak();
    env.clock.advance(600); // 10 min break
    await env.request.post(`/api/auth/logout/${env.seed.agent1}`).set(auth(G1));
    expect(await q("select end_time::text e, duration_seconds d from agent_breaks")).toEqual([{ e: "2026-10-17 10:40:00", d: 600 }]);
    env.clock.advance(3600); // an hour later
    const [row] = (await env.request.get("/api/admin/attendance").set(auth(A))).body;
    expect([row.normalBreakSeconds, row.workingSeconds, row.onBreak]).toEqual([600, 1800, false]);
    const d = (await env.request.get("/api/admin/attendance/1").set(auth(A))).body;
    expect([d.grossWorkingSeconds, d.workingSeconds, d.breaks[0].endTime]).toEqual([2400, 1800, "2026-10-17T10:40"]);
  });

  it("attendance logout endpoint does the same; exception breaks too", async () => {
    await login();
    await startBreak("EXCEPTION", "doctor");
    env.clock.advance(300);
    await env.request.post(`/api/attendance/logout?agentId=${env.seed.agent1}`).set(auth(G1));
    const [row] = (await env.request.get("/api/admin/attendance").set(auth(A))).body;
    expect([row.exceptionBreakSeconds, row.workingSeconds]).toEqual([300, 0]);
  });

  it("break allowance: time after logout is not consumed", async () => {
    await login();
    await startBreak("TEA");
    env.clock.advance(300);
    await env.request.post(`/api/auth/logout/${env.seed.agent1}`).set(auth(G1));
    env.clock.advance(3600);
    await login(); // same IST day -> a new session for today
    const s = (await env.request.get(`/api/attendance/break/summary?agentId=${env.seed.agent1}`).set(auth(G1))).body;
    expect(s.teaUsedSeconds).toBe(0); // the new session has no breaks
    expect((await startBreak("TEA")).status).toBe(200);
  });

  it("existing data: an open break on an already logged-out session counts only up to logout", async () => {
    await q(`insert into agent_attendance (agent_id, attendance_date, login_time, logout_time, created_at)
             values ($1, '2026-10-17', '2026-10-17 09:00:00', '2026-10-17 09:30:00', now())`, [env.seed.agent1]);
    await q(`insert into agent_breaks (agent_id, attendance_id, break_type, start_time) values ($1, 1, 'BIO', '2026-10-17 09:20:00')`, [env.seed.agent1]);
    const [row] = (await env.request.get("/api/admin/attendance").set(auth(A))).body;
    expect([row.normalBreakSeconds, row.workingSeconds]).toEqual([600, 1200]);
  });

  it("stale session from yesterday: its open break ends at that day's midnight on next login (IST)", async () => {
    env.clock.setIst("2026-10-16T22:00:00");
    await login();
    await startBreak("LUNCH");
    env.clock.setIst("2026-10-17T09:00:00");
    await login();
    expect(await q("select end_time::text e, duration_seconds d from agent_breaks")).toEqual([{ e: "2026-10-17 00:00:00", d: 7200 }]);
    const rows = (await env.request.get("/api/admin/attendance").set(auth(A))).body;
    expect(rows.find((r: { attendanceDate: string }) => r.attendanceDate === "2026-10-16")).toMatchObject({ normalBreakSeconds: 7200, workingSeconds: 0 });
  });

  it("logout without a break, and without a session, behave as before", async () => {
    await login();
    expect((await env.request.post(`/api/auth/logout/${env.seed.agent1}`).set(auth(G1))).status).toBe(200);
    expect((await env.request.post(`/api/auth/logout/${env.seed.agent1}`).set(auth(G1))).body).toEqual({ error: "No active attendance session found." });
  });

  it("permissions unchanged: another agent cannot end someone's session/break", async () => {
    await login();
    await startBreak();
    expect((await env.request.post(`/api/auth/logout/${env.seed.agent1}`).set(auth(G2))).status).toBe(403);
    expect(await q("select end_time from agent_breaks")).toEqual([{ end_time: null }]);
  });
});

// =================================================================== 5
describe("R5 leads created by an agent are assigned to that agent (was: unassigned)", () => {
  it("agent: lead + ACTIVE assignment (no team), visible in their list, not counted unassigned", async () => {
    const res = await env.request.post("/api/leads").set(auth(G1)).send({ fullName: "Walk-in", phone: "9222222222" });
    expect(res.status).toBe(200);
    expect(await assignments(res.body.id)).toEqual([{ agent_id: env.seed.agent1, team_id: null, status: "ACTIVE" }]);
    expect((await env.request.get(`/api/leads/${res.body.id}`).set(auth(G1))).status).toBe(200);
    expect((await env.request.get(`/api/leads/${res.body.id}`).set(auth(G2))).status).toBe(404);
    expect((await env.request.get("/api/dashboard/summary").set(auth(A))).body.unassignedLeads).toBe(1);
  });
  it.each([["ADMIN"], ["MANAGER"]])("%s-created leads stay unassigned", async (role) => {
    const res = await env.request.post("/api/leads").set(auth(role === "ADMIN" ? A : M)).send({ fullName: "Office", phone: "9333333333" });
    expect(await assignments(res.body.id)).toEqual([]);
  });
  it("a rejected create (duplicate phone) creates no assignment", async () => {
    const before = (await q("select count(*)::int n from lead_assignments"))[0].n;
    expect((await env.request.post("/api/leads").set(auth(G1)).send({ fullName: "Dup", phone: "9000000001" })).status).toBe(400);
    expect((await q("select count(*)::int n from lead_assignments"))[0].n).toBe(before);
  });
  it("the agent can immediately work the lead (call log, follow-up)", async () => {
    const lead = (await env.request.post("/api/leads").set(auth(G1)).send({ fullName: "Walk-in", phone: "9444444444" })).body;
    expect((await env.request.post("/api/call-logs").set(auth(G1)).send({ leadId: lead.id, callStartTime: "2026-10-17T10:05" })).status).toBe(200);
    expect((await env.request.post("/api/follow-ups").set(auth(G1)).send({ leadId: lead.id, followUpDate: "2026-10-18T10:00" })).status).toBe(200);
  });
});

// =================================================================== 6
describe("R6 updated_at reflects real modifications (was: never changed)", () => {
  const leadUpdated = async (id: number) => (await q("select updated_at::text u from leads where id = $1", [id]))[0].u as string;
  const pause = () => new Promise((r) => setTimeout(r, 15));

  it("lead edits, status changes, call outcomes, follow-up creation and reopen bump updated_at", async () => {
    const steps: [string, () => Promise<unknown>, number][] = [
      ["admin edit", () => env.request.put(`/api/leads/${env.seed.leadA}`).set(auth(A)).send({ fullName: "A2", phone: "9000000001" }), env.seed.leadA],
      ["status endpoint", () => env.request.put(`/api/leads/${env.seed.leadA}/status`).set(json(M)).send('"CONTACTED"'), env.seed.leadA],
      ["details form", () => env.request.put(`/api/agent/leads/${env.seed.leadB}/details`).set(auth(G1)).send({ fullName: "B2", phone: "9000000002" }), env.seed.leadB],
      ["call outcome", () => env.request.post("/api/call-logs").set(auth(G1)).send({ leadId: env.seed.leadB, callStartTime: "2026-10-17T10:00", callOutcome: "INTERESTED" }), env.seed.leadB],
      ["follow-up", () => env.request.post("/api/follow-ups").set(auth(G1)).send({ leadId: env.seed.leadB, followUpDate: "2026-10-18T10:00" }), env.seed.leadB],
      ["reopen", () => env.request.put(`/api/lead-assignments/${env.seed.closedLead}/reopen`).set(auth(A)).send({ newAgentId: env.seed.agent2 }), env.seed.closedLead],
    ];
    for (const [name, act, id] of steps) {
      const before = await leadUpdated(id);
      await pause();
      await act();
      expect(await leadUpdated(id), name).not.toBe(before);
    }
  });

  it("re-saving without changes keeps updated_at (closure time is preserved)", async () => {
    await env.request.put(`/api/leads/${env.seed.leadA}/status`).set(json(M)).send('"ENROLLED"');
    const closedAt = await leadUpdated(env.seed.leadA);
    await pause();
    await env.request.put(`/api/leads/${env.seed.leadA}/status`).set(json(M)).send('"ENROLLED"');
    await env.request.put(`/api/leads/${env.seed.leadA}`).set(auth(A)).send({ fullName: "Lead A", phone: "9000000001", status: "ENROLLED", priority: "MEDIUM", leadSource: "Website" });
    expect(await leadUpdated(env.seed.leadA)).toBe(closedAt);
  });

  it("closure reporting: the closed lead's updatedAt is the closure time, not its creation time", async () => {
    await q("update leads set created_at = '2026-01-01 00:00:00', updated_at = '2026-01-01 00:00:00' where id = $1", [env.seed.leadA]);
    const res = await env.request.put(`/api/leads/${env.seed.leadA}/status`).set(json(M)).send('"LOST"');
    expect(res.body.createdAt).toBe("2026-01-01T00:00:00");
    expect(res.body.updatedAt.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10)); // stamped now (UTC wall clock)
  });

  it("courses, campaigns and follow-ups: bumped on change, unchanged on identical re-save", async () => {
    const c = (await env.request.post("/api/courses").set(auth(M)).send({ courseName: "T", durationMonths: 3 })).body;
    const camp = (await env.request.post("/api/campaigns").set(auth(M)).send({ campaignName: "K" })).body;
    const f = (await env.request.post("/api/follow-ups").set(auth(G1)).send({ leadId: env.seed.leadA, followUpDate: "2026-10-18T10:00" })).body;
    await pause();
    const cs = [
      () => env.request.put(`/api/courses/${c.id}`).set(auth(M)).send({ courseName: "T", durationMonths: 3, status: "ACTIVE" }),
      () => env.request.put(`/api/campaigns/${camp.id}`).set(auth(M)).send({ campaignName: "K", status: "DRAFT" }),
      () => env.request.put(`/api/follow-ups/${f.id}`).set(auth(G1)).send({ leadId: env.seed.leadA, followUpDate: "2026-10-18T10:00", status: "PENDING" }),
    ];
    const same = await Promise.all(cs.map((x) => x()));
    expect(same[0]!.body.updatedAt).toBe(c.updatedAt);
    expect(same[1]!.body.updatedAt).toBe(camp.updatedAt);
    expect(same[2]!.body.updatedAt).toBe(f.updatedAt);
    await pause();
    const changed = [
      await env.request.put(`/api/courses/${c.id}`).set(auth(M)).send({ courseName: "T2", durationMonths: 3 }),
      await env.request.put(`/api/campaigns/${camp.id}`).set(auth(M)).send({ campaignName: "K", status: "ACTIVE" }),
      await env.request.put(`/api/follow-ups/${f.id}/status?status=COMPLETED`).set(auth(G1)),
    ];
    expect(changed[0]!.body.updatedAt).not.toBe(c.updatedAt);
    expect(changed[1]!.body.updatedAt).not.toBe(camp.updatedAt);
    expect(changed[2]!.body.updatedAt).not.toBe(f.updatedAt);
  });

  it("scheduler MISSED and campaign deletion stamp the rows they modify", async () => {
    const [{ id }] = await q("insert into follow_ups (lead_id, agent_id, follow_up_date, status, updated_at) values ($1,$2,'2026-10-16 10:00','PENDING','2026-01-01') returning id",
      [env.seed.leadA, env.seed.agent1]);
    await runFollowUpReminders(env.ctx.db, env.clock);
    expect((await q("select updated_at::text u from follow_ups where id = $1", [id]))[0].u).not.toBe("2026-01-01 00:00:00");
    const [{ id: camp }] = await q("insert into campaigns (campaign_name) values ('X') returning id");
    await q("update leads set campaign_id = $1, updated_at = '2026-01-01' where id = $2", [camp, env.seed.leadB]);
    await env.request.delete(`/api/campaigns/${camp}`).set(auth(M));
    expect(await leadUpdated(env.seed.leadB)).not.toBe("2026-01-01 00:00:00");
  });
});

// =================================================================== 7
describe("R7 only admins and managers can change a lead's phone number (approved 2026-10-21)", () => {
  const phone = async (id: number) => (await q("select phone from leads where id = $1", [id]))[0].phone;
  const details = (t: string, id: number, p: string) =>
    env.request.put(`/api/agent/leads/${id}/details`).set(auth(t)).send({ fullName: "Lead A", phone: p, city: "Pune" });

  it("agent: a different phone is rejected (403) and nothing is saved", async () => {
    const res = await details(G1, env.seed.leadA, "9111111111");
    expect([res.status, res.body]).toEqual([403, { error: "Only admins and managers can change a lead's phone number" }]);
    expect(await phone(env.seed.leadA)).toBe("9000000001");
    expect(await q("select city from leads where id = $1", [env.seed.leadA])).toEqual([{ city: null }]);
  });

  it("agent: re-sending the stored phone (what the read-only form does) saves the other fields", async () => {
    const res = await details(G1, env.seed.leadA, "9000000001");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ phone: "9000000001", city: "Pune" });
  });

  it("agent save cannot overwrite a phone an admin changed in the meantime", async () => {
    // The agent's form still holds the old number; the admin changes it first.
    await env.request.put(`/api/leads/${env.seed.leadA}`).set(auth(A)).send({ fullName: "Lead A", phone: "9555555555" });
    expect((await details(G1, env.seed.leadA, "9000000001")).status).toBe(403);
    expect(await phone(env.seed.leadA)).toBe("9555555555");
  });

  it("admin and manager can change it (edit form and details form)", async () => {
    expect((await env.request.put(`/api/leads/${env.seed.leadA}`).set(auth(M)).send({ fullName: "Lead A", phone: "9666666666" })).body.phone).toBe("9666666666");
    expect((await details(A, env.seed.leadA, "9777777777")).body.phone).toBe("9777777777");
  });

  it("agents still cannot use the admin edit endpoint, and agent-created leads take the phone given at creation", async () => {
    expect((await env.request.put(`/api/leads/${env.seed.leadA}`).set(auth(G1)).send({ fullName: "Lead A", phone: "9888888888" })).status).toBe(403);
    const created = await env.request.post("/api/leads").set(auth(G1)).send({ fullName: "New", phone: "9999999999" });
    expect(created.body.phone).toBe("9999999999");
  });
});
