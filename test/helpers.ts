import bcrypt from "bcryptjs";
import { pino } from "pino";
import pg from "pg";
import supertest from "supertest";
import { inject } from "vitest";
import { createApp } from "../src/app.js";
import { JwtService } from "../src/auth/jwt.js";
import { UserCache } from "../src/auth/middleware.js";
import { loadConfig } from "../src/config.js";
import type { AppContext } from "../src/context.js";
import { createDb, createPool } from "../src/db/pool.js";
import type { Clock } from "../src/lib/time.js";

export const JWT_SECRET = "test-secret-that-is-at-least-32-bytes-long!!";
export const PASSWORD = "Passw0rd!";

/** Mutable clock. Default: 2026-10-17 10:00:00 IST (04:30 UTC). */
export class TestClock implements Clock {
  constructor(public ms = Date.UTC(2026, 9, 17, 4, 30, 0)) {}
  now() {
    return this.ms;
  }
  /** Set the clock to an IST wall-clock time, e.g. "2026-10-17T00:30:00". */
  setIst(local: string) {
    this.ms = Date.parse(local + "Z") - 5.5 * 3600_000;
  }
  advance(seconds: number) {
    this.ms += seconds * 1000;
  }
}

export interface Seed {
  admin: number; manager: number; agent1: number; agent2: number; inactiveAgent: number;
  team: number; inactiveTeam: number;
  leadA: number; leadB: number; leadC: number; closedLead: number; unassignedLead: number;
}

export interface TestEnv {
  ctx: AppContext;
  clock: TestClock;
  request: supertest.Agent;
  pool: pg.Pool;
  token(userId: number): string;
  seed: Seed;
  close(): Promise<void>;
}

let hashCache: string | undefined;

export async function createTestEnv(): Promise<TestEnv> {
  const port = inject("pgPort");
  const config = loadConfig({
    NODE_ENV: "test",
    DB_URL: `postgres://127.0.0.1:${port}/crm_test`,
    DB_USERNAME: "postgres",
    DB_PASSWORD: "test",
    DB_SSL: "disable",
    DB_POOL_MAX: "4",
    JWT_SECRET,
    USER_CACHE_TTL_MS: "0",
    LOGIN_RATE_LIMIT_PER_15MIN: "1000",
    BCRYPT_COST: "10",
    LOG_LEVEL: "silent",
  });
  const pool = createPool(config);
  const db = createDb(pool);
  const clock = new TestClock();
  const jwt = new JwtService(JWT_SECRET, config.JWT_EXPIRATION_MS);
  const ctx: AppContext = { config, pool, db, jwt, clock, userCache: new UserCache(db, 0), logger: pino({ level: "silent" }) };
  const app = createApp(ctx);
  const seed = await resetAndSeed(pool);
  const emails = new Map<number, string>();
  const { rows } = await pool.query<{ id: number; email: string; role: string }>("select id, email, role from users");
  for (const r of rows) emails.set(r.id, r.email);
  const roles = new Map(rows.map((r) => [r.id, r.role]));
  return {
    ctx, clock, pool, seed,
    request: supertest.agent(app),
    token: (id) => jwt.generateToken(emails.get(id)!, roles.get(id)!),
    close: () => pool.end(),
  };
}

export async function resetAndSeed(pool: pg.Pool): Promise<Seed> {
  await pool.query(`truncate users, teams, courses, campaigns, leads, lead_assignments, follow_ups, call_logs, notes,
    notifications, agent_attendance, agent_breaks, lead_view_activities restart identity cascade`);
  hashCache ??= await bcrypt.hash(PASSWORD, 4);
  const h = hashCache.replace(/^\$2b\$/, "$2a$");
  const u = async (name: string, email: string, role: string, status = "ACTIVE") =>
    (await pool.query<{ id: number }>("insert into users (full_name, email, phone, password, role, status) values ($1,$2,'9876543210',$3,$4,$5) returning id",
      [name, email, h, role, status])).rows[0]!.id;
  const admin = await u("Admin User", "admin@crm.test", "ADMIN");
  const manager = await u("Manager User", "manager@crm.test", "MANAGER");
  const agent1 = await u("Agent One", "agent1@crm.test", "AGENT");
  const agent2 = await u("Agent Two", "agent2@crm.test", "AGENT");
  const inactiveAgent = await u("Agent Gone", "gone@crm.test", "AGENT", "INACTIVE");
  const team = (await pool.query<{ id: number }>("insert into teams (team_name, status) values ('Alpha','ACTIVE') returning id")).rows[0]!.id;
  const inactiveTeam = (await pool.query<{ id: number }>("insert into teams (team_name, status) values ('Old','INACTIVE') returning id")).rows[0]!.id;
  const lead = async (name: string, phone: string, status = "NEW", source: string | null = "Website") =>
    (await pool.query<{ id: number }>("insert into leads (full_name, phone, status, priority, lead_source) values ($1,$2,$3,'MEDIUM',$4) returning id",
      [name, phone, status, source])).rows[0]!.id;
  const leadA = await lead("Lead A", "9000000001");
  const leadB = await lead("Lead B", "9000000002");
  const leadC = await lead("Lead C", "9000000003", "NEW", " Referral ");
  const closedLead = await lead("Lead Closed", "9000000004", "ENROLLED");
  const unassignedLead = await lead("Lead Free", "9000000005", "NEW", null);
  const assign = (leadId: number, agentId: number, status = "ACTIVE") =>
    pool.query("insert into lead_assignments (lead_id, agent_id, team_id, status) values ($1,$2,$3,$4)", [leadId, agentId, team, status]);
  await assign(leadA, agent1);
  await assign(leadB, agent1);
  await assign(leadC, agent2);
  await assign(closedLead, agent1, "INACTIVE");
  return { admin, manager, agent1, agent2, inactiveAgent, team, inactiveTeam, leadA, leadB, leadC, closedLead, unassignedLead };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
