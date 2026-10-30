import { pgTable, text, serial, integer, boolean, timestamp, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { users, crmContacts } from "./schema";

// ============================================================
// INTELLIGENT RESOURCE MAPPING
// ============================================================
//
// Time-handling convention (DST-safe):
//   - All absolute instants are stored as `timestamptz` (UTC under the hood).
//   - IANA timezone strings (e.g., 'America/New_York') travel alongside, on
//     resources and appointments, so business-rule math (working hours,
//     holidays, customer-facing display) stays correct across DST changes.
//
// Notes for ops/migration:
//   - The slot-lock and appointment overlap correctness relies on a Postgres
//     EXCLUDE constraint (gist + btree_gist) keyed by (resource_id, tstzrange).
//     Drizzle does not yet emit EXCLUDE constraints natively; a follow-up SQL
//     migration adds them. Composite indexes below already accelerate the
//     active-status overlap query path.

// A unified resource is anything that can be booked or required for a
// service: a staff member, a room, a piece of equipment.
export const bookingResources = pgTable("booking_resources", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(), // 'staff' | 'room' | 'equipment'
  name: text("name").notNull(),
  description: text("description"),
  // For staff resources, link to the user account that owns the calendar
  userId: integer("user_id").references(() => users.id),
  // IANA timezone — drives DST-safe scheduling and display
  timezone: text("timezone").notNull().default("America/New_York"),
  // Resource may be temporarily disabled without deleting historical bookings
  isActive: boolean("is_active").notNull().default(true),
  // Optional capacity for shared resources (e.g., a classroom with 8 seats)
  capacity: integer("capacity").notNull().default(1),
  colorHex: text("color_hex").default("#3b82f6"),
  metadata: text("metadata"), // JSON: phone ext, equipment serial, etc.
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => ({
  typeIdx: index("booking_resources_type_idx").on(t.type),
  activeIdx: index("booking_resources_active_idx").on(t.isActive),
  typeCheck: check("booking_resources_type_check", sql`${t.type} IN ('staff', 'room', 'equipment')`),
  capacityCheck: check("booking_resources_capacity_positive", sql`${t.capacity} > 0`),
}));

// Tags categorize resources so services can express requirements
// declaratively (e.g., "needs a resource tagged 'data-recovery-station'").
export const resourceTags = pgTable("resource_tags", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  label: text("label").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const resourceTagAssignments = pgTable("resource_tag_assignments", {
  id: serial("id").primaryKey(),
  resourceId: integer("resource_id").notNull().references(() => bookingResources.id, { onDelete: "cascade" }),
  tagId: integer("tag_id").notNull().references(() => resourceTags.id, { onDelete: "cascade" }),
}, (t) => ({
  uniq: uniqueIndex("resource_tag_assignments_unique").on(t.resourceId, t.tagId),
  resourceIdx: index("resource_tag_assignments_resource_idx").on(t.resourceId),
  tagIdx: index("resource_tag_assignments_tag_idx").on(t.tagId),
}));

// Top-level grouping (e.g., "Repair", "Consultation", "Data Recovery")
export const serviceCategories = pgTable("service_categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  displayOrder: integer("display_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// A bookable service offering
export const services = pgTable("services", {
  id: serial("id").primaryKey(),
  categoryId: integer("category_id").references(() => serviceCategories.id),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  // Duration the customer occupies a slot, in minutes
  durationMinutes: integer("duration_minutes").notNull(),
  // Buffer time around the appointment (per-service overrides global rules)
  bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
  bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
  // Pricing — base price; tiers and add-ons live in their own tables (Phase 3)
  basePriceCents: integer("base_price_cents").notNull().default(0),
  // Deposit policy: 'none' | 'full' | 'flat' | 'percent'
  depositType: text("deposit_type").notNull().default("none"),
  depositAmountCents: integer("deposit_amount_cents").notNull().default(0), // used if 'flat'
  depositPercent: integer("deposit_percent").notNull().default(0), // used if 'percent', 0–100
  // Whether high-risk clients are forced to 100% prepay
  enforceHighRiskPrepay: boolean("enforce_high_risk_prepay").notNull().default(true),
  // Booking window guards
  minLeadTimeMinutes: integer("min_lead_time_minutes").notNull().default(60),
  maxAdvanceDays: integer("max_advance_days").notNull().default(60),
  isActive: boolean("is_active").notNull().default(true),
  isPubliclyBookable: boolean("is_publicly_bookable").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => ({
  categoryIdx: index("services_category_idx").on(t.categoryId),
  activeIdx: index("services_active_idx").on(t.isActive),
  durationCheck: check("services_duration_positive", sql`${t.durationMinutes} > 0`),
  depositTypeCheck: check("services_deposit_type_check", sql`${t.depositType} IN ('none', 'full', 'flat', 'percent')`),
  depositPercentCheck: check("services_deposit_percent_range", sql`${t.depositPercent} >= 0 AND ${t.depositPercent} <= 100`),
  depositAmountCheck: check("services_deposit_amount_nonneg", sql`${t.depositAmountCents} >= 0`),
  basePriceCheck: check("services_base_price_nonneg", sql`${t.basePriceCents} >= 0`),
  bufferBeforeCheck: check("services_buffer_before_nonneg", sql`${t.bufferBeforeMinutes} >= 0`),
  bufferAfterCheck: check("services_buffer_after_nonneg", sql`${t.bufferAfterMinutes} >= 0`),
}));

// What resources a service requires. Each row is one requirement;
// a service with two rows needs both satisfied (AND logic).
// Within a row, EXACTLY ONE of resourceId or tagId must be set —
// pin a specific resource OR require any matching a tag.
export const serviceResourceRequirements = pgTable("service_resource_requirements", {
  id: serial("id").primaryKey(),
  serviceId: integer("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  resourceId: integer("resource_id").references(() => bookingResources.id),
  tagId: integer("tag_id").references(() => resourceTags.id),
  // How many matching resources are needed (e.g., 2 technicians)
  quantity: integer("quantity").notNull().default(1),
  // Whether the customer can choose a specific resource at checkout
  customerSelectable: boolean("customer_selectable").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => ({
  serviceIdx: index("service_resource_requirements_service_idx").on(t.serviceId),
  // XOR: exactly one of resourceId / tagId is set
  xorCheck: check(
    "service_resource_requirements_xor",
    sql`(${t.resourceId} IS NOT NULL AND ${t.tagId} IS NULL) OR (${t.resourceId} IS NULL AND ${t.tagId} IS NOT NULL)`,
  ),
  quantityCheck: check("service_resource_requirements_quantity_positive", sql`${t.quantity} > 0`),
}));

// ============================================================
// AVAILABILITY ENGINE
// ============================================================

// Recurring weekly working hours per resource.
// dayOfWeek: 0 = Sunday … 6 = Saturday
// startTime / endTime stored as 'HH:MM' interpreted in the resource's timezone.
export const businessHours = pgTable("business_hours", {
  id: serial("id").primaryKey(),
  resourceId: integer("resource_id").notNull().references(() => bookingResources.id, { onDelete: "cascade" }),
  dayOfWeek: integer("day_of_week").notNull(),
  startTime: text("start_time").notNull(), // 'HH:MM'
  endTime: text("end_time").notNull(),
  isClosed: boolean("is_closed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => ({
  resourceDayIdx: index("business_hours_resource_day_idx").on(t.resourceId, t.dayOfWeek),
  dayOfWeekCheck: check("business_hours_day_of_week_range", sql`${t.dayOfWeek} >= 0 AND ${t.dayOfWeek} <= 6`),
  timeFormatCheck: check(
    "business_hours_time_format",
    sql`${t.startTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND ${t.endTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`,
  ),
}));

// One-off blocks: vacations, sick days, training, equipment maintenance.
export const resourceTimeOff = pgTable("resource_time_off", {
  id: serial("id").primaryKey(),
  resourceId: integer("resource_id").notNull().references(() => bookingResources.id, { onDelete: "cascade" }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => ({
  resourceRangeIdx: index("resource_time_off_resource_range_idx").on(t.resourceId, t.startsAt, t.endsAt),
  rangeOrderCheck: check("resource_time_off_range_order", sql`${t.endsAt} > ${t.startsAt}`),
}));

// Business-wide closed days. resourceId NULL = applies to everyone.
export const holidays = pgTable("holidays", {
  id: serial("id").primaryKey(),
  resourceId: integer("resource_id").references(() => bookingResources.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  date: text("date").notNull(), // 'YYYY-MM-DD' in business timezone
  recurring: boolean("recurring").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => ({
  dateIdx: index("holidays_date_idx").on(t.date),
  dateFormatCheck: check("holidays_date_format", sql`${t.date} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
}));

// 5-minute soft locks held during checkout to prevent race conditions.
// Lock-level metadata is here; the resources reserved by each lock are in
// `bookingSlotLockResources` so per-resource overlap queries are indexable.
export const bookingSlotLocks = pgTable("booking_slot_locks", {
  id: serial("id").primaryKey(),
  // Cryptographically random token returned to the client; required to confirm
  lockToken: text("lock_token").notNull().unique(),
  serviceId: integer("service_id").notNull().references(() => services.id),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  // Optional client identifier (anon session or authenticated user)
  sessionId: text("session_id"),
  userId: integer("user_id").references(() => users.id),
  // TTL — sweeper deletes rows where expiresAt < now()
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => ({
  expiresIdx: index("booking_slot_locks_expires_idx").on(t.expiresAt),
  rangeOrderCheck: check("booking_slot_locks_range_order", sql`${t.endsAt} > ${t.startsAt}`),
}));

// Junction: which resources each lock holds. Indexed for the hot-path query
// "is resource X held by any unexpired lock overlapping [start, end)?".
export const bookingSlotLockResources = pgTable("booking_slot_lock_resources", {
  id: serial("id").primaryKey(),
  lockId: integer("lock_id").notNull().references(() => bookingSlotLocks.id, { onDelete: "cascade" }),
  resourceId: integer("resource_id").notNull().references(() => bookingResources.id, { onDelete: "cascade" }),
  // Denormalized for index-only scans during overlap checks
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => ({
  uniq: uniqueIndex("booking_slot_lock_resources_unique").on(t.lockId, t.resourceId),
  // Hot-path composite index for overlap-by-resource queries
  resourceTimeIdx: index("booking_slot_lock_resources_resource_time_idx").on(t.resourceId, t.endsAt, t.startsAt),
  expiresIdx: index("booking_slot_lock_resources_expires_idx").on(t.expiresAt),
  rangeOrderCheck: check("booking_slot_lock_resources_range_order", sql`${t.endsAt} > ${t.startsAt}`),
}));

// The actual confirmed bookings.
// Status drives whether the slot is "taken" for availability checks.
export const appointments = pgTable("appointments", {
  id: serial("id").primaryKey(),
  // Public-facing reference for emails and confirmations: 'CSD-A-2026-000123'
  reference: text("reference").notNull().unique(),
  serviceId: integer("service_id").notNull().references(() => services.id),
  // Link to existing CRM record when known; null for guest bookings
  contactId: integer("contact_id").references(() => crmContacts.id),
  // Snapshot of customer details at booking time (survives contact edits)
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  customerPhone: text("customer_phone"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  customerTimezone: text("customer_timezone").notNull().default("America/New_York"),
  // 'pending' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled' | 'no_show'
  status: text("status").notNull().default("pending"),
  // Pricing snapshot (in cents) — service prices may change later
  totalCents: integer("total_cents").notNull().default(0),
  depositRequiredCents: integer("deposit_required_cents").notNull().default(0),
  amountPaidCents: integer("amount_paid_cents").notNull().default(0),
  customerNotes: text("customer_notes"),
  internalNotes: text("internal_notes"),
  // Source: 'web' | 'embed' | 'phone' | 'walk_in' | 'admin'
  source: text("source").notNull().default("web"),
  // Lifecycle timestamps (used by reminder chains, no-show CRM, analytics)
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledByUserId: integer("cancelled_by_user_id").references(() => users.id),
  cancellationReason: text("cancellation_reason"),
  noShowMarkedAt: timestamp("no_show_marked_at", { withTimezone: true }),
  noShowMarkedByUserId: integer("no_show_marked_by_user_id").references(() => users.id),
  // Google Calendar event id pushed for this appointment, if calendar sync is on.
  googleEventId: text("google_event_id"),
  googleCalendarId: text("google_calendar_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => ({
  // Composite index optimized for the "active overlap in range" availability query
  startsActiveIdx: index("appointments_starts_active_idx").on(t.startsAt, t.status),
  contactIdx: index("appointments_contact_idx").on(t.contactId),
  serviceIdx: index("appointments_service_idx").on(t.serviceId),
  statusIdx: index("appointments_status_idx").on(t.status),
  rangeOrderCheck: check("appointments_range_order", sql`${t.endsAt} > ${t.startsAt}`),
  statusCheck: check(
    "appointments_status_check",
    sql`${t.status} IN ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show')`,
  ),
  sourceCheck: check(
    "appointments_source_check",
    sql`${t.source} IN ('web', 'embed', 'phone', 'walk_in', 'admin')`,
  ),
  totalCheck: check("appointments_total_nonneg", sql`${t.totalCents} >= 0`),
  depositCheck: check("appointments_deposit_nonneg", sql`${t.depositRequiredCents} >= 0`),
  paidCheck: check("appointments_paid_nonneg", sql`${t.amountPaidCents} >= 0`),
}));

// Junction: resources reserved for an appointment.
// Indexed for the hot-path overlap query keyed by resource_id.
export const appointmentResources = pgTable("appointment_resources", {
  id: serial("id").primaryKey(),
  appointmentId: integer("appointment_id").notNull().references(() => appointments.id, { onDelete: "cascade" }),
  resourceId: integer("resource_id").notNull().references(() => bookingResources.id),
  // Which requirement row this assignment satisfies (audit / re-planning)
  requirementId: integer("requirement_id").references(() => serviceResourceRequirements.id),
  // Denormalized window for index-only overlap scans without joining appointments
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  // Denormalized status — must match parent appointment; updated by trigger or
  // application-level guarantee. Lets the overlap query filter without join.
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => ({
  uniq: uniqueIndex("appointment_resources_unique").on(t.appointmentId, t.resourceId),
  // Hot-path composite index: resource + status + range
  resourceStatusTimeIdx: index("appointment_resources_resource_status_time_idx")
    .on(t.resourceId, t.status, t.endsAt, t.startsAt),
  rangeOrderCheck: check("appointment_resources_range_order", sql`${t.endsAt} > ${t.startsAt}`),
  statusCheck: check(
    "appointment_resources_status_check",
    sql`${t.status} IN ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show')`,
  ),
}));

// ============================================================
// ZOD INSERT SCHEMAS + TYPES
// ============================================================

export const insertBookingResourceSchema = createInsertSchema(bookingResources).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBookingResource = z.infer<typeof insertBookingResourceSchema>;
export type BookingResource = typeof bookingResources.$inferSelect;

export const insertResourceTagSchema = createInsertSchema(resourceTags).omit({
  id: true,
  createdAt: true,
});
export type InsertResourceTag = z.infer<typeof insertResourceTagSchema>;
export type ResourceTag = typeof resourceTags.$inferSelect;

export const insertResourceTagAssignmentSchema = createInsertSchema(resourceTagAssignments).omit({
  id: true,
});
export type InsertResourceTagAssignment = z.infer<typeof insertResourceTagAssignmentSchema>;
export type ResourceTagAssignment = typeof resourceTagAssignments.$inferSelect;

export const insertServiceCategorySchema = createInsertSchema(serviceCategories).omit({
  id: true,
  createdAt: true,
});
export type InsertServiceCategory = z.infer<typeof insertServiceCategorySchema>;
export type ServiceCategory = typeof serviceCategories.$inferSelect;

export const insertServiceSchema = createInsertSchema(services).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertService = z.infer<typeof insertServiceSchema>;
export type Service = typeof services.$inferSelect;

export const insertServiceResourceRequirementSchema = createInsertSchema(serviceResourceRequirements).omit({
  id: true,
  createdAt: true,
});
export type InsertServiceResourceRequirement = z.infer<typeof insertServiceResourceRequirementSchema>;
export type ServiceResourceRequirement = typeof serviceResourceRequirements.$inferSelect;

export const insertBusinessHoursSchema = createInsertSchema(businessHours).omit({
  id: true,
  createdAt: true,
});
export type InsertBusinessHours = z.infer<typeof insertBusinessHoursSchema>;
export type BusinessHours = typeof businessHours.$inferSelect;

export const insertResourceTimeOffSchema = createInsertSchema(resourceTimeOff).omit({
  id: true,
  createdAt: true,
});
export type InsertResourceTimeOff = z.infer<typeof insertResourceTimeOffSchema>;
export type ResourceTimeOff = typeof resourceTimeOff.$inferSelect;

export const insertHolidaySchema = createInsertSchema(holidays).omit({
  id: true,
  createdAt: true,
});
export type InsertHoliday = z.infer<typeof insertHolidaySchema>;
export type Holiday = typeof holidays.$inferSelect;

export const insertBookingSlotLockSchema = createInsertSchema(bookingSlotLocks).omit({
  id: true,
  createdAt: true,
});
export type InsertBookingSlotLock = z.infer<typeof insertBookingSlotLockSchema>;
export type BookingSlotLock = typeof bookingSlotLocks.$inferSelect;

export const insertBookingSlotLockResourceSchema = createInsertSchema(bookingSlotLockResources).omit({
  id: true,
});
export type InsertBookingSlotLockResource = z.infer<typeof insertBookingSlotLockResourceSchema>;
export type BookingSlotLockResource = typeof bookingSlotLockResources.$inferSelect;

export const insertAppointmentSchema = createInsertSchema(appointments).omit({
  id: true,
  reference: true,
  createdAt: true,
  updatedAt: true,
  confirmedAt: true,
  startedAt: true,
  completedAt: true,
  cancelledAt: true,
  cancelledByUserId: true,
  noShowMarkedAt: true,
  noShowMarkedByUserId: true,
});
export type InsertAppointment = z.infer<typeof insertAppointmentSchema>;
export type Appointment = typeof appointments.$inferSelect;

export const insertAppointmentResourceSchema = createInsertSchema(appointmentResources).omit({
  id: true,
  createdAt: true,
});
export type InsertAppointmentResource = z.infer<typeof insertAppointmentResourceSchema>;
export type AppointmentResource = typeof appointmentResources.$inferSelect;

// Status enums (string literal unions used by services and routes)
export const APPOINTMENT_STATUSES = ["pending", "confirmed", "in_progress", "completed", "cancelled", "no_show"] as const;
export type AppointmentStatus = typeof APPOINTMENT_STATUSES[number];

// Statuses that count as "occupying" the slot for availability calculations
export const APPOINTMENT_ACTIVE_STATUSES: AppointmentStatus[] = ["pending", "confirmed", "in_progress"];

export const RESOURCE_TYPES = ["staff", "room", "equipment"] as const;
export type ResourceType = typeof RESOURCE_TYPES[number];

export const DEPOSIT_TYPES = ["none", "full", "flat", "percent"] as const;
export type DepositType = typeof DEPOSIT_TYPES[number];

export const APPOINTMENT_SOURCES = ["web", "embed", "phone", "walk_in", "admin"] as const;
export type AppointmentSource = typeof APPOINTMENT_SOURCES[number];
