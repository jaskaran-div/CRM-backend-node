import { getTableColumns, getTableName, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "./pool.js";

// Every EC2 -> database round trip costs ~140 ms (measured), while the queries themselves run in
// well under 1 ms. Endpoints therefore use as few statements as possible: reads are combined, and
// multi-row writes are expressed as one data-modifying CTE statement, which Postgres executes
// atomically without separate BEGIN/COMMIT round trips.
//
// These helpers let raw SQL return rows in the same camelCase shape (and Jackson date format) as
// Drizzle's typed queries. Identifiers come from the schema definitions, never from input.

/** `"alias"."col" AS "key", ...` for every column of a table. */
export function selectCols(table: PgTable, alias?: string): SQL {
  const prefix = alias ?? getTableName(table);
  const parts = Object.entries(getTableColumns(table)).map(([key, col]) => `"${prefix}"."${col.name}" AS "${key}"`);
  return sql.raw(parts.join(", "));
}

/** Same column list for a RETURNING clause (no table prefix). */
export function returningCols(table: PgTable): SQL {
  const parts = Object.entries(getTableColumns(table)).map(([key, col]) => `"${col.name}" AS "${key}"`);
  return sql.raw(parts.join(", "));
}

/** Apply column decoders (timestamps -> Jackson format) to a raw row selected with selectCols. */
export function mapRow<T extends PgTable>(table: T, row: Record<string, unknown>): T["$inferSelect"] {
  const out: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(getTableColumns(table))) {
    const v = row[key];
    out[key] = v == null ? null : col.mapFromDriverValue(v);
  }
  return out as T["$inferSelect"];
}

/** Decode a JSON-aggregated row (json_agg / to_jsonb) whose keys are column names. */
export function mapJsonRow<T extends PgTable>(table: T, row: Record<string, unknown>): T["$inferSelect"] {
  const out: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(getTableColumns(table))) {
    const v = row[col.name];
    out[key] = v == null ? null : col.mapFromDriverValue(v);
  }
  return out as T["$inferSelect"];
}

export async function rows<R = Record<string, unknown>>(db: Db, query: SQL): Promise<R[]> {
  const result = await db.execute(query);
  return result.rows as R[];
}

export async function one<R = Record<string, unknown>>(db: Db, query: SQL): Promise<R | undefined> {
  return (await rows<R>(db, query))[0];
}
