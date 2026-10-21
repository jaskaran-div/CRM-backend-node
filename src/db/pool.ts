import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Config } from "../config.js";
import { parseDbUrl } from "../config.js";
import * as schema from "./schema.js";

// Type parsers (process-wide):
//  * int8 -> number. All ids/counts in this schema are far below 2^53.
//  * timestamp / timestamptz / date -> raw text. Values are naive IST or UTC wall-clock strings and
//    must never pass through JS Date (which would apply the process timezone). They are converted
//    to the Jackson wire format in lib/time.ts.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (v) => v);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v) => v);
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export type Db = NodePgDatabase<typeof schema>;

/**
 * Connection-slot exhaustion reported while OPENING a connection (no SQL has been sent yet, so a
 * retry can never run a statement twice):
 *  - 53300 too_many_connections (role CONNECTION LIMIT or max_connections)
 *  - Supavisor session mode: "(EMAXCONNSESSION) max clients reached in session mode - max clients
 *    are limited to pool_size: 15" — the pooler allows 15 server connections per role, shared by
 *    every process using that role (e.g. Spring's Hikari pool during the parallel run).
 */
export function isConnectionSaturation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  return e?.code === "53300" || /EMAXCONNSESSION|max clients reached|too many connections/i.test(e?.message ?? "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ConnectCallback = (err: Error | undefined, client?: pg.PoolClient, done?: (release?: unknown) => void) => void;

/** pg.Pool that waits and retries when the database refuses a new connection for lack of slots. */
export class ResilientPool extends pg.Pool {
  retries = 0; // observable for logs/tests

  constructor(config: pg.PoolConfig, private readonly maxAttempts = 6) {
    super(config);
  }

  override connect(): Promise<pg.PoolClient>;
  override connect(cb: ConnectCallback): void;
  override connect(cb?: ConnectCallback): Promise<pg.PoolClient> | void {
    const p = this.connectWithRetry();
    if (!cb) return p;
    p.then((client) => cb(undefined, client, (release) => client.release(release as Error | boolean | undefined)), (err) => cb(err));
  }

  private async connectWithRetry(): Promise<pg.PoolClient> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await super.connect();
      } catch (err) {
        if (!isConnectionSaturation(err) || attempt >= this.maxAttempts) throw err;
        this.retries++;
        // 100, 200, 400, 800, 1000 ms (+ jitter): total wait ≤ ~2.6 s before giving up.
        await sleep(Math.min(100 * 2 ** (attempt - 1), 1000) + Math.random() * 50);
      }
    }
  }
}

export function createPool(config: Config): ResilientPool {
  const conn = parseDbUrl(config.DB_URL, config.DB_USERNAME, config.DB_PASSWORD);
  const pool = new ResilientPool({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    password: conn.password,
    // Supabase requires TLS. The pooler presents a certificate not chained to the system store,
    // matching what the Spring JDBC driver accepts today (sslmode=require semantics).
    ssl: config.DB_SSL === "require" ? { rejectUnauthorized: false } : false,
    max: config.DB_POOL_MAX,
    // Keep every connection warm: opening one costs ~0.9 s from Sydney (measured), which showed up
    // as p95 spikes while the pool grew. The slots count against the 15-per-role budget either way.
    min: config.DB_POOL_MAX,
    idleTimeoutMillis: 300_000,
    connectionTimeoutMillis: 20_000,
    keepAlive: true,
    maxLifetimeSeconds: 1200,
    // The Supabase pooler ignores libpq startup parameters (`options`, `statement_timeout`), so the
    // timeout is enforced client-side. DB-defaulted timestamps rely on the database TimeZone, which
    // is UTC (verified at startup in checkDatabase) — the same values Spring has been writing.
    query_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    application_name: "derivion-crm-node",
  });
  return pool;
}

export async function checkDatabase(pool: pg.Pool): Promise<{ timeZone: string; readOnly: boolean }> {
  const { rows } = await pool.query<{ tz: string; ro: string }>(
    "select current_setting('TimeZone') tz, current_setting('transaction_read_only') ro",
  );
  const row = rows[0]!;
  return { timeZone: row.tz, readOnly: row.ro === "on" };
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}
