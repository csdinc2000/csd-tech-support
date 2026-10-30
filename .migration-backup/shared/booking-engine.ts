/**
 * Booking Engine v2 — Drizzle definitions for the `booking_*` tables.
 *
 * DDL OWNERSHIP: these tables are created by the hand-rolled boot migration
 * `server/migrations/2026-07-04-booking-engine.ts`, NOT by `db:push`, because
 * they rely on `CREATE EXTENSION btree_gist` and an EXCLUDE constraint
 * (booking_appointments_no_overlap) that Drizzle cannot emit. If `db:push`
 * ever proposes dropping that constraint or the gist/partial indexes, decline.
 *
 * Time convention (same as shared/booking.ts): absolute instants are
 * timestamptz (UTC); staff working hours live in staff-LOCAL time alongside an
 * IANA timezone string. `booking_appointments.timeslot` is a tstzrange that
 * INCLUDES service padding; `visible_start`/`visible_end` are what the client
 * sees (padding excluded).
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  time,
  date,
  timestamp,
  primaryKey,
  customType,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users, crmContacts } from "./schema";

/** Postgres tstzrange, surfaced as its text form e.g. `["2026-07-04 15:00:00+00","2026-07-04 16:15:00+00")` */
const tstzrange = customType<{ data: string }>({
  dataType() {
    return "tstzrange";
  },
});

export const bookingServices = pgTable("booking_services", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  durationMin: integer("duration_min").notNull(),
  paddingBeforeMin: integer("padding_before_min").notNull().default(0),
  paddingAfterMin: integer("padding_after_min").notNull().default(0),
  priceCents: integer("price_cents").notNull().default(0),
  depositCents: integer("deposit_cents").notNull().default(0),
  visible: boolean("visible").notNull().default(true),
  color: text("color"),
});

export const bookingStaff = pgTable("booking_staff", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  displayName: text("display_name").notNull(),
  timezone: text("timezone").notNull(), // IANA, e.g. 'America/New_York'
  gcalCalendarId: text("gcal_calendar_id"),
  gcalSyncEnabled: boolean("gcal_sync_enabled").notNull().default(false),
  active: boolean("active").notNull().default(true),
});

export const bookingStaffServices = pgTable(
  "booking_staff_services",
  {
    staffId: uuid("staff_id")
      .notNull()
      .references(() => bookingStaff.id),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => bookingServices.id),
    durationMinOverride: integer("duration_min_override"),
    priceCentsOverride: integer("price_cents_override"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.staffId, t.serviceId] }),
  }),
);

export const bookingSchedules = pgTable("booking_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  staffId: uuid("staff_id")
    .notNull()
    .references(() => bookingStaff.id),
  weekday: integer("weekday").notNull(), // 0 = Sunday … 6 = Saturday
  startLocal: time("start_local").notNull(),
  endLocal: time("end_local").notNull(),
});

export const bookingScheduleOverrides = pgTable("booking_schedule_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  staffId: uuid("staff_id")
    .notNull()
    .references(() => bookingStaff.id),
  dateLocal: date("date_local").notNull(),
  startLocal: time("start_local"), // NULL start+end = day off
  endLocal: time("end_local"),
});

export const bookingBusyBlocks = pgTable("booking_busy_blocks", {
  id: uuid("id").primaryKey().defaultRandom(),
  staffId: uuid("staff_id")
    .notNull()
    .references(() => bookingStaff.id),
  source: text("source").notNull(), // 'gcal'
  externalId: text("external_id"),
  span: tstzrange("span").notNull(),
});

export const BOOKING_V2_ACTIVE_STATUSES = ["hold", "pending", "confirmed"] as const;
export const BOOKING_V2_STATUSES = [
  "hold",
  "pending",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
] as const;
export const BOOKING_V2_PAYMENT_STATUSES = [
  "none",
  "deposit_pending",
  "deposit_paid",
  "paid",
  "refunded",
] as const;

export const bookingAppointments = pgTable("booking_appointments", {
  id: uuid("id").primaryKey().defaultRandom(),
  staffId: uuid("staff_id")
    .notNull()
    .references(() => bookingStaff.id),
  serviceId: uuid("service_id")
    .notNull()
    .references(() => bookingServices.id),
  clientId: integer("client_id")
    .notNull()
    .references(() => crmContacts.id),
  timeslot: tstzrange("timeslot").notNull(), // UTC, INCLUDES padding
  visibleStart: timestamp("visible_start", { withTimezone: true }).notNull(),
  visibleEnd: timestamp("visible_end", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("hold"),
  holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
  paymentStatus: text("payment_status").notNull().default("none"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  gcalEventId: text("gcal_event_id"),
  idempotencyKey: text("idempotency_key").unique(),
  clientTimezone: text("client_timezone").notNull(),
  notes: text("notes"),
  createdIp: text("created_ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Insert schemas (drizzle-zod) for the admin CRUD surface
// ---------------------------------------------------------------------------

const timeHHMM = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "expected HH:MM");
const ianaTz = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "invalid IANA timezone" },
);

export const insertBookingServiceSchema = createInsertSchema(bookingServices, {
  durationMin: z.number().int().positive(),
  paddingBeforeMin: z.number().int().min(0).optional(),
  paddingAfterMin: z.number().int().min(0).optional(),
  priceCents: z.number().int().min(0).optional(),
  depositCents: z.number().int().min(0).optional(),
}).omit({ id: true });

export const insertBookingStaffSchema = createInsertSchema(bookingStaff, {
  timezone: ianaTz,
}).omit({ id: true });

export const insertBookingScheduleSchema = createInsertSchema(bookingSchedules, {
  weekday: z.number().int().min(0).max(6),
  startLocal: timeHHMM,
  endLocal: timeHHMM,
}).omit({ id: true });

export const insertBookingScheduleOverrideSchema = createInsertSchema(bookingScheduleOverrides, {
  startLocal: timeHHMM.nullable().optional(),
  endLocal: timeHHMM.nullable().optional(),
}).omit({ id: true });

export type BookingService = typeof bookingServices.$inferSelect;
export type BookingStaff = typeof bookingStaff.$inferSelect;
export type BookingStaffService = typeof bookingStaffServices.$inferSelect;
export type BookingSchedule = typeof bookingSchedules.$inferSelect;
export type BookingScheduleOverride = typeof bookingScheduleOverrides.$inferSelect;
export type BookingBusyBlock = typeof bookingBusyBlocks.$inferSelect;
export type BookingAppointment = typeof bookingAppointments.$inferSelect;
export type InsertBookingService = z.infer<typeof insertBookingServiceSchema>;
export type InsertBookingStaff = z.infer<typeof insertBookingStaffSchema>;
export type InsertBookingSchedule = z.infer<typeof insertBookingScheduleSchema>;
export type InsertBookingScheduleOverride = z.infer<typeof insertBookingScheduleOverrideSchema>;
