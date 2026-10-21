import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { isConnectionSaturation, ResilientPool } from "../src/db/pool.js";

// Reproduces the shadow-run failure: more clients than the role's connection slots.
// (Production: Supavisor session mode allows 15 connections per role; here a role CONNECTION LIMIT 2.)
const port = () => inject("pgPort");
let admin: pg.Client;

beforeAll(async () => {
  admin = new pg.Client({ host: "127.0.0.1", port: port(), user: "postgres", password: "test", database: "crm_test" });
  await admin.connect();
  await admin.query("do $$ begin if exists (select 1 from pg_roles where rolname = 'limited') then drop owned by limited; drop role limited; end if; end $$");
  await admin.query("create role limited login password 'x' connection limit 2");
  await admin.query("grant select on all tables in schema public to limited");
});
afterAll(async () => {
  await admin.query("do $$ begin if exists (select 1 from pg_roles where rolname = 'limited') then drop owned by limited; drop role limited; end if; end $$");
  await admin.end();
});

const cfg = () => ({ host: "127.0.0.1", port: port(), user: "limited", password: "x", database: "crm_test", max: 6, idleTimeoutMillis: 50 });
const burst = (pool: pg.Pool) =>
  Promise.allSettled(Array.from({ length: 8 }, () => pool.query("select pg_sleep(0.15), count(*) from leads")));

describe("connection saturation", () => {
  it("classifies the Postgres and Supavisor saturation errors", () => {
    expect(isConnectionSaturation({ code: "53300", message: 'too many connections for role "crm_readonly"' })).toBe(true);
    expect(isConnectionSaturation(new Error("(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15"))).toBe(true);
    expect(isConnectionSaturation({ code: "23505", message: "duplicate key" })).toBe(false);
  });

  it("a plain pg.Pool fails requests when slots run out (the observed 500s)", async () => {
    const pool = new pg.Pool(cfg());
    const results = await burst(pool);
    await pool.end();
    expect(results.filter((r) => r.status === "rejected").length).toBeGreaterThan(0);
  });

  it("ResilientPool waits for a free slot and completes every request", async () => {
    const pool = new ResilientPool(cfg());
    const results = await burst(pool);
    await pool.end();
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(pool.retries).toBeGreaterThan(0);
  });

  it("does not retry non-saturation errors", async () => {
    const pool = new ResilientPool({ ...cfg(), password: "wrong" });
    await expect(pool.query("select 1")).rejects.toThrow(/password/);
    expect(pool.retries).toBe(0);
    await pool.end();
  });
});
