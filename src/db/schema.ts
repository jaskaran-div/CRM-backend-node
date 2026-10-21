// Table definitions mirroring the EXISTING production schema (verified with
// migration/tools/schema-audit.js on 2026-10-17). These are used for typed queries only.
// Never run drizzle-kit push/migrate against the production database.
//
// Columns that exist in the database but are not part of the Spring entities (users.created_at,
// call_logs.qa_done_by) are intentionally omitted so responses keep the same shape.
import { bigint, boolean, customType, date, integer, pgTable, text, varchar } from "drizzle-orm/pg-core";
import { pgTextToJackson } from "../lib/time.js";

// `timestamp without time zone` as a string in the Jackson LocalDateTime wire format
// ("2026-10-17T13:09:00.905613"). Accepts either "T" or space separated input.
const ts = customType<{ data: string; driverData: string }>({
  dataType: () => "timestamp",
  fromDriver: (v) => pgTextToJackson(v),
  toDriver: (v) => v,
});

const id = () => bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity();
const fk = (name: string) => bigint(name, { mode: "number" });

export const users = pgTable("users", {
  id: id(),
  fullName: varchar("full_name", { length: 100 }).notNull(),
  email: varchar("email", { length: 150 }).notNull(),
  phone: varchar("phone", { length: 15 }),
  password: varchar("password", { length: 255 }).notNull(),
  role: text("role").notNull(),
  status: text("status"),
});

export const teams = pgTable("teams", {
  id: id(),
  teamName: varchar("team_name", { length: 100 }).notNull(),
  description: varchar("description", { length: 255 }),
  status: text("status"),
  createdAt: ts("created_at"),
});

export const courses = pgTable("courses", {
  id: id(),
  courseName: varchar("course_name", { length: 150 }).notNull(),
  description: text("description"),
  durationMonths: integer("duration_months"),
  status: text("status"),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export const campaigns = pgTable("campaigns", {
  id: id(),
  campaignName: varchar("campaign_name", { length: 150 }).notNull(),
  description: text("description"),
  source: varchar("source", { length: 100 }),
  courseId: fk("course_id"),
  startDate: date("start_date", { mode: "string" }),
  endDate: date("end_date", { mode: "string" }),
  status: text("status"),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export const leads = pgTable("leads", {
  id: id(),
  fullName: varchar("full_name", { length: 100 }).notNull(),
  email: varchar("email", { length: 150 }),
  phone: varchar("phone", { length: 15 }).notNull(),
  courseInterested: varchar("course_interested", { length: 100 }),
  leadSource: varchar("lead_source", { length: 50 }),
  status: text("status"),
  priority: text("priority"),
  city: varchar("city", { length: 100 }),
  education: varchar("education", { length: 150 }),
  interestedArea: varchar("interested_area", { length: 255 }),
  age: integer("age"),
  currentProfession: varchar("current_profession", { length: 150 }),
  primaryObjective: varchar("primary_objective", { length: 255 }),
  tradingInvestmentExperience: varchar("trading_investment_experience", { length: 100 }),
  customerLookingFor: varchar("customer_looking_for", { length: 255 }),
  campaignId: fk("campaign_id"),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export const leadAssignments = pgTable("lead_assignments", {
  id: id(),
  leadId: fk("lead_id").notNull(),
  agentId: fk("agent_id").notNull(),
  teamId: fk("team_id"),
  assignedAt: ts("assigned_at"),
  status: text("status"),
});

export const followUps = pgTable("follow_ups", {
  id: id(),
  leadId: fk("lead_id").notNull(),
  agentId: fk("agent_id").notNull(),
  followUpDate: ts("follow_up_date").notNull(),
  purpose: varchar("purpose", { length: 255 }),
  status: text("status"),
  remarks: text("remarks"),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export const callLogs = pgTable("call_logs", {
  id: id(),
  leadId: fk("lead_id").notNull(),
  agentId: fk("agent_id").notNull(),
  callStartTime: ts("call_start_time").notNull(),
  callEndTime: ts("call_end_time"),
  durationSeconds: integer("duration_seconds"),
  callStatus: text("call_status"),
  callOutcome: text("call_outcome"),
  remarks: text("remarks"),
  education: varchar("education", { length: 150 }),
  interestedArea: varchar("interested_area", { length: 255 }),
  city: varchar("city", { length: 150 }),
  createdAt: ts("created_at"),
});

export const notes = pgTable("notes", {
  id: id(),
  leadId: fk("lead_id").notNull(),
  userId: fk("user_id").notNull(),
  note: text("note").notNull(),
  createdAt: ts("created_at"),
});

export const notifications = pgTable("notifications", {
  id: id(),
  userId: fk("user_id").notNull(),
  type: varchar("type", { length: 100 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  message: text("message").notNull(),
  referenceId: fk("reference_id"),
  read: boolean("is_read").notNull().default(false),
  createdAt: ts("created_at"),
});

export const agentAttendance = pgTable("agent_attendance", {
  id: id(),
  agentId: fk("agent_id").notNull(),
  attendanceDate: date("attendance_date", { mode: "string" }).notNull(),
  loginTime: ts("login_time").notNull(),
  logoutTime: ts("logout_time"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at"),
});

export const agentBreaks = pgTable("agent_breaks", {
  id: id(),
  agentId: fk("agent_id").notNull(),
  attendanceId: fk("attendance_id").notNull(),
  breakType: varchar("break_type", { length: 20 }).notNull(),
  startTime: ts("start_time").notNull(),
  endTime: ts("end_time"),
  durationSeconds: bigint("duration_seconds", { mode: "number" }),
  reason: text("reason"),
  limitAlertSent: boolean("limit_alert_sent").notNull().default(false),
  createdAt: ts("created_at").notNull(),
});

export const leadViewActivities = pgTable("lead_view_activities", {
  id: id(),
  agentId: fk("agent_id").notNull(),
  leadId: fk("lead_id").notNull(),
  viewedDate: date("viewed_date", { mode: "string" }).notNull(),
});

export type User = typeof users.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type LeadAssignment = typeof leadAssignments.$inferSelect;
export type FollowUp = typeof followUps.$inferSelect;
export type CallLog = typeof callLogs.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type AgentAttendance = typeof agentAttendance.$inferSelect;
export type AgentBreak = typeof agentBreaks.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type Course = typeof courses.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
