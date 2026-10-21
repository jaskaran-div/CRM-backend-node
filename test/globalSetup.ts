// Starts one disposable PostgreSQL 17 for the whole test run and loads the production-shaped schema.
import EmbeddedPostgres from "embedded-postgres";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import type { TestProject } from "vitest/node";

let server: EmbeddedPostgres | undefined;

export default async function setup(project: TestProject) {
  const dir = join(process.cwd(), ".pg-test");
  rmSync(dir, { recursive: true, force: true });
  const port = 54329;
  server = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "test", port, persistent: false,
    onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  await server.createDatabase("crm_test");

  const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "test", database: "crm_test" });
  await client.connect();
  await client.query("set timezone = 'UTC'");
  await client.query("alter database crm_test set timezone to 'UTC'");
  await client.query(readFileSync(join(process.cwd(), "test", "schema.sql"), "utf8"));
  await client.end();

  project.provide("pgPort", port);
  return async () => {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    pgPort: number;
  }
}
