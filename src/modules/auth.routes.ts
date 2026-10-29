import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { eq, and, gt, isNull } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { users, refreshTokens } from "../db/schema.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { pathId, parseBody, zStr } from "../lib/validate.js";
import { getDummyHash, verifyPassword } from "../auth/password.js";
import { recordLogin, recordLogout } from "./attendance.service.js";

const COOKIE_NAME = "derivion_rt";
const COOKIE_PATH = "/api/auth/refresh";

function setRefreshCookie(res: import("express").Response, raw: string, config: AppContext["config"]): void {
  res.cookie(COOKIE_NAME, raw, {
    httpOnly: true,
    secure: config.COOKIE_SECURE === "true",
    sameSite: "strict",
    path: COOKIE_PATH,
    maxAge: config.REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(res: import("express").Response): void {
  res.clearCookie(COOKIE_NAME, { path: COOKIE_PATH });
}

export function authPublicRoutes(ctx: AppContext): Router {
  const r = Router();
  const { db, jwt, refreshJwt, clock, config } = ctx;

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
    const ok = await verifyPassword(body.password ?? "", user?.password ?? (await getDummyHash()));
    if (!user || user.status !== "ACTIVE" || !ok) throw invalid();

    const token = jwt.generateToken(user.email, user.role);
    if (user.role === "AGENT") await recordLogin(db, user.id, clock);

    // Issue refresh token
    const rawRefresh = refreshJwt.generateRawToken();
    const hashRefresh = refreshJwt.hashToken(rawRefresh);
    const expiresAt = refreshJwt.expiresAt();
    await db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: hashRefresh,
      expiresAt,
      createdAt: new Date(),
    });
    setRefreshCookie(res, rawRefresh, config);

    res.json({ id: user.id, fullName: user.fullName, email: user.email, role: user.role, token });
  });

  // POST /api/auth/refresh  (reads HttpOnly cookie, rotates refresh token, returns new access token)
  r.post("/api/auth/refresh", async (req, res) => {
    const rawToken: string | undefined = req.cookies?.[COOKIE_NAME];
    if (!rawToken) {
      clearRefreshCookie(res);
      throw unauthorized("No refresh token");
    }

    const hash = refreshJwt.hashToken(rawToken);
    const now = new Date();

    const rows = await db
      .select()
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.tokenHash, hash),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, now),
        )
      )
      .limit(1);

    const storedToken = rows[0];
    if (!storedToken) {
      clearRefreshCookie(res);
      throw unauthorized("Invalid or expired refresh token");
    }

    // Load user
    const userRows = await db.select().from(users).where(eq(users.id, storedToken.userId)).limit(1);
    const user = userRows[0];
    if (!user || user.status !== "ACTIVE") {
      await db.delete(refreshTokens).where(eq(refreshTokens.id, storedToken.id));
      clearRefreshCookie(res);
      throw unauthorized("Account is inactive");
    }

    // Rotate: delete old, insert new (prevents replay)
    await db.delete(refreshTokens).where(eq(refreshTokens.id, storedToken.id));

    const newRaw = refreshJwt.generateRawToken();
    const newHash = refreshJwt.hashToken(newRaw);
    const newExpiry = refreshJwt.expiresAt();
    await db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: newHash,
      expiresAt: newExpiry,
      createdAt: new Date(),
    });

    const newAccessToken = jwt.generateToken(user.email, user.role);
    setRefreshCookie(res, newRaw, ctx.config);

    res.json({ token: newAccessToken, id: user.id, fullName: user.fullName, email: user.email, role: user.role });
  });

  return r;
}

export function authRoutes(ctx: AppContext): Router {
  const r = Router();
  r.post("/api/auth/logout/:agentId", async (req, res) => {
    const agentId = pathId(req.params.agentId, "agentId");
    const user = req.user!;
    if (user.role !== "ADMIN" && user.id !== agentId) throw forbidden("You can only record your own logout");
    await recordLogout(ctx.db, agentId, ctx.clock);

    // Revoke the refresh token
    const rawToken: string | undefined = req.cookies?.[COOKIE_NAME];
    if (rawToken) {
      const hash = ctx.refreshJwt.hashToken(rawToken);
      await ctx.db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, hash));
    }
    clearRefreshCookie(res);

    res.type("text/plain").send("Logout attendance recorded successfully.");
  });
  return r;
}
