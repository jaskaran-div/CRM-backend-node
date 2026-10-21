import type { ErrorRequestHandler, RequestHandler } from "express";

// Error envelopes match the Spring backend:
//  * GlobalExceptionHandler -> {"error": message}
//  * AgentBreakController and team/course delete conflicts -> {"message": message}
// Unlike Spring, unexpected errors never echo internal exception text (SQL, stack details).
export type Envelope = "error" | "message";

/** SQLSTATE of a Postgres error, also when wrapped (Drizzle puts the driver error in `cause`). */
export function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const code = typeof e?.code === "string" ? e.code : typeof e?.cause?.code === "string" ? e.cause.code : undefined;
  return code && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly envelope: Envelope = "error",
  ) {
    super(message);
  }
}

/** Spring: IllegalArgumentException / RuntimeException business rule -> 400. */
export const badRequest = (msg: string, envelope: Envelope = "error") => new HttpError(400, msg, envelope);
/** Spring: ResourceNotFoundException -> 404. */
export const notFound = (msg: string, envelope: Envelope = "error") => new HttpError(404, msg, envelope);
export const forbidden = (msg = "Access denied") => new HttpError(403, msg);
export const unauthorized = (msg = "Authentication required") => new HttpError(401, msg);
export const conflict = (msg: string, envelope: Envelope = "error") => new HttpError(409, msg, envelope);

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "Not found" });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    res.status(err.status).json({ [err.envelope]: err.message });
    return;
  }
  // express.json() parse failures
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Malformed JSON request body" });
    return;
  }
  if (err?.type === "entity.too.large") {
    res.status(413).json({ error: "Request body too large" });
    return;
  }
  // Postgres constraint violations: report the kind, not the SQL detail.
  const code = pgCode(err);
  if (code === "23505") {
    res.status(400).json({ error: "A record with the same unique value already exists" });
    return;
  }
  if (code === "23503") {
    res.status(400).json({ error: "Referenced record does not exist or is still in use" });
    return;
  }
  if (code === "22001") {
    res.status(400).json({ error: "A value is too long for its field" });
    return;
  }
  if (code === "25006") {
    req.log?.error({ err }, "write attempted on read-only connection");
    res.status(503).json({ error: "Service is in read-only mode" });
    return;
  }
  req.log?.error({ err }, "unhandled error");
  res.status(500).json({ error: "Internal server error" });
};
