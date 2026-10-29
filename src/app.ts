import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import type { AppContext } from "./context.js";
import { authenticate } from "./auth/middleware.js";
import { errorHandler, notFoundHandler } from "./lib/errors.js";
import { authPublicRoutes, authRoutes } from "./modules/auth.routes.js";
import { attendanceRoutes } from "./modules/attendance.routes.js";
import { catalogRoutes } from "./modules/catalog.routes.js";
import { leadRoutes } from "./modules/leads.routes.js";
import { assignmentRoutes } from "./modules/assignments.routes.js";
import { activityRoutes } from "./modules/activity.routes.js";
import { dashboardRoutes } from "./modules/dashboard.routes.js";

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable("x-powered-by");
  // Behind Nginx on the same host: trust only the loopback proxy for X-Forwarded-For (rate limiting).
  app.set("trust proxy", "loopback");

  app.use(pinoHttp({
    logger: ctx.logger,
    // Never log credentials or tokens; bodies are not logged at all.
    redact: { paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"], remove: true },
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
    autoLogging: { ignore: (req) => req.url === "/api/health" },
  }));
  app.use(helmet());

  // Production is same-origin through Nginx, so CORS is closed unless origins are allowlisted
  // (Spring allowed "*").
  const origins = ctx.config.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  if (origins.length) {
    app.use(cors({ 
      origin: origins, 
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], 
      allowedHeaders: ["Authorization", "Content-Type", "Cookie"], 
      exposedHeaders: ["Set-Cookie"],
      credentials: true, 
      maxAge: 600 
    }));
  }

  // strict:false — some endpoints take a bare JSON string body (e.g. "ENROLLED").
  app.use(express.json({ limit: "1mb", strict: false }));
  app.use(cookieParser());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "UP" });
  });
  app.use(authPublicRoutes(ctx));

  app.use("/api", authenticate(ctx.jwt, ctx.userCache));
  app.use(authRoutes(ctx));
  app.use(dashboardRoutes(ctx));
  app.use(catalogRoutes(ctx));
  app.use(leadRoutes(ctx));
  app.use(assignmentRoutes(ctx));
  app.use(activityRoutes(ctx));
  app.use(attendanceRoutes(ctx));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
