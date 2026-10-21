import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { users } from "../db/schema.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { pathId, parseBody, zStr } from "../lib/validate.js";
import { getDummyHash, verifyPassword } from "../auth/password.js";
import { recordLogin, recordLogout } from "./attendance.service.js";

export function authPublicRoutes(ctx: AppContext): Router {
  const r = Router();
  const { db, jwt, clock } = ctx;

  // New: brute-force protection. Counts failed attempts only, per client IP (Nginx X-Forwarded-For).
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: ctx.config.LOGIN_RATE_LIMIT_PER_15MIN,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many login attempts. Please try again later." },
  });

  // POST /api/auth/login  {email, password} -> {id, fullName, email, role, token}
  r.post("/api/auth/login", loginLimiter, async (req, res) => {
    const body = parseBody({ email: zStr, password: zStr }, req.body ?? {});
    const invalid = () => unauthorized("Invalid email or password");
    const user = body.email == null ? undefined
      : (await db.select().from(users).where(eq(users.email, body.email)).limit(1))[0];
    // Constant-ish time: always run one bcrypt comparison.
    const ok = await verifyPassword(body.password ?? "", user?.password ?? (await getDummyHash()));
    if (!user || user.status !== "ACTIVE" || !ok) throw invalid();

    const token = jwt.generateToken(user.email, user.role);
    if (user.role === "AGENT") await recordLogin(db, user.id, clock);
    res.json({ id: user.id, fullName: user.fullName, email: user.email, role: user.role, token });
  });

  return r;
}

export function authRoutes(ctx: AppContext): Router {
  const r = Router();
  // POST /api/auth/logout/{agentId}
  // Fixed: Spring closed the attendance of whatever agentId was in the URL. Now the id must be the
  // caller's own (ADMIN may log out any agent).
  r.post("/api/auth/logout/:agentId", async (req, res) => {
    const agentId = pathId(req.params.agentId, "agentId");
    const user = req.user!;
    if (user.role !== "ADMIN" && user.id !== agentId) throw forbidden("You can only record your own logout");
    await recordLogout(ctx.db, agentId, ctx.clock);
    res.type("text/plain").send("Logout attendance recorded successfully.");
  });
  return r;
}
