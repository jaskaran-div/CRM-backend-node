import type { RequestHandler } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "../db/pool.js";
import { users } from "../db/schema.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import type { Role } from "../lib/enums.js";
import type { JwtService } from "./jwt.js";

export interface CurrentUser {
  id: number;
  email: string;
  fullName: string;
  role: Role;
  status: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: CurrentUser;
    }
  }
}

/**
 * Short-TTL cache of the authenticated user, keyed by token subject (email).
 *
 * Spring cached UserDetails forever (evicted only by UserService writes) and still ran
 * findByEmail inside most service methods — 40,330 executions in pg_stat_statements, each a
 * ~140 ms round trip from EC2. Here one lookup per TTL window serves authentication, role checks
 * and ownership checks. Staleness is bounded by the TTL and cleared immediately by user writes
 * made through this service.
 */
export class UserCache {
  private readonly entries = new Map<string, { user: CurrentUser | null; expires: number }>();
  private readonly inflight = new Map<string, Promise<CurrentUser | null>>();

  constructor(private readonly db: Db, private readonly ttlMs: number, private readonly maxEntries = 1000) {}

  async get(email: string): Promise<CurrentUser | null> {
    const hit = this.entries.get(email);
    if (hit && hit.expires > Date.now()) return hit.user;
    // Coalesce concurrent lookups for the same user (dashboard fires several requests at once).
    const pending = this.inflight.get(email);
    if (pending) return pending;
    const p = this.load(email).finally(() => this.inflight.delete(email));
    this.inflight.set(email, p);
    return p;
  }

  private async load(email: string): Promise<CurrentUser | null> {
    const rows = await this.db
      .select({ id: users.id, email: users.email, fullName: users.fullName, role: users.role, status: users.status })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    const user = (rows[0] as CurrentUser | undefined) ?? null;
    if (this.ttlMs > 0) {
      if (this.entries.size >= this.maxEntries) this.entries.clear();
      this.entries.set(email, { user, expires: Date.now() + this.ttlMs });
    }
    return user;
  }

  invalidateAll(): void {
    this.entries.clear();
  }
}

export function authenticate(jwtService: JwtService, cache: UserCache): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return next(unauthorized());
    const claims = jwtService.verify(header.slice(7));
    if (!claims) return next(unauthorized("Invalid or expired token"));
    const user = await cache.get(claims.sub);
    if (!user) return next(unauthorized("Invalid or expired token"));
    // Spring's JWT filter ignored UserDetails.isEnabled(), so deactivated users kept access until
    // their token expired. Inactive accounts are rejected here.
    if (user.status !== "ACTIVE") return next(unauthorized("Account is inactive"));
    req.user = user;
    next();
  };
}

export function requireRoles(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

export const isAgent = (u: CurrentUser) => u.role === "AGENT";
export const isManagement = (u: CurrentUser) => u.role === "ADMIN" || u.role === "MANAGER";
