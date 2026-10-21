import { z } from "zod";

// All configuration comes from the environment. The service refuses to start on missing or
// weak secrets rather than falling back to defaults.
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8081),

  // Same variables the Spring service reads. DB_URL may be the JDBC form
  // (jdbc:postgresql://host:port/db?...) or a plain postgres:// URL.
  DB_URL: z.string().min(1),
  DB_USERNAME: z.string().min(1).optional(),
  DB_PASSWORD: z.string().min(1).optional(),
  // Supabase session pooler: 15 server connections per role, shared with any other process using
  // the same role (live Spring Hikari = 10 during the parallel run). 5 keeps the sum within 15.
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  DB_SSL: z.enum(["require", "disable"]).default("require"),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 bytes (HS256 minimum)"),
  JWT_EXPIRATION_MS: z.coerce.number().int().positive().default(8 * 60 * 60 * 1000),

  // Comma-separated allowlist. Empty = no cross-origin access (same-origin via Nginx).
  CORS_ORIGINS: z.string().default(""),

  // Only one backend may run the follow-up scheduler (it writes). Off by default so a shadow
  // instance never duplicates work; the advisory lock is a second guard.
  SCHEDULER_ENABLED: z.enum(["true", "false"]).default("false"),

  LOGIN_RATE_LIMIT_PER_15MIN: z.coerce.number().int().positive().default(20),
  USER_CACHE_TTL_MS: z.coerce.number().int().min(0).default(30_000),
  BCRYPT_COST: z.coerce.number().int().min(10).max(14).default(10),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Report variable names only, never values.
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return parsed.data;
}

export interface PgConnection {
  host: string;
  port: number;
  database: string;
  user?: string;
  password?: string;
  params: URLSearchParams;
}

// Accepts jdbc:postgresql://host[:port]/db[?k=v] or postgres(ql)://[user[:pass]@]host[:port]/db[?k=v].
export function parseDbUrl(raw: string, user?: string, password?: string): PgConnection {
  const url = new URL(raw.replace(/^jdbc:/, "").replace(/^postgresql:/, "postgres:"));
  if (url.protocol !== "postgres:") throw new Error("DB_URL must be a PostgreSQL URL");
  const params = url.searchParams;
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
    user: user ?? params.get("user") ?? (url.username ? decodeURIComponent(url.username) : undefined),
    password: password ?? params.get("password") ?? (url.password ? decodeURIComponent(url.password) : undefined),
    params,
  };
}
