// Staging database: a user-space PostgreSQL 17 (embedded-postgres) on 127.0.0.1, separate from
// production. Holds the production-shaped schema and SYNTHETIC data only.
//
//   node staging-db.mjs init   create data dir, schema and seed (refuses if it already exists)
//   node staging-db.mjs run    start the server and keep running (use under nohup/setsid)
//   node staging-db.mjs reset  delete the staging data dir (staging only)
//
// Env: STAGING_DIR (default ~/staging), STAGING_PG_PORT (55433), STAGING_PG_PASSWORD (required),
//      STAGING_USER_PASSWORD (required for init: password of the seeded staging accounts).
import EmbeddedPostgres from "embedded-postgres";
import bcrypt from "bcryptjs";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const cmd = process.argv[2];
const base = process.env.STAGING_DIR ?? join(homedir(), "staging");
const dataDir = join(base, "pgdata");
const port = Number(process.env.STAGING_PG_PORT ?? 55433);
const password = process.env.STAGING_PG_PASSWORD;
if (!password || password.length < 16) {
  console.error("STAGING_PG_PASSWORD (>= 16 chars) is required");
  process.exit(1);
}
const server = new EmbeddedPostgres({ databaseDir: dataDir, user: "postgres", password, port, persistent: true, onLog: () => {} });
const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

if (cmd === "init") {
  const userPassword = process.env.STAGING_USER_PASSWORD;
  if (!userPassword || userPassword.length < 8) throw new Error("STAGING_USER_PASSWORD (>= 8 chars) is required for init");
  if (existsSync(dataDir)) throw new Error(`${dataDir} already exists; use reset first`);
  await server.initialise();
  await server.start();
  await server.createDatabase("crm_staging");
  const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password, database: "crm_staging" });
  await c.connect();
  await c.query("alter database crm_staging set timezone to 'UTC'");
  await c.query(readFileSync(join(here, "schema.sql"), "utf8"));
  const hash = (await bcrypt.hash(userPassword, 10)).replace(/^\$2b\$/, "$2a$");
  await c.query(readFileSync(join(here, "seed.sql"), "utf8").replaceAll(":'pw_hash'", () => `'${hash}'`)); // function form: "$" in the hash is literal
  const counts = (await c.query("select (select count(*) from users)::int users, (select count(*) from leads)::int leads, (select count(*) from lead_assignments)::int assignments")).rows[0];
  await c.end();
  await server.stop();
  console.log(`staging database initialised at ${dataDir}:`, JSON.stringify(counts));
} else if (cmd === "run") {
  await server.start();
  console.log(`staging postgres listening on 127.0.0.1:${port}`);
  const stop = async () => { await server.stop().catch(() => {}); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  setInterval(() => {}, 1 << 30);
} else if (cmd === "reset") {
  if (!dataDir.includes("staging")) throw new Error("refusing to delete a non-staging path");
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`removed ${dataDir}`);
} else {
  console.error("usage: node staging-db.mjs init|run|reset");
  process.exit(1);
}
