import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign as signPayload } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { pool } from "./db";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { applyStaffInvitesMigration } from "./migrations/2026-09-23-staff-invites";
import { applySharedRateLimitsMigration } from "./migrations/2026-09-16-shared-rate-limits";
import { registerStaffInviteDeliveryWebhook, registerStaffInviteRoutes } from "./staff-invites";

test("invites bind verified identity, accept once, and safely link a pre-existing account", async () => {
  await applyStaffAccessMigration();
  await applySharedRateLimitsMigration();
  await applyStaffInvitesMigration();
  const suffix = `${process.pid}-${Date.now()}`;
  const email = `invite-${suffix}@example.invalid`;
  const oldId = `legacy-invite-${suffix}`;
  const newId = `user_new-${suffix}`;
  const clerkId = `user_clerk-${suffix}`;
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  let inviteId: string | undefined;

  try {
    await pool.query(
      "INSERT INTO auth_users(id,email,first_name) VALUES($1,$3,'Existing'),($2,NULL,NULL)",
      [oldId, newId, email],
    );
    const inserted = await pool.query(
      `INSERT INTO staff_invites(email,role,token_hash,expires_at)
       VALUES($1,'field_technician',$2,NOW() + INTERVAL '7 days') RETURNING id`,
      [email, hash],
    );
    inviteId = inserted.rows[0].id;
    const app = express();
    app.set("trust proxy", true);
    app.use(express.json());
    app.use((req, _res, next) => {
      req.dbUser = { id: newId } as NonNullable<typeof req.dbUser>;
      next();
    });
    registerStaffInviteRoutes(app, {
      requireSignedIn: (_req, _res, next) => next(),
      verifyIdentity: async (req) => ({
        email: String(req.header("x-verified-email") || ""),
        firstName: "Existing",
        lastName: "Staff",
      }),
      clerkUserId: () => clerkId,
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start invite test server");
    const base = `http://127.0.0.1:${address.port}`;
    const post = (path: string, verifiedEmail: string, details: Record<string, unknown> = {}) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-verified-email": verifiedEmail,
          "x-forwarded-for": `198.51.100.${(process.pid % 240) + 1}`,
        },
        body: JSON.stringify({ token, ...details }),
      });

    const valid = await post("/api/public/staff-invites/validate", "");
    assert.equal(valid.status, 200);
    assert.equal((await valid.json() as { email: string }).email, email);
    const names = { firstName: "Test", lastName: "Staff" };
    const missingProfile = await post("/api/public/staff-invites/accept", email);
    assert.equal(missingProfile.status, 400);
    const wrongEmail = await post("/api/public/staff-invites/accept", "someone-else@example.invalid", names);
    assert.equal(wrongEmail.status, 403);
    assert.equal((await pool.query("SELECT accepted_at FROM staff_invites WHERE id=$1", [inviteId])).rows[0].accepted_at, null);

    const accepted = await post("/api/public/staff-invites/accept", email, names);
    const acceptedBody = await accepted.text();
    assert.equal(accepted.status, 200, acceptedBody);
    assert.equal((JSON.parse(acceptedBody) as { approvalStatus: string }).approvalStatus, "pending");
    const profile = await pool.query(
      "SELECT role,approval_status,approved_at FROM staff_access_profiles WHERE user_id=$1",
      [oldId],
    );
    assert.equal(profile.rows[0].role, "field_technician");
    assert.equal(profile.rows[0].approval_status, "pending");
    assert.equal(profile.rows[0].approved_at, null);
    const updatedIdentity = await pool.query("SELECT first_name,last_name FROM auth_users WHERE id=$1", [oldId]);
    assert.deepEqual(updatedIdentity.rows[0], { first_name: "Test", last_name: "Staff" });
    assert.equal((await pool.query("SELECT id FROM auth_users WHERE id=$1", [newId])).rowCount, 1);
    assert.equal((await pool.query("SELECT user_id FROM staff_access_profiles WHERE user_id=$1", [newId])).rowCount, 0);
    assert.equal((await pool.query(
      "SELECT auth_user_id FROM auth_user_clerk_links WHERE clerk_user_id=$1",
      [clerkId],
    )).rows[0].auth_user_id, oldId);
    assert.equal((await pool.query("SELECT token_hash FROM staff_invites WHERE id=$1", [inviteId])).rows[0].token_hash, hash);
    assert.equal((await post("/api/public/staff-invites/accept", email, names)).status, 410);
    assert.equal((await post("/api/public/staff-invites/validate", "")).status, 410);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (inviteId) await pool.query("DELETE FROM staff_invites WHERE id=$1", [inviteId]);
    await pool.query("DELETE FROM staff_access_audit WHERE target_user_id=$1", [oldId]);
    await pool.query("DELETE FROM staff_access_profiles WHERE user_id=$1", [oldId]);
    await pool.query("DELETE FROM auth_user_clerk_links WHERE clerk_user_id=$1", [clerkId]);
    await pool.query("DELETE FROM auth_users WHERE id=ANY($1::text[])", [[oldId, newId]]);
  }
});

