import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { pool } from "./db";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { registerBookingRoutes } from "./booking/booking-routes";

// Covers the staff schedule feed behind the technician board: window filtering
// and assignment scoping for GET /api/booking/appointments.
const marker = `board-appointments-${process.pid}-${Date.now()}`;
const ids = {
  owner: `${marker}-owner`,
  scoped: `${marker}-scoped`,
  unassigned: `${marker}-unassigned`,
};
const ownerEmail = `${marker}-owner@example.invalid`;
let oldAdminEmails: string | undefined;
let server: Server;
let baseUrl = "";
let serviceId = 0;
let contactIds: number[] = [];
let appointmentIds: number[] = [];

const DAY = new Date("2026-09-21T14:00:00.000Z");
const at = (hoursFromDay: number) => new Date(DAY.getTime() + hoursFromDay * 3_600_000);

function request(path: string, actor: keyof typeof ids) {
  return fetch(`${baseUrl}${path}`, { headers: { "x-test-actor": ids[actor] } });
}

before(async () => {
  oldAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = ownerEmail;
  await applyStaffAccessMigration();

  for (const [actor, id] of Object.entries(ids)) {
    await pool.query(
      `INSERT INTO auth_users(id,email,first_name,last_name)
       VALUES($1,$2,$3,'Board Test') ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email`,
      [id, actor === "owner" ? ownerEmail : `${id}@example.invalid`, actor],
    );
  }
  await pool.query(
    `INSERT INTO staff_access_profiles(user_id,role,approval_status,can_view_voicemails,feature_permissions)
     VALUES ($1,'administrator','approved',TRUE,'{}'),($2,'field_technician','approved',FALSE,'{}'),($3,'field_technician','approved',FALSE,'{}')
     ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role,approval_status=EXCLUDED.approval_status`,
    [ids.owner, ids.scoped, ids.unassigned],
  );

  const service = await pool.query(
    "INSERT INTO services(name,slug,duration_minutes) VALUES($1,$2,45) RETURNING id",
    [`${marker} Diagnostic`, marker],
  );
  serviceId = Number(service.rows[0].id);
  const contacts = await pool.query(
    "INSERT INTO crm_contacts(full_name) VALUES($1),($2) RETURNING id",
    [`${marker}-assigned`, `${marker}-hidden`],
  );
  contactIds = contacts.rows.map((row) => Number(row.id));
  await pool.query(
    "INSERT INTO staff_contact_assignments(user_id,contact_id,can_edit) VALUES($1,$2,FALSE)",
    [ids.scoped, contactIds[0]],
  );

  const rows: [string, number | null, Date, Date, string][] = [
    [`${marker}-A-1`, contactIds[0], at(0), at(1), "confirmed"],   // assigned contact, in window
    [`${marker}-A-2`, contactIds[1], at(2), at(3), "confirmed"],   // hidden contact, in window
    [`${marker}-A-3`, null, at(4), at(5), "pending"],              // guest booking, in window
    [`${marker}-A-4`, contactIds[0], at(48), at(49), "confirmed"], // assigned contact, outside window
  ];
  for (const [reference, contactId, startsAt, endsAt, status] of rows) {
    const inserted = await pool.query(
      `INSERT INTO appointments(reference,service_id,contact_id,customer_name,customer_email,starts_at,ends_at,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [reference, serviceId, contactId, `${marker} customer`, `${marker}@example.invalid`, startsAt, endsAt, status],
    );
    appointmentIds.push(Number(inserted.rows[0].id));
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actorId = String(req.header("x-test-actor") || "");
    const email = actorId === ids.owner ? ownerEmail : `${actorId}@example.invalid`;
    (req as any).auth = Object.assign(() => ({
      userId: actorId,
      sessionClaims: { userId: actorId, email },
    }), { [Symbol.for("@clerk/express.auth")]: true });
    req.dbUser = {
      id: actorId,
      email,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    (req as any).log = { error() {}, warn() {}, info() {} };
    next();
  });
  registerBookingRoutes(app);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query("DELETE FROM appointments WHERE id = ANY($1::int[])", [appointmentIds]);
  await pool.query("DELETE FROM services WHERE id = $1", [serviceId]);
  await pool.query("DELETE FROM staff_contact_assignments WHERE user_id = $1", [ids.scoped]);
  await pool.query("DELETE FROM crm_contacts WHERE id = ANY($1::int[])", [contactIds]);
  await pool.query("DELETE FROM staff_access_profiles WHERE user_id = ANY($1::text[])", [Object.values(ids)]);
  await pool.query("DELETE FROM auth_users WHERE id = ANY($1::text[])", [Object.values(ids)]);
  if (oldAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = oldAdminEmails;
});

const windowQuery = `from=${at(-1).toISOString()}&to=${at(24).toISOString()}`;
const mine = (body: any[]) => body.filter((row) => String(row.reference).startsWith(marker)).map((row) => row.reference);

test("owners see every appointment in the window, joined with the service name", async () => {
  const response = await request(`/api/booking/appointments?${windowQuery}`, "owner");
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as any[];
  assert.deepEqual(mine(body), [`${marker}-A-1`, `${marker}-A-2`, `${marker}-A-3`]);
  const first = body.find((row) => row.reference === `${marker}-A-1`);
  assert.equal(first.serviceName, `${marker} Diagnostic`);
  assert.equal(first.serviceDurationMinutes, 45);
});

test("status filter narrows the window", async () => {
  const response = await request(`/api/booking/appointments?${windowQuery}&status=pending`, "owner");
  assert.deepEqual(mine(await response.json() as any[]), [`${marker}-A-3`]);
});

test("assignment-scoped staff only see appointments for their contacts", async () => {
  const scoped = await request(`/api/booking/appointments?${windowQuery}`, "scoped");
  assert.equal(scoped.status, 200);
  assert.deepEqual(mine(await scoped.json() as any[]), [`${marker}-A-1`]);

  const unassigned = await request(`/api/booking/appointments?${windowQuery}`, "unassigned");
  assert.equal(unassigned.status, 200);
  assert.deepEqual(mine(await unassigned.json() as any[]), []);
});

test("rejects malformed or inverted windows", async () => {
  assert.equal((await request("/api/booking/appointments?from=yesterday", "owner")).status, 400);
  assert.equal((await request(`/api/booking/appointments?from=${at(2).toISOString()}&to=${at(1).toISOString()}`, "owner")).status, 400);
});
