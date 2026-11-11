import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { pool } from "./db";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { applyStaffVoicePreferencesMigration } from "./migrations/2026-11-11-staff-voice-preferences";
import { loadAppRingIdentities, registerAppPhoneRoutes } from "./app-phone";

const marker = `app-phone-${process.pid}-${Date.now()}`;
const ids = { tech: `${marker}-tech`, accountant: `${marker}-accountant`, suspended: `${marker}-suspended` };
let server: Server;
let baseUrl = "";
let configured = true;

before(async () => {
  await applyStaffAccessMigration();
  await applyStaffVoicePreferencesMigration();
  for (const id of Object.values(ids)) {
    await pool.query(`INSERT INTO auth_users(id,email) VALUES($1,$2) ON CONFLICT(id) DO NOTHING`, [id, `${id}@example.invalid`]);
  }
  await pool.query(
    `INSERT INTO staff_access_profiles(user_id,role,approval_status,feature_permissions)
     VALUES ($1,'field_technician','approved','{}'),($2,'accounting','approved','{}'),($3,'field_technician','suspended','{}')
     ON CONFLICT(user_id) DO NOTHING`,
    [ids.tech, ids.accountant, ids.suspended],
  );
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.dbUser = { id: String(req.header("x-test-actor")) } as any; next(); });
  registerAppPhoneRoutes(app, {
    resolveVoiceConfig: async () => configured
      ? { accountSid: "AC" + "0".repeat(32), apiKeySid: "SK" + "1".repeat(32), apiKeySecret: "test-secret", twimlAppSid: null }
      : null,
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  await pool.query("DELETE FROM staff_voice_preferences WHERE user_id = ANY($1)", [Object.values(ids)]);
  await pool.query("DELETE FROM staff_access_profiles WHERE user_id = ANY($1)", [Object.values(ids)]);
  await pool.query("DELETE FROM auth_users WHERE id = ANY($1)", [Object.values(ids)]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const as = (actor: string, method: string, path: string, body?: unknown) =>
  fetch(`${baseUrl}${path}`, { method, headers: { "content-type": "application/json", "x-test-actor": actor }, body: body ? JSON.stringify(body) : undefined });

test("ring-in-app is off until the staff member turns it on; then a receive-only token is issued", async () => {
  assert.deepEqual(await (await as(ids.tech, "GET", "/api/twilio/app-phone")).json(), { ringInApp: false });
  assert.equal((await as(ids.tech, "POST", "/api/twilio/app-phone/token")).status, 409);

  assert.equal((await as(ids.tech, "PUT", "/api/twilio/app-phone", { ringInApp: true })).status, 200);
  assert.deepEqual(await (await as(ids.tech, "GET", "/api/twilio/app-phone")).json(), { ringInApp: true });

  const res = await as(ids.tech, "POST", "/api/twilio/app-phone/token");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.identity, ids.tech);
  const claims = JSON.parse(Buffer.from(String(body.token).split(".")[1], "base64url").toString("utf8"));
  assert.equal(claims.grants.identity, ids.tech);
  assert.equal(claims.grants.voice.incoming.allow, true);
  assert.equal(claims.grants.voice.outgoing, undefined, "answer-only token");

  configured = false;
  assert.equal((await as(ids.tech, "POST", "/api/twilio/app-phone/token")).status, 503);
  configured = true;
  assert.equal((await as(ids.tech, "PUT", "/api/twilio/app-phone", { ringInApp: "yes" })).status, 400);
});

test("only approved staff with communications are rung in the app", async () => {
  for (const id of Object.values(ids)) await as(id, "PUT", "/api/twilio/app-phone", { ringInApp: true });
  const identities = await loadAppRingIdentities();
  assert.ok(identities.includes(ids.tech));
  assert.ok(!identities.includes(ids.accountant), "accounting has no communications feature");
  assert.ok(!identities.includes(ids.suspended), "suspended staff are never rung");
  await as(ids.tech, "PUT", "/api/twilio/app-phone", { ringInApp: false });
  assert.ok(!(await loadAppRingIdentities()).includes(ids.tech));
});
