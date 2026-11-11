import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import { createServer, type Server } from "node:http";
import { pool } from "./db";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { applyIntakeIdempotencyMigration } from "./migrations/2026-07-17-intake-idempotency";
import { applyCustomerPhotosMigration } from "./migrations/2026-10-22-customer-photos";
import {
  decodeCustomerPhoto,
  getClientAvatarSummary,
  registerCustomerPhotoRoutes,
  saveIntakeDevicePhoto,
} from "./customer-photos";

const marker = `customer-photos-${process.pid}-${Date.now()}`;
const ownerId = `${marker}-owner`;
const ownerEmail = `${marker}-owner@example.invalid`;
const outsiderId = `${marker}-outsider`;
let oldAdminEmails: string | undefined;
let server: Server;
let baseUrl = "";
let clientId = 0;
const intakeIds: number[] = [];

// Minimal byte sequences that pass the magic-byte sniff.
const jpegA = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]);
const jpegB = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0xff, 0xd9]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function request(path: string, actor: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-test-actor": actor, ...init?.headers },
  });
}

async function insertIntake(): Promise<number> {
  const result = await pool.query(
    `INSERT INTO csd_intake_records
      (customer_name, phone_number, email_address, contact_preference, service_type, device_type,
       device_brand_model, operating_system, problem_description, how_did_you_hear, is_from_active_call)
     VALUES ($1, '', $2, 'email', 'Repair', 'Laptop', 'Dell XPS', 'Windows 11', 'Will not boot', 'Google Search', FALSE)
     RETURNING id`,
    [marker, `${marker}@example.invalid`],
  );
  const id = Number(result.rows[0].id);
  intakeIds.push(id);
  return id;
}

before(async () => {
  oldAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = ownerEmail;
  await applyStaffAccessMigration();
  await applyIntakeIdempotencyMigration();
  await applyCustomerPhotosMigration();
  for (const [id, email] of [[ownerId, ownerEmail], [outsiderId, `${outsiderId}@example.invalid`]]) {
    await pool.query(
      `INSERT INTO auth_users(id,email,first_name,last_name) VALUES($1,$2,'Photo','Test')
       ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email`,
      [id, email],
    );
  }
  // The outsider is approved staff with no assignments: restricted scope.
  await pool.query(
    `INSERT INTO staff_access_profiles(user_id,role,approval_status,can_view_voicemails,feature_permissions)
     VALUES ($1,'administrator','approved',TRUE,'{}'), ($2,'accounting','approved',FALSE,'{}')
     ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role, approval_status=EXCLUDED.approval_status`,
    [ownerId, outsiderId],
  );
  const client = await pool.query(
    "INSERT INTO clients(name,contact_email) VALUES($1,$2) RETURNING id",
    [marker, `${marker}@example.invalid`],
  );
  clientId = Number(client.rows[0].id);

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    const actorId = String(req.header("x-test-actor") || "");
    const email = actorId === ownerId ? ownerEmail : `${actorId}@example.invalid`;
    (req as any).auth = Object.assign(() => ({ userId: actorId, sessionClaims: { userId: actorId, email } }), {
      [Symbol.for("@clerk/express.auth")]: true,
    });
    req.dbUser = {
      id: actorId, email, firstName: null, lastName: null, profileImageUrl: null,
      stripeCustomerId: null, stripeSubscriptionId: null, createdAt: new Date(), updatedAt: new Date(),
    };
    next();
  });
  registerCustomerPhotoRoutes(app, {
    canSeeClient: (scope, id) => scope.unrestricted || (id != null && scope.clientIds.has(id)),
  });
  server = createServer(app);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query("DELETE FROM client_avatars WHERE client_id = $1", [clientId]);
  await pool.query("DELETE FROM intake_submissions WHERE intake_record_id = ANY($1::int[])", [intakeIds]);
  await pool.query("DELETE FROM csd_intake_records WHERE id = ANY($1::int[])", [intakeIds]);
  await pool.query("DELETE FROM clients WHERE id = $1", [clientId]);
  await pool.query("DELETE FROM staff_access_profiles WHERE user_id = ANY($1::text[])", [[ownerId, outsiderId]]);
  await pool.query("DELETE FROM auth_users WHERE id = ANY($1::text[])", [[ownerId, outsiderId]]);
  if (oldAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = oldAdminEmails;
});