test("an existing sign-in account must accept its own invitation and does not become a duplicate staff identity", async () => {
  const suffix = `${process.pid}-${Date.now()}-existing`;
  const id = `user_existing-${suffix}`;
  const email = `existing-${suffix}@example.invalid`;
  const token = randomBytes(32).toString("base64url");
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  let inviteId: string | undefined;
  try {
    await pool.query("INSERT INTO auth_users(id,email) VALUES($1,$2)", [id, email]);
    const row = await pool.query(
      "INSERT INTO staff_invites(email,role,token_hash,expires_at) VALUES($1,'field_technician',$2,NOW()+INTERVAL '1 day') RETURNING id",
      [email, createHash("sha256").update(token).digest("hex")],
    );
    inviteId = row.rows[0].id;
    const app = express();
    app.set("trust proxy", true);
    app.use(express.json());
    app.use((req, _res, next) => { req.dbUser = { id } as NonNullable<typeof req.dbUser>; next(); });
    registerStaffInviteRoutes(app, {
      requireSignedIn: (_req, _res, next) => next(),
      clerkUserId: () => id,
      verifyIdentity: async (req) => req.header("x-verified-email") ? {
        email: req.header("x-verified-email")!, firstName: "Existing", lastName: "Invitee",
      } : null,
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server failed");
    const post = (verifiedEmail: string, inviteToken = token) => fetch(
      `http://127.0.0.1:${address.port}/api/public/staff-invites/accept`,
      { method: "POST", headers: {
        "Content-Type": "application/json",
        "x-verified-email": verifiedEmail,
        "x-forwarded-for": `203.0.113.${(process.pid % 240) + 1}`,
      },
        body: JSON.stringify({ token: inviteToken, firstName: "Existing", lastName: "Invitee" }) },
    );
    assert.equal((await post(email, randomBytes(32).toString("base64url"))).status, 404);
    assert.equal((await post("")).status, 403);
    assert.equal((await post("wrong@example.invalid")).status, 403);
    assert.equal((await pool.query("SELECT 1 FROM staff_access_profiles WHERE user_id=$1", [id])).rowCount, 0);
    const response = await post(email);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json() as { approvalStatus: string }).approvalStatus, "pending");
    assert.equal((await pool.query("SELECT accepted_by FROM staff_invites WHERE id=$1", [inviteId])).rows[0].accepted_by, id);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM auth_users WHERE email=$1", [email])).rows[0].count, 1);
    assert.equal((await post(email)).status, 410);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (inviteId) await pool.query("DELETE FROM staff_invites WHERE id=$1", [inviteId]);
    await pool.query("DELETE FROM staff_access_audit WHERE target_user_id=$1", [id]);
    await pool.query("DELETE FROM staff_access_profiles WHERE user_id=$1", [id]);
    await pool.query("DELETE FROM auth_users WHERE id=$1", [id]);
  }
});

