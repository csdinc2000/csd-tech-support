import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { pool } from "./db";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { applyStaffInvitesMigration } from "./migrations/2026-09-23-staff-invites";
import { getStaffAccess, registerStaffAccessRoutes, roleFeatureMap, type StaffAccess } from "./staff-access";
import { authorizeStaffApiRequest } from "./api-auth-boundary";
import { requiredCapabilityForApiPath, requiredFeatureForApiPath } from "./security";

// Staff Access → Inbox & SMS / Calls & Tracking / Main Line Setup switches,
// end to end: saved by a staff administrator, read back as effective access,
// and enforced by the same decision the API auth boundary uses.

const marker = `comm-caps-${process.pid}-${Date.now()}`;
const ids = { admin: `${marker}-admin`, tech: `${marker}-tech`, accountant: `${marker}-accountant` };
let server: Server;
let baseUrl = "";

before(async () => {
  await applyStaffAccessMigration();
  await applyStaffInvitesMigration();
  for (const [name, id] of Object.entries(ids)) {
    await pool.query(
      `INSERT INTO auth_users(id,email,first_name,last_name) VALUES($1,$2,$3,'Caps') ON CONFLICT(id) DO NOTHING`,
      [id, `${id}@example.invalid`, name],
    );
  }
  await pool.query(
    `INSERT INTO staff_access_profiles(user_id,role,approval_status,can_view_voicemails,feature_permissions)
     VALUES ($1,'administrator','approved',TRUE,'{}'),($2,'field_technician','approved',TRUE,'{}'),
            ($3,'accounting','approved',TRUE,'{}')
     ON CONFLICT(user_id) DO NOTHING`,
    [ids.admin, ids.tech, ids.accountant],
  );
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = String(req.header("x-test-actor") || "");
    req.dbUser = { id: actor, email: `${actor}@example.invalid` } as any;
    next();
  });
  app.get("/test/staff-access", async (req, res) => { res.json(await getStaffAccess(req)); });
  registerStaffAccessRoutes(app, { isOwner: () => false });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await pool.query("DELETE FROM staff_access_audit WHERE target_user_id = ANY($1)", [Object.values(ids)]);
  await pool.query("DELETE FROM staff_access_profiles WHERE user_id = ANY($1)", [Object.values(ids)]);
  await pool.query("DELETE FROM auth_users WHERE id = ANY($1)", [Object.values(ids)]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const as = (actor: string, path: string, init?: RequestInit) =>
  fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", "x-test-actor": actor } });

async function accessOf(userId: string): Promise<StaffAccess> {
  return (await as(userId, "/test/staff-access")).json();
}

async function setSwitches(userId: string, role: "field_technician" | "accounting", capabilities: Record<string, boolean>) {
  const version = (await pool.query("SELECT updated_at FROM staff_access_profiles WHERE user_id=$1", [userId])).rows[0]?.updated_at;
  return as(ids.admin, `/api/staff-access/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({
      role,
      approvalStatus: "approved",
      capabilities: { viewVoicemails: true, ...capabilities },
      features: roleFeatureMap(role),
      expectedUpdatedAt: version ? new Date(version).toISOString() : null,
    }),
  });
}

const allowed = (access: StaffAccess, method: string, path: string) =>
  authorizeStaffApiRequest(path, method, access).allowed;

test("defaults: Inbox & SMS on, Calls & Tracking and Main Line Setup off", async () => {
  const access = await accessOf(ids.tech);
  assert.deepEqual(
    [access.capabilities.smsInbox, access.capabilities.callTracking, access.capabilities.mainLineSetup],
    [true, false, false],
  );
  assert.equal(allowed(access, "GET", "/api/sms/inbox"), true);
  assert.equal(allowed(access, "POST", "/api/call-tracking/numbers/purchase"), false);
  assert.equal(allowed(access, "PATCH", "/api/twilio/settings"), false);
  // Shared reads stay with communications.
  assert.equal(allowed(access, "GET", "/api/call-tracking/calls"), true);
  assert.equal(allowed(access, "GET", "/api/twilio/settings"), true);
});

test("switching tools on and off is saved, audited, and enforced", async () => {
  const on = await setSwitches(ids.tech, "field_technician", { smsInbox: false, callTracking: true, mainLineSetup: true });
  assert.equal(on.status, 200);
  const body = await on.json();
  assert.deepEqual(
    [body.capabilities.smsInbox, body.capabilities.callTracking, body.capabilities.mainLineSetup],
    [false, true, true],
  );

  const access = await accessOf(ids.tech);
  assert.equal(allowed(access, "GET", "/api/sms/inbox"), false, "inbox switched off");
  assert.equal(allowed(access, "POST", "/api/sms/send"), true, "business-card text still works");
  assert.equal(allowed(access, "POST", "/api/call-tracking/numbers/purchase"), true);
  assert.equal(allowed(access, "PATCH", "/api/call-tracking/flows/3"), true);
  assert.equal(allowed(access, "PATCH", "/api/twilio/settings"), true, "Main Line Setup unlocks the owner-only path");
  assert.equal(allowed(access, "DELETE", "/api/twilio/voicemail-greeting/audio"), true);
  assert.equal(allowed(access, "POST", "/api/twilio/a2p/register"), false, "A2P registration stays owner-only");

  const audit = await pool.query(
    "SELECT new_access FROM staff_access_audit WHERE target_user_id=$1 ORDER BY id DESC LIMIT 1",
    [ids.tech],
  );
  assert.deepEqual(audit.rows[0].new_access.capability_permissions, { smsInbox: false, callTracking: true, mainLineSetup: true });

  // An older client that only sends viewVoicemails keeps the saved switches.
  const legacy = await setSwitches(ids.tech, "field_technician", {});
  assert.equal(legacy.status, 200);
  assert.equal((await accessOf(ids.tech)).capabilities.mainLineSetup, true);

  assert.equal((await setSwitches(ids.tech, "field_technician", { callTracking: "yes" as any })).status, 400);
});

test("switches have no effect without the Communications feature", async () => {
  assert.equal(roleFeatureMap("accounting").communications, false);
  const saved = await setSwitches(ids.accountant, "accounting", { smsInbox: true, callTracking: true, mainLineSetup: true });
  assert.equal(saved.status, 200);
  const access = await accessOf(ids.accountant);
  assert.deepEqual(
    [access.capabilities.smsInbox, access.capabilities.callTracking, access.capabilities.mainLineSetup],
    [false, false, false],
  );
  assert.equal(allowed(access, "PATCH", "/api/twilio/settings"), false);
});

test("path map", () => {
  assert.deepEqual(requiredCapabilityForApiPath("/api/sms/inbox/9545550101", "PATCH"), ["smsInbox"]);
  assert.equal(requiredCapabilityForApiPath("/api/sms/send", "POST"), null);
  assert.deepEqual(requiredCapabilityForApiPath("/api/call-tracking/calls/12/ticket", "POST"), ["callTracking"]);
  assert.equal(requiredCapabilityForApiPath("/api/call-tracking/calls", "GET"), null);
  assert.equal(requiredCapabilityForApiPath("/api/call-tracking/analytics/by-day", "GET"), null);
  assert.deepEqual(requiredCapabilityForApiPath("/api/twilio/sync-webhooks", "POST"), ["mainLineSetup", "callTracking"]);
  assert.equal(requiredCapabilityForApiPath("/api/twilio/settings", "GET"), null);
  // Owner-only paths are unchanged for everyone without the switch.
  assert.equal(requiredFeatureForApiPath("/api/twilio/settings", "PATCH"), "owner");
});
