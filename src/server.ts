import "dotenv/config";
import { pino } from "pino";
import { loadConfig } from "./config.js";
import { checkDatabase, createDb, createPool } from "./db/pool.js";
import { JwtService } from "./auth/jwt.js";
import { UserCache } from "./auth/middleware.js";
import { createApp } from "./app.js";
import { startFollowUpScheduler } from "./jobs/followUpReminders.js";
import { systemClock } from "./lib/time.js";
import type { AppContext } from "./context.js";

async function main() {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL, base: { service: "derivion-crm-node" } });
  const pool = createPool(config);
  pool.on("error", (err) => logger.error({ err }, "idle database client error"));
  const db = createDb(pool);
  // Surface connection-slot waits (pooler/role saturation) without logging per request.
  let reportedRetries = 0;
  setInterval(() => {
    if (pool.retries > reportedRetries) {
      logger.warn({ retries: pool.retries - reportedRetries, poolMax: config.DB_POOL_MAX }, "waited for database connection slots");
      reportedRetries = pool.retries;
    }
  }, 60_000).unref();

  const t0 = Date.now();
  const dbInfo = await checkDatabase(pool);
  logger.info({ ms: Date.now() - t0, ...dbInfo, poolMax: config.DB_POOL_MAX }, "database reachable");
  if (dbInfo.timeZone !== "UTC") logger.warn({ timeZone: dbInfo.timeZone }, "database TimeZone is not UTC; DB-defaulted timestamps will differ from Spring's");

  const ctx: AppContext = {
    config, pool, db, logger, clock: systemClock,
    jwt: new JwtService(config.JWT_SECRET, config.JWT_EXPIRATION_MS),
    userCache: new UserCache(db, config.USER_CACHE_TTL_MS),
  };

  const stopScheduler = config.SCHEDULER_ENABLED === "true" ? startFollowUpScheduler(db, ctx.clock, logger) : () => {};
  logger.info({ scheduler: config.SCHEDULER_ENABLED === "true" }, "follow-up scheduler");

  const server = createApp(ctx).listen(config.PORT, config.HOST, () => {
    logger.info({ host: config.HOST, port: config.PORT }, "listening");
  });
  server.keepAliveTimeout = 65_000; // > Nginx upstream keepalive

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, "shutting down");
    stopScheduler();
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 25_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  // Configuration errors list variable names only.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
