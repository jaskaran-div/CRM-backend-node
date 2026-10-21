import { Router } from "express";
import type { AppContext } from "../context.js";
import { requireRoles } from "../auth/middleware.js";
import { badRequest, notFound } from "../lib/errors.js";
import { BREAK_TYPES } from "../lib/enums.js";
import { pathId, queryId, zEnum, zId, zStr, parseBody, zLocalDate } from "../lib/validate.js";
import { z } from "zod";
import {
  attendanceDetails, attendanceRow, endBreak, getActiveBreak, getBreakSummary, getTodayAttendance,
  loadAttendanceRows, recordLogin, recordLogout, startBreak,
} from "./attendance.service.js";
import { assertSelfOrAdmin, assertSelfOrManagement } from "./shared.js";
import { sql } from "drizzle-orm";
import { one } from "../db/sqlutil.js";

// Spring trusted the agentId supplied in query strings and bodies, so any logged-in user could read,
// start, end or close any agent's attendance and breaks. Now:
//   reads  (today, active, summary): own id, or ADMIN/MANAGER for any agent
//   writes (login, logout, break start/end): own id, or ADMIN for any agent
export function attendanceRoutes(ctx: AppContext): Router {
  const r = Router();
  const { db, clock } = ctx;

  // ------------------------------------------------ /api/attendance
  r.get("/api/attendance/today", async (req, res) => {
    const agentId = queryId(req.query.agentId, "agentId");
    assertSelfOrManagement(req.user!, agentId);
    // Spring returned Optional<AgentAttendance>: the object, or JSON null.
    res.json(await getTodayAttendance(db, agentId, clock));
  });

  r.post("/api/attendance/login", async (req, res) => {
    const agentId = queryId(req.query.agentId, "agentId");
    assertSelfOrAdmin(req.user!, agentId);
    res.json(await recordLogin(db, agentId, clock));
  });

  r.post("/api/attendance/logout", async (req, res) => {
    const agentId = queryId(req.query.agentId, "agentId");
    assertSelfOrAdmin(req.user!, agentId);
    res.json(await recordLogout(db, agentId, clock));
  });

  // ------------------------------------------------ /api/attendance/break  ({"message"} envelope)
  r.post("/api/attendance/break/start", async (req, res) => {
    const body = parseBody({ agentId: zId, breakType: zEnum(BREAK_TYPES), reason: zStr }, req.body ?? {});
    if (body.agentId == null) throw badRequest("Agent ID is required.", "message");
    if (body.breakType == null) throw badRequest("Select a break type.", "message");
    assertSelfOrAdmin(req.user!, body.agentId);
    res.json(await startBreak(db, body.agentId, body.breakType, body.reason, clock));
  });

  r.post("/api/attendance/break/end", async (req, res) => {
    const body = parseBody({ agentId: zId }, req.body ?? {});
    if (body.agentId == null) throw badRequest("Agent ID is required.", "message");
    assertSelfOrAdmin(req.user!, body.agentId);
    res.json(await endBreak(db, body.agentId, clock));
  });

  r.get("/api/attendance/break/active", async (req, res) => {
    const agentId = queryId(req.query.agentId, "agentId");
    assertSelfOrManagement(req.user!, agentId);
    const active = await getActiveBreak(db, agentId);
    // Spring wrote an empty 200 body for a null return value.
    if (active == null) res.status(200).end();
    else res.json(active);
  });

  r.get("/api/attendance/break/summary", async (req, res) => {
    const agentId = queryId(req.query.agentId, "agentId");
    assertSelfOrManagement(req.user!, agentId);
    res.json(await getBreakSummary(db, agentId, clock));
  });

  // ------------------------------------------------ /api/admin/attendance (ADMIN)
  const admin = requireRoles("ADMIN");

  // Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD (new, additive). Without them: all rows, as before.
  r.get("/api/admin/attendance", admin, async (req, res) => {
    const q = z.object({ from: zLocalDate, to: zLocalDate }).safeParse({ from: req.query.from, to: req.query.to });
    if (!q.success) throw badRequest("Invalid date filter (expected YYYY-MM-DD)");
    const list = await loadAttendanceRows(db, { from: q.data.from ?? undefined, to: q.data.to ?? undefined, agentNamesOnly: true });
    res.json(list.map((x) => attendanceRow(x, clock)));
  });

  r.get("/api/admin/attendance/:attendanceId", admin, async (req, res) => {
    const id = pathId(req.params.attendanceId, "attendanceId");
    const [x] = await loadAttendanceRows(db, { id });
    // Spring: RuntimeException -> 400. Now a proper 404 with the same message.
    if (!x) throw notFound("Attendance record not found.");
    res.json(attendanceDetails(x, clock));
  });

  r.delete("/api/admin/attendance/:attendanceId", admin, async (req, res) => {
    const id = pathId(req.params.attendanceId, "attendanceId");
    const deleted = await one<{ id: number }>(db, sql`
      with b as (
        delete from agent_breaks where attendance_id = ${id}
          and agent_id = (select agent_id from agent_attendance where id = ${id})
      )
      delete from agent_attendance where id = ${id} returning id`);
    if (!deleted) throw notFound("Attendance record not found.");
    res.json({ message: "Attendance record deleted successfully." });
  });

  return r;
}
