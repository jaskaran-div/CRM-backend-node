import type pg from "pg";
import type { Logger } from "pino";
import type { UserCache } from "./auth/middleware.js";
import type { JwtService } from "./auth/jwt.js";
import type { Config } from "./config.js";
import type { Db } from "./db/pool.js";
import type { Clock } from "./lib/time.js";

export interface AppContext {
  config: Config;
  pool: pg.Pool;
  db: Db;
  jwt: JwtService;
  userCache: UserCache;
  logger: Logger;
  clock: Clock;
}