test("creating an owner invitation submits an email containing the one-time invite link", async () => {
  await applyStaffAccessMigration();
  await applySharedRateLimitsMigration();
  await applyStaffInvitesMigration();
  const email = `invite-send-${process.pid}-${Date.now()}@example.invalid`;
  let inviteId: string | undefined;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  const sent: Array<{ to: string; inviteUrl: string; role: string; inviteId: string }> = [];
  try {
    const app = express();
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    registerStaffInviteDeliveryWebhook(app, {
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    app.use(express.json());
    registerStaffInviteRoutes(app, {
      requireAdmin: (_req, _res, next) => next(),
      sendInviteEmail: async (to, inviteUrl, role, id) => { sent.push({ to, inviteUrl, role, inviteId: id }); },
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start invite email test server");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/staff-access/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, role: "field_technician" }),
    });
    const result = await response.json() as {
      invite: { id: string; emailDeliveryStatus: string };
      invitePath: string;
      emailSent: boolean;
    };
    inviteId = result.invite.id;
    assert.equal(response.status, 201);
    assert.equal(result.emailSent, true);
    assert.equal(result.invite.emailDeliveryStatus, "accepted");
    assert.deepEqual(sent[0], { to: email, role: "field_technician", inviteUrl: result.invitePath, inviteId });
    assert.match(result.invitePath, /^\/staff-invite#[A-Za-z0-9_-]{40,100}$/);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = Buffer.from(JSON.stringify([{
      event: "delivered",
      timestamp: Number(timestamp),
      custom_args: { staff_invite_id: inviteId },
    }]));
    const signature = signPayload(
      "sha256",
      Buffer.concat([Buffer.from(timestamp), payload]),
      privateKey,
    ).toString("base64");
    const webhookResponse = await fetch(`http://127.0.0.1:${address.port}/api/webhooks/sendgrid-events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Twilio-Email-Event-Webhook-Signature": signature,
        "X-Twilio-Email-Event-Webhook-Timestamp": timestamp,
      },
      body: payload,
    });
    assert.equal(webhookResponse.status, 200);

    const listing = await fetch(`http://127.0.0.1:${address.port}/api/staff-access/invites`);
    const listed = await listing.json() as Array<{ id: string; emailDeliveryStatus: string }>;
    assert.equal(listed.find((invite) => invite.id === inviteId)?.emailDeliveryStatus, "delivered");

    const tamperedPayload = Buffer.from(JSON.stringify([{
      event: "bounce",
      timestamp: Number(timestamp) + 3,
      custom_args: { staff_invite_id: inviteId },
    }]));
    const tamperedResponse = await fetch(`http://127.0.0.1:${address.port}/api/webhooks/sendgrid-events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Twilio-Email-Event-Webhook-Signature": signature,
        "X-Twilio-Email-Event-Webhook-Timestamp": timestamp,
      },
      body: tamperedPayload,
    });
    assert.equal(tamperedResponse.status, 401);

    const bouncePayload = Buffer.from(JSON.stringify([{
      event: "bounce",
      timestamp: Number(timestamp) + 2,
      custom_args: { staff_invite_id: inviteId },
    }]));
    const bounceSignature = signPayload(
      "sha256",
      Buffer.concat([Buffer.from(timestamp), bouncePayload]),
      privateKey,
    ).toString("base64");
    const bounceResponse = await fetch(`http://127.0.0.1:${address.port}/api/webhooks/sendgrid-events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Twilio-Email-Event-Webhook-Signature": bounceSignature,
        "X-Twilio-Email-Event-Webhook-Timestamp": timestamp,
      },
      body: bouncePayload,
    });
    assert.equal(bounceResponse.status, 200);

    const olderPayload = Buffer.from(JSON.stringify([{
      event: "delivered",
      timestamp: Number(timestamp) + 1,
      custom_args: { staff_invite_id: inviteId },
    }]));
    const olderSignature = signPayload(
      "sha256",
      Buffer.concat([Buffer.from(timestamp), olderPayload]),
      privateKey,
    ).toString("base64");
    const olderResponse = await fetch(`http://127.0.0.1:${address.port}/api/webhooks/sendgrid-events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Twilio-Email-Event-Webhook-Signature": olderSignature,
        "X-Twilio-Email-Event-Webhook-Timestamp": timestamp,
      },
      body: olderPayload,
    });
    assert.equal(olderResponse.status, 200);
    const latestListing = await fetch(`http://127.0.0.1:${address.port}/api/staff-access/invites`);
    const latest = await latestListing.json() as Array<{ id: string; emailDeliveryStatus: string }>;
    assert.equal(latest.find((invite) => invite.id === inviteId)?.emailDeliveryStatus, "bounced");
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (inviteId) await pool.query("DELETE FROM staff_invites WHERE id=$1", [inviteId]);
    else await pool.query("DELETE FROM staff_invites WHERE email=$1", [email]);
  }
});

test("a failed invitation email submission is retained as failed", async () => {
  await applyStaffAccessMigration();
  await applySharedRateLimitsMigration();
  await applyStaffInvitesMigration();
  const email = `invite-failed-${process.pid}-${Date.now()}@example.invalid`;
  let inviteId: string | undefined;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    const app = express();
    app.use(express.json());
    registerStaffInviteRoutes(app, {
      requireAdmin: (_req, _res, next) => next(),
      sendInviteEmail: async () => { throw new Error("provider rejected"); },
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start invite email test server");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/staff-access/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, role: "field_technician" }),
    });
    const result = await response.json() as { invite: { id: string; emailDeliveryStatus: string }; emailSent: boolean };
    inviteId = result.invite.id;
    assert.equal(response.status, 201);
    assert.equal(result.emailSent, false);
    assert.equal(result.invite.emailDeliveryStatus, "failed");
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (inviteId) await pool.query("DELETE FROM staff_invites WHERE id=$1", [inviteId]);
    else await pool.query("DELETE FROM staff_invites WHERE email=$1", [email]);
  }
});