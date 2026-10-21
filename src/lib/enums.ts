// Enum values exactly as stored (Spring @Enumerated(EnumType.STRING)).
export const ROLES = ["ADMIN", "MANAGER", "AGENT"] as const;
export const USER_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export const TEAM_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export const COURSE_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export const CAMPAIGN_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "COMPLETED"] as const;
export const LEAD_STATUSES = [
  "NEW", "CONTACTED", "INTERESTED", "FOLLOW_UP", "COUNSELLING",
  "ENROLLED", "NOT_INTERESTED", "WRONG_NUMBER", "NO_RESPONSE", "LOST",
] as const;
export const PRIORITIES = ["LOW", "MEDIUM", "HIGH"] as const;
export const ASSIGNMENT_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export const FOLLOW_UP_STATUSES = ["PENDING", "COMPLETED", "CANCELLED", "MISSED"] as const;
export const CALL_STATUSES = ["ANSWERED", "NOT_ANSWERED", "BUSY", "FAILED"] as const;
export const CALL_OUTCOMES = [
  "INTERESTED", "NOT_INTERESTED", "CALL_BACK", "FOLLOW_UP", "COUNSELLING",
  "ENROLLED", "WRONG_NUMBER", "NO_RESPONSE",
] as const;
export const BREAK_TYPES = ["NORMAL", "LUNCH", "TEA", "BIO", "EXCEPTION"] as const;

export type Role = (typeof ROLES)[number];
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type BreakType = (typeof BREAK_TYPES)[number];

/** Statuses after which a lead is "closed": cannot be assigned, active assignment is deactivated. */
export const CLOSED_LEAD_STATUSES: readonly string[] = ["ENROLLED", "NOT_INTERESTED", "LOST", "WRONG_NUMBER"];
export const isClosedLead = (status: string | null | undefined) => status != null && CLOSED_LEAD_STATUSES.includes(status);

/** CallLogService.updateLeadStatusFromCallOutcome */
export const OUTCOME_TO_LEAD_STATUS: Record<string, LeadStatus> = {
  INTERESTED: "INTERESTED",
  FOLLOW_UP: "FOLLOW_UP",
  COUNSELLING: "COUNSELLING",
  ENROLLED: "ENROLLED",
  NOT_INTERESTED: "NOT_INTERESTED",
  WRONG_NUMBER: "WRONG_NUMBER",
  NO_RESPONSE: "NO_RESPONSE",
  CALL_BACK: "FOLLOW_UP",
};
