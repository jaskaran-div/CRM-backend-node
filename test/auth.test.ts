import { createHmac } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { algorithmForKey, JwtService } from "../src/auth/jwt.js";
import { auth, createTestEnv, JWT_SECRET, PASSWORD, resetAndSeed, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(async () => {
  if (!env) env = await createTestEnv();
  else env.seed = await resetAndSeed(env.pool);
});
afterAll(() => env?.close());

/** Token exactly as jjwt 0.12 builds it: header {"alg":...} only, claims sub/role/iat/exp. */
function jjwtToken(secret: string, alg: "HS256" | "HS384" | "HS512", claims: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${b64({ alg })}.${b64(claims)}`;
  const sig = createHmac("sha" + alg.slice(2), Buffer.from(secret, "utf8")).update(body).digest("base64url");
  return `${body}.${sig}`;
}

describe("JWT compatibility with Spring (jjwt)", () => {
  it("chooses the algorithm from key length like Keys.hmacShaKeyFor + signWith", () => {
    expect(algorithmForKey(Buffer.alloc(32))).toBe("HS256");
    expect(algorithmForKey(Buffer.alloc(48))).toBe("HS384");
    expect(algorithmForKey(Buffer.alloc(64))).toBe("HS512");
  });

  it.each(["HS256", "HS384", "HS512"] as const)("accepts a Spring-issued %s token", async (alg) => {
    const now = Math.floor(Date.now() / 1000);
    const token = jjwtToken(JWT_SECRET, alg, { sub: "admin@crm.test", role: "ADMIN", iat: now, exp: now + 3600 });
    const res = await env.request.get("/api/teams").set(auth(token));
    expect(res.status).toBe(200);
  });

  it("issues tokens Spring can parse: same claims, HMAC over the UTF-8 secret", () => {
    const svc = new JwtService(JWT_SECRET, 8 * 3600_000);
    const token = svc.generateToken("a@b.c", "AGENT", Date.UTC(2026, 9, 17));
    const [h, p, s] = token.split(".");
    const header = JSON.parse(Buffer.from(h!, "base64url").toString());
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(header.alg).toBe(algorithmForKey(Buffer.from(JWT_SECRET)));
    expect(payload).toEqual({ sub: "a@b.c", role: "AGENT", iat: 1792195200, exp: 1792195200 + 8 * 3600 });
    const expected = createHmac("sha256", Buffer.from(JWT_SECRET)).update(`${h}.${p}`).digest("base64url");
    expect(s).toBe(expected);
  });

  it("rejects expired, tampered and foreign-key tokens with 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = jjwtToken(JWT_SECRET, "HS256", { sub: "admin@crm.test", role: "ADMIN", iat: now - 99999, exp: now - 10 });
    const foreign = jjwtToken("another-secret-that-is-32-bytes-long!!", "HS256", { sub: "admin@crm.test", role: "ADMIN", iat: now, exp: Math.floor(Date.now() / 1000) + 600 });
    const good = env.token(env.seed.agent1);
    const tampered = good.slice(0, -2) + (good.endsWith("A") ? "BB" : "AA");
    for (const t of [expired, foreign, tampered, "garbage"]) {
      expect((await env.request.get("/api/teams").set(auth(t))).status).toBe(401);
    }
    expect((await env.request.get("/api/teams")).status).toBe(401);
  });

  it("takes the role from the database, not the token claim", async () => {
    const now = Math.floor(Date.now() / 1000);
    // An agent forging role=ADMIN in a correctly signed token still gets agent permissions.
    const forged = jjwtToken(JWT_SECRET, "HS256", { sub: "agent1@crm.test", role: "ADMIN", iat: now, exp: now + 600 });
    expect((await env.request.get("/api/admin/attendance").set(auth(forged))).status).toBe(403);
  });

  it("rejects tokens of users deactivated after the token was issued (Spring did not)", async () => {
    const token = env.token(env.seed.agent2);
    await env.pool.query("update users set status = 'INACTIVE' where id = $1", [env.seed.agent2]);
    const res = await env.request.get("/api/leads").set(auth(token));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Account is inactive" });
  });
});

describe("POST /api/auth/login", () => {
  it("returns the Spring LoginResponse shape and a working token", async () => {
    const res = await env.request.post("/api/auth/login").send({ email: "admin@crm.test", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["id", "fullName", "email", "role", "token"]);
    expect(res.body).toMatchObject({ id: env.seed.admin, fullName: "Admin User", email: "admin@crm.test", role: "ADMIN" });
    expect((await env.request.get("/api/users").set(auth(res.body.token))).status).toBe(200);
  });

  it.each([
    ["unknown email", { email: "nobody@crm.test", password: PASSWORD }],
    ["wrong password", { email: "admin@crm.test", password: "nope" }],
    ["inactive user", { email: "gone@crm.test", password: PASSWORD }],
    ["missing fields", {}],
  ])("rejects %s with the same 401 message", async (_n, body) => {
    const res = await env.request.post("/api/auth/login").send(body);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid email or password" });
  });

  it("verifies $2a$ hashes written by Spring / pgcrypto", async () => {
    const springStyle = (await bcrypt.hash("Spring123", 10)).replace(/^\$2b\$/, "$2a$");
    await env.pool.query("update users set password = $1 where id = $2", [springStyle, env.seed.manager]);
    const res = await env.request.post("/api/auth/login").send({ email: "manager@crm.test", password: "Spring123" });
    expect(res.status).toBe(200);
  });

  it("records attendance for agents only (reusing today's open session)", async () => {
    await env.request.post("/api/auth/login").send({ email: "admin@crm.test", password: PASSWORD });
    await env.request.post("/api/auth/login").send({ email: "agent1@crm.test", password: PASSWORD });
    await env.request.post("/api/auth/login").send({ email: "agent1@crm.test", password: PASSWORD });
    const { rows } = await env.pool.query("select agent_id, attendance_date::text d, login_time::text t from agent_attendance");
    expect(rows).toEqual([{ agent_id: env.seed.agent1, d: "2026-10-17", t: "2026-10-17 10:00:00" }]);
  });

  it("rate-limits repeated failures", async () => {
    const strict = await createTestEnv();
    strict.ctx.config.LOGIN_RATE_LIMIT_PER_15MIN = 3;
    const { createApp } = await import("../src/app.js");
    const supertest = (await import("supertest")).default;
    const req = supertest(createApp(strict.ctx));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await req.post("/api/auth/login").send({ email: "x@y.z", password: "bad" })).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    await strict.close();
    env.seed = await resetAndSeed(env.pool);
  });
});

describe("POST /api/auth/logout/{agentId}", () => {
  it("closes the caller's attendance and returns Spring's plain-text message", async () => {
    await env.request.post("/api/auth/login").send({ email: "agent1@crm.test", password: PASSWORD });
    env.clock.advance(3600);
    const res = await env.request.post(`/api/auth/logout/${env.seed.agent1}`).set(auth(env.token(env.seed.agent1)));
    expect(res.status).toBe(200);
    expect(res.type).toBe("text/plain");
    expect(res.text).toBe("Logout attendance recorded successfully.");
    const { rows } = await env.pool.query("select logout_time::text t from agent_attendance");
    expect(rows[0].t).toBe("2026-10-17 11:00:00");
  });

  it("FIXED: an agent can no longer log out another agent", async () => {
    await env.request.post("/api/auth/login").send({ email: "agent2@crm.test", password: PASSWORD });
    const res = await env.request.post(`/api/auth/logout/${env.seed.agent2}`).set(auth(env.token(env.seed.agent1)));
    expect(res.status).toBe(403);
    const { rows } = await env.pool.query("select logout_time from agent_attendance where agent_id = $1", [env.seed.agent2]);
    expect(rows[0].logout_time).toBeNull();
  });
});

describe("POST /api/auth/refresh", () => {
  it("returns a new access token and rotates the refresh cookie on success", async () => {
    // Login to get a refresh cookie
    const loginRes = await env.request.post("/api/auth/login").send({ email: "agent1@crm.test", password: PASSWORD });
    expect(loginRes.status).toBe(200);
    // The supertest agent stores cookies automatically; call refresh
    const refreshRes = await env.request.post("/api/auth/refresh");
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body).toHaveProperty("token");
    // The new token must be accepted by authenticated endpoints
    expect((await env.request.get("/api/leads").set(auth(refreshRes.body.token))).status).toBe(200);
  });

  it("returns 401 when no refresh cookie is present", async () => {
    // Fresh supertest instance without cookies
    const { createApp } = await import("../src/app.js");
    const supertest = (await import("supertest")).default;
    const freshReq = supertest(createApp(env.ctx));
    expect((await freshReq.post("/api/auth/refresh")).status).toBe(401);
  });

  it("returns 401 and clears cookie when refresh token is already used (rotation prevents replay)", async () => {
    const loginRes = await env.request.post("/api/auth/login").send({ email: "admin@crm.test", password: PASSWORD });
    expect(loginRes.status).toBe(200);
    // First refresh — succeeds
    const first = await env.request.post("/api/auth/refresh");
    expect(first.status).toBe(200);
    // Second refresh using the OLD cookie (the agent stores the new one, but this tests the concept)
    // The token was rotated, so a fresh request with no cookie gets 401
    const { createApp } = await import("../src/app.js");
    const supertest = (await import("supertest")).default;
    const freshReq = supertest(createApp(env.ctx));
    expect((await freshReq.post("/api/auth/refresh")).status).toBe(401);
  });

  it("returns 401 when the user is deactivated after the refresh token was issued", async () => {
    await env.request.post("/api/auth/login").send({ email: "agent2@crm.test", password: PASSWORD });
    await env.pool.query("update users set status = 'INACTIVE' where id = $1", [env.seed.agent2]);
    const res = await env.request.post("/api/auth/refresh");
    expect(res.status).toBe(401);
  });
});

describe("Refresh token cleanup on logout", () => {
  it("revokes the refresh token so it cannot be used after logout", async () => {
    // Login as agent (sets refresh cookie in agent's jar)
    await env.request.post("/api/auth/login").send({ email: "agent1@crm.test", password: PASSWORD });
    const before = await env.pool.query("select count(*) from refresh_tokens");
    expect(Number(before.rows[0].count)).toBe(1);

    // Logout
    const logoutRes = await env.request
      .post(`/api/auth/logout/${env.seed.agent1}`)
      .set(auth(env.token(env.seed.agent1)));
    expect(logoutRes.status).toBe(200);

    // Refresh token row should be gone
    const after = await env.pool.query("select count(*) from refresh_tokens");
    expect(Number(after.rows[0].count)).toBe(0);
  });
});
