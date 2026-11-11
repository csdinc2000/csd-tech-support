import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import { createServer, type Server } from "node:http";
import { pool } from "./db";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { applyStaffAvatarsMigration } from "./migrations/2026-11-06-staff-avatars";
import { registerStaffProfileRoutes } from "./staff-profile";
import { requiredFeatureForApiPath } from "./security";
import { isPublicApiRequest } from "./api-auth-boundary";

const marker = `staff-profile-${process.pid}-${Date.now()}`;
const techId = `${marker}-tech`;
const otherId = `${marker}-other`;
let server: Server;
let baseUrl = "";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]);

function request(path: string, actor: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-test-actor": actor, ...init?.headers },
  });
}

before(async () => {
  await applyStaffAccessMigration();
  await applyStaffAvatarsMigration();
  for (const id of [techId, otherId]) {
    await pool.query(
      `INSERT INTO auth_users(id,email,first_name,last_name) VALUES($1,$2,'Tess','Tech')
       ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email`,
      [id, `${id}@example.invalid`],
    );
  }
  await pool.query(
    `INSERT INTO staff_access_profiles(user_id,role,approval_status,can_view_voicemails,feature_permissions)
     VALUES ($1,'field_technician','approved',TRUE,'{}'), ($2,'secretary','approved',FALSE,'{}')
     ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role, approval_status=EXCLUDED.approval_status`,
    [techId, otherId],
  );
  await pool.query(
    `INSERT INTO staff_directory_details(user_id, job_title, department) VALUES ($1, 'Bench Technician', 'Repairs')
     ON CONFLICT(user_id) DO UPDATE SET job_title=EXCLUDED.job_title, department=EXCLUDED.department`,
    [techId],
  );

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    const actorId = String(req.header("x-test-actor") || "");
    const email = `${actorId}@example.invalid`;
    (req as any).auth = Object.assign(() => ({ userId: actorId, sessionClaims: { userId: actorId, email } }), {
      [Symbol.for("@clerk/express.auth")]: true,
    });
    req.dbUser = {
      id: actorId, email, firstName: null, lastName: null, profileImageUrl: null,
      stripeCustomerId: null, stripeSubscriptionId: null, createdAt: new Date(), updatedAt: new Date(),
    };
    next();
  });
  registerStaffProfileRoutes(app);
  server = createServer(app);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query("DELETE FROM auth_users WHERE id = ANY($1::text[])", [[techId, otherId]]);
});

test("staff profile routes require a signed-in approved staff session with no extra feature", () => {
  for (const [method, path] of [
    ["GET", "/api/staff-profile/me"],
    ["PUT", "/api/staff-profile/me/avatar"],
    ["DELETE", "/api/staff-profile/me/avatar"],
    ["GET", "/api/staff-profile/user_123/avatar"],
  ] as const) {
    assert.equal(isPublicApiRequest(method, path), false);
    assert.equal(requiredFeatureForApiPath(path, method), null);
  }
});

test("a technician sees their profile and can add, view and remove their picture", async () => {
  const empty = await request("/api/staff-profile/me", techId);
  assert.equal(empty.status, 200);
  const profile = (await empty.json()) as Record<string, unknown>;
  assert.equal(profile.id, techId);
  assert.equal(profile.role, "field_technician");
  assert.equal(profile.jobTitle, "Bench Technician");
  assert.equal(profile.department, "Repairs");
  assert.equal(profile.avatar, null);

  const bad = await request("/api/staff-profile/me/avatar", techId, {
    method: "PUT", body: JSON.stringify({ dataBase64: Buffer.from("<svg/>").toString("base64") }),
  });
  assert.equal(bad.status, 400);

  const saved = await request("/api/staff-profile/me/avatar", techId, {
    method: "PUT", body: JSON.stringify({ dataBase64: `data:image/png;base64,${jpeg.toString("base64")}` }),
  });
  assert.equal(saved.status, 200);
  const { avatar } = (await saved.json()) as { avatar: { url: string } };
  assert.match(avatar.url, new RegExp(`^/api/staff-profile/${techId}/avatar\\?v=\\d+$`));

  // Colleagues can see the picture.
  const image = await request(avatar.url, otherId);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);

  // Another staff member's delete only touches their own (empty) picture.
  assert.equal((await request("/api/staff-profile/me/avatar", otherId, { method: "DELETE" })).status, 200);
  assert.equal((await request(avatar.url, techId)).status, 200);

  assert.equal((await request("/api/staff-profile/me/avatar", techId, { method: "DELETE" })).status, 200);
  assert.equal((await request(avatar.url, techId)).status, 404);
});
