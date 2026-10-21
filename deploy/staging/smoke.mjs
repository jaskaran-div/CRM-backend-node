// Staging smoke test: exercises the release end-to-end against the STAGING API (synthetic data).
// Refuses to run against anything except a loopback staging port. Writes only to staging.
// Usage: STAGING_USER_PASSWORD=... node smoke.mjs http://127.0.0.1:8082
const base = process.argv[2] ?? "http://127.0.0.1:8082";
if (!/^http:\/\/(127\.0\.0\.1|localhost):(8082|18082)$/.test(base)) {
  console.error(`refusing: ${base} is not the loopback staging API`);
  process.exit(2);
}
const pw = process.env.STAGING_USER_PASSWORD;
if (!pw) { console.error("STAGING_USER_PASSWORD is required"); process.exit(2); }

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + detail}`); if (!ok) failed++; };
async function call(method, path, token, body) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
const login = async (email) => (await call("POST", "/api/auth/login", null, { email, password: pw })).body;

const health = await call("GET", "/api/health");
check("health", health.status === 200 && health.body?.status === "UP", JSON.stringify(health));
check("unauthenticated -> 401", (await call("GET", "/api/leads")).status === 401);
check("bad password -> 401", (await call("POST", "/api/auth/login", null, { email: "admin@staging.test", password: "wrong" })).status === 401);

const admin = await login("admin@staging.test");
const agent = await login("agent1@staging.test");
const agent2 = await login("agent2@staging.test");
check("logins", !!admin?.token && !!agent?.token && !!agent2?.token);
const A = admin.token, G = agent.token;

const dash = await call("GET", "/api/dashboard/summary", A);
check("admin dashboard", dash.status === 200 && dash.body.totalLeads >= 40, JSON.stringify(dash.body).slice(0, 120));
const myLeads = await call("GET", "/api/leads", G);
check("agent sees only own leads", myLeads.status === 200 && myLeads.body.length === 12, `got ${myLeads.body?.length}`);
check("agent cannot read admin attendance", (await call("GET", "/api/admin/attendance", G)).status === 403);
check("agent users list has no email/phone", !("email" in ((await call("GET", "/api/users", G)).body[0] ?? {})));

// Rule 5: agent-created lead is assigned to the agent
const phone = "97" + String(Date.now()).slice(-8);
const created = await call("POST", "/api/leads", G, { fullName: "Smoke Walk-in", phone });
check("R5 agent create", created.status === 200, JSON.stringify(created.body));
check("R5 visible to creator", (await call("GET", `/api/leads/${created.body.id}`, G)).status === 200);
check("R5 hidden from other agent", (await call("GET", `/api/leads/${created.body.id}`, agent2.token)).status === 404);

// Rule 7: agents cannot change phone; admin can
const lead = myLeads.body[0];
const p7 = await call("PUT", `/api/agent/leads/${lead.id}/details`, G, { fullName: lead.fullName, phone: "9111100000" });
check("R7 agent phone change -> 403", p7.status === 403, JSON.stringify(p7.body));
check("R7 agent save with stored phone", (await call("PUT", `/api/agent/leads/${lead.id}/details`, G, { fullName: lead.fullName, phone: lead.phone, city: "Smoke City" })).status === 200);

// Rule 2: admin edit without campaignId keeps campaign
const withCampaign = (await call("GET", "/api/leads", A)).body.find((l) => l.campaignId != null);
const e2 = await call("PUT", `/api/leads/${withCampaign.id}`, A, { fullName: withCampaign.fullName, phone: withCampaign.phone, city: "Pune" });
check("R2 campaign kept on edit", e2.body?.campaignId === withCampaign.campaignId, JSON.stringify(e2.body).slice(0, 120));

// Rule 1 + 6: closing via details form releases assignment and stamps updatedAt
const closeLead = myLeads.body[1];
const c1 = await call("PUT", `/api/agent/leads/${closeLead.id}/details`, G, { fullName: closeLead.fullName, phone: closeLead.phone, status: "NOT_INTERESTED" });
check("R1 close via details form", c1.status === 200 && c1.body.status === "NOT_INTERESTED");
check("R6 updatedAt changed", c1.body.updatedAt !== closeLead.updatedAt);
const act = await call("GET", `/api/lead-assignments/lead/${closeLead.id}/active`, A);
check("R1 assignment released", act.status === 404, `active assignment status ${act.status}`);

// Rule 3: overdue follow-up (seeded 1 h ago) is listed and still PENDING; 2-day-old one is MISSED (scheduler on)
const overdue = await call("GET", "/api/follow-ups/overdue", A);
check("R3 overdue listed (PENDING)", overdue.status === 200 && overdue.body.some((f) => f.purpose === "Callback" && f.status === "PENDING"), JSON.stringify(overdue.body).slice(0, 160));
const missed = await call("GET", "/api/follow-ups/status/MISSED", A);
check("R3 previous-day follow-up MISSED", missed.body.some((f) => f.purpose === "Old callback"), "scheduler may need one more minute");

// Rule 4: logout ends an active break
await call("POST", "/api/attendance/break/end", G, { agentId: agent.id }); // clean state from earlier runs
const b = await call("POST", "/api/attendance/break/start", G, { agentId: agent.id, breakType: "BIO" });
check("R4 break started", b.status === 200, JSON.stringify(b.body));
check("R4 logout", (await call("POST", `/api/auth/logout/${agent.id}`, G)).status === 200);
check("R4 no active break after logout", (await call("GET", `/api/attendance/break/active?agentId=${agent.id}`, A)).body === null);

// Session expiry contract the frontend relies on
check("expired/invalid token -> 401", (await call("GET", "/api/leads", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4IiwiZXhwIjoxfQ.x")).status === 401);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
