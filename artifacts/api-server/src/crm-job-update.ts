import type { CrmJob } from "@workspace/db";

export const CRM_JOB_STATUSES = [
  "open",
  "in_progress",
  "waiting_parts",
  "ready_pickup",
  "completed",
  "cancelled",
] as const;

const TEXT_FIELDS = ["serviceType", "jobType", "priority", "description", "notes", "technicianNotes", "assignedTo"] as const;
const INTEGER_FIELDS = ["contactId", "leadId", "estimatedAmount", "finalAmount"] as const;
const DATE_FIELDS = ["scheduledDateTime", "completedDateTime"] as const;

function toDate(value: unknown, name: string): Date | null {
  if (value === null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value;
  if (typeof value !== "string") throw new Error(`${name} must be a date`);
  // A bare calendar day is pinned to noon UTC so it shows as the same day in US time zones.
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00.000Z` : value);
  if (Number.isNaN(date.valueOf())) throw new Error(`${name} is not a valid date`);
  return date;
}

/**
 * Turns a PATCH body into the columns staff may change on a job. Identity
 * columns (id, jobNumber, timestamps) are ignored, dates are converted to Date
 * objects (Drizzle's timestamp columns reject ISO strings), and marking a job
 * completed stamps today's date unless one is supplied or already recorded.
 */
export function crmJobUpdateFromBody(body: unknown, existing: Pick<CrmJob, "completedDateTime">): Partial<CrmJob> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid job update");
  const input = body as Record<string, unknown>;
  const update: Record<string, unknown> = {};

  if (input.status !== undefined) {
    if (typeof input.status !== "string" || !(CRM_JOB_STATUSES as readonly string[]).includes(input.status)) {
      throw new Error(`status must be one of: ${CRM_JOB_STATUSES.join(", ")}`);
    }
    update.status = input.status;
  }
  for (const field of TEXT_FIELDS) {
    if (input[field] === undefined) continue;
    if (input[field] !== null && typeof input[field] !== "string") throw new Error(`${field} must be text`);
    update[field] = input[field];
  }
  for (const field of INTEGER_FIELDS) {
    if (input[field] === undefined) continue;
    if (input[field] === null) {
      update[field] = null;
      continue;
    }
    const value = Number(input[field]);
    if (!Number.isSafeInteger(value)) throw new Error(`${field} must be a whole number`);
    update[field] = value;
  }
  for (const field of DATE_FIELDS) {
    if (input[field] !== undefined) update[field] = toDate(input[field], field);
  }

  if (update.status === "completed" && update.completedDateTime === undefined && !existing.completedDateTime) {
    update.completedDateTime = new Date();
  }
  return update as Partial<CrmJob>;
}
