/**
 * Booking Engine v2 — client self-service appointment booking.
 *
 * Creates the `booking_*` engine tables plus the `btree_gist` extension so
 * double-booking is impossible AT THE DATABASE LEVEL: an EXCLUDE constraint on
 * booking_appointments rejects any two overlapping tstzranges for the same
 * staff member while either row is in an active status ('hold','pending',
 * 'confirmed'). Concurrent inserts race on the constraint, not on app code —
 * the loser gets SQLSTATE 23P01 and the API maps that to 409 {slot_taken}.
 *
 * Deviations from the original spec schema (documented in the Phase 1 report):
 *   - booking_staff.user_id        integer → FK to existing users(id)        (serial int, not uuid)
 *   - booking_appointments.client_id integer → FK to existing crm_contacts(id) (serial int, not uuid)
 *   - booking_appointments.created_ip text — needed for the "max 3 active
 *     holds per client email/IP" abuse guard.
 *
 * Idempotent — safe to re-run on every boot (same pattern as the other
 * hand-rolled migrations in this directory). Lives here rather than db:push
 * because Drizzle cannot emit EXCLUDE constraints or CREATE EXTENSION.
 */
import { pool } from "../db";

export const BOOKING_ENGINE_MIGRATION_SQL = `
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS booking_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  duration_min int NOT NULL CHECK (duration_min > 0),
  padding_before_min int NOT NULL DEFAULT 0,
  padding_after_min int NOT NULL DEFAULT 0,
  price_cents int NOT NULL DEFAULT 0,
  deposit_cents int NOT NULL DEFAULT 0,
  visible boolean NOT NULL DEFAULT true,
  color text
);

CREATE TABLE IF NOT EXISTS booking_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id integer NOT NULL REFERENCES users(id),
  display_name text NOT NULL,
  timezone text NOT NULL,
  gcal_calendar_id text,
  gcal_sync_enabled boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS booking_staff_services (
  staff_id uuid NOT NULL REFERENCES booking_staff(id),
  service_id uuid NOT NULL REFERENCES booking_services(id),
  duration_min_override int,
  price_cents_override int,
  PRIMARY KEY (staff_id, service_id)
);

CREATE TABLE IF NOT EXISTS booking_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES booking_staff(id),
  weekday int NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_local time NOT NULL,
  end_local time NOT NULL
);

CREATE TABLE IF NOT EXISTS booking_schedule_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES booking_staff(id),
  date_local date NOT NULL,
  start_local time,
  end_local time
);

CREATE TABLE IF NOT EXISTS booking_busy_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES booking_staff(id),
  source text NOT NULL,
  external_id text,
  span tstzrange NOT NULL,
  UNIQUE (staff_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS booking_busy_blocks_staff_span_idx
  ON booking_busy_blocks USING gist (staff_id, span);

CREATE TABLE IF NOT EXISTS booking_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES booking_staff(id),
  service_id uuid NOT NULL REFERENCES booking_services(id),
  client_id integer NOT NULL REFERENCES crm_contacts(id),
  timeslot tstzrange NOT NULL,
  visible_start timestamptz NOT NULL,
  visible_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'hold'
    CHECK (status IN ('hold','pending','confirmed','cancelled','completed','no_show')),
  hold_expires_at timestamptz,
  payment_status text NOT NULL DEFAULT 'none'
    CHECK (payment_status IN ('none','deposit_pending','deposit_paid','paid','refunded')),
  stripe_payment_intent_id text,
  gcal_event_id text,
  idempotency_key text UNIQUE,
  client_timezone text NOT NULL,
  notes text,
  created_ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_appointments_no_overlap
    EXCLUDE USING gist (staff_id WITH =, timeslot WITH &&)
    WHERE (status IN ('hold','pending','confirmed'))
);
CREATE INDEX IF NOT EXISTS booking_appointments_staff_start_idx
  ON booking_appointments (staff_id, visible_start);
CREATE INDEX IF NOT EXISTS booking_appointments_hold_expiry_idx
  ON booking_appointments (hold_expires_at) WHERE status = 'hold';
`;

export async function applyBookingEngineMigration() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(BOOKING_ENGINE_MIGRATION_SQL);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function run() {
  try {
    await applyBookingEngineMigration();
    console.log("✓ Booking engine migration applied");
  } catch (err) {
    console.error("✗ Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1]?.endsWith("2026-07-04-booking-engine.ts") ?? false;
if (isDirectRun) {
  run();
}
