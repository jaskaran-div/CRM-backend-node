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

export function createPool(config: Config): pg.Pool {
  const conn = parseDbUrl(config.DB_URL, config.DB_USERNAME, config.DB_PASSWORD);
  const pool = new pg.Pool({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    password: conn.password,
    // Supabase requires TLS. The pooler presents a certificate not chained to the system store,
    // matching what the Spring JDBC driver accepts today (sslmode=require semantics).
    ssl: config.DB_SSL === "require" ? { rejectUnauthorized: false } : false,
    max: config.DB_POOL_MAX,
    // Keep connections warm: a new connection costs ~0.9 s from Sydney (measured).
    min: Math.min(2, config.DB_POOL_MAX),
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