test("photo decoding trusts magic bytes, not the declared type", () => {
  assert.equal(decodeCustomerPhoto({ dataBase64: `data:image/png;base64,${jpegA.toString("base64")}` }).mimeType, "image/jpeg");
  assert.equal(decodeCustomerPhoto({ dataBase64: png.toString("base64") }).mimeType, "image/png");
  assert.throws(() => decodeCustomerPhoto({ dataBase64: Buffer.from("<svg/>").toString("base64") }), /JPEG, PNG or WebP/);
});

test("an intake photo fills an empty avatar but never replaces an existing one", async () => {
  const first = await insertIntake();
  await saveIntakeDevicePhoto(pool, { intakeRecordId: first, clientId, photo: decodeCustomerPhoto({ dataBase64: jpegA.toString("base64") }) });
  const summary = await getClientAvatarSummary(clientId);
  assert.equal(summary?.source, "intake");
  assert.match(summary!.url, new RegExp(`^/api/clients/${clientId}/avatar\\?v=\\d+$`));

  const second = await insertIntake();
  await saveIntakeDevicePhoto(pool, { intakeRecordId: second, clientId, photo: decodeCustomerPhoto({ dataBase64: jpegB.toString("base64") }) });
  const avatar = await request(`/api/clients/${clientId}/avatar`, ownerId);
  assert.equal(avatar.status, 200);
  assert.equal(avatar.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await avatar.arrayBuffer()), jpegA);

  // Both intakes keep their own photo.
  const secondPhoto = await request(`/api/intake/${second}/device-photo`, ownerId);
  assert.equal(secondPhoto.status, 200);
  assert.deepEqual(Buffer.from(await secondPhoto.arrayBuffer()), jpegB);
});

test("an unlinked intake keeps its photo without creating an avatar", async () => {
  const intakeId = await insertIntake();
  await saveIntakeDevicePhoto(pool, { intakeRecordId: intakeId, clientId: null, photo: decodeCustomerPhoto({ dataBase64: png.toString("base64") }) });
  const photo = await request(`/api/intake/${intakeId}/device-photo`, ownerId);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get("content-type"), "image/png");
  // Restricted staff cannot see photos from intakes outside their scope.
  assert.equal((await request(`/api/intake/${intakeId}/device-photo`, outsiderId)).status, 404);
});

test("staff can replace and remove the avatar; restricted staff cannot", async () => {
  const body = JSON.stringify({ dataBase64: png.toString("base64") });
  assert.equal((await request(`/api/clients/${clientId}/avatar`, outsiderId, { method: "PUT", body })).status, 404);
  assert.equal((await request(`/api/clients/${clientId}/avatar`, outsiderId)).status, 404);

  const rejected = await request(`/api/clients/${clientId}/avatar`, ownerId, {
    method: "PUT",
    body: JSON.stringify({ dataBase64: Buffer.from("<html>").toString("base64") }),
  });
  assert.equal(rejected.status, 400);

  const saved = await request(`/api/clients/${clientId}/avatar`, ownerId, { method: "PUT", body });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal(((await saved.json()) as any).avatar.source, "staff");
  const stored = await pool.query("SELECT source, uploaded_by_user_id, intake_record_id FROM client_avatars WHERE client_id = $1", [clientId]);
  assert.deepEqual(stored.rows[0], { source: "staff", uploaded_by_user_id: ownerId, intake_record_id: null });
  const avatar = await request(`/api/clients/${clientId}/avatar`, ownerId);
  assert.equal(avatar.headers.get("content-type"), "image/png");

  // A later intake still cannot overwrite the staff photo.
  const intakeId = await insertIntake();
  await saveIntakeDevicePhoto(pool, { intakeRecordId: intakeId, clientId, photo: decodeCustomerPhoto({ dataBase64: jpegB.toString("base64") }) });
  assert.equal((await getClientAvatarSummary(clientId))?.source, "staff");

  assert.equal((await request(`/api/clients/${clientId}/avatar`, ownerId, { method: "DELETE" })).status, 200);
  assert.equal((await request(`/api/clients/${clientId}/avatar`, ownerId)).status, 404);
  assert.equal(await getClientAvatarSummary(clientId), null);
});
