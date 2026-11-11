import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { pool } from "./db";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { registerStaffContactProfileRoutes } from "./staff-contact-profile";

const isolatedProfileTestEnabled =
  process.env.RUN_STAFF_PROFILE_ISOLATED_TESTS === "1"
  && process.env.CLERK_ISOLATED_TEST_DB_ACTIVE === "1"
  && process.env.NODE_ENV === "development"
  && process.env.REPLIT_DEPLOYMENT !== "1"
  && Boolean(process.env.CLERK_INVITE_TEST_DATABASE_URL)
  && process.env.DATABASE_URL === process.env.CLERK_INVITE_TEST_DATABASE_URL;

test("staff profile edits preserve access and only change sign-in to verified same-account addresses", {
  skip: isolatedProfileTestEnabled ? false : "Run with pnpm --filter @workspace/api-server test:staff-profile against the isolated development test database.",
}, async () => {
  const suffix = randomBytes(8).toString("hex");
  const targetId = `user_StaffContact${suffix}`;
  const actorId = `user_StaffContactActor${suffix}`;
  const oldEmail = `old-${suffix}@example.invalid`;
  const nextEmail = `next-${suffix}@example.invalid`;
  const ownerEmail = `owner-${suffix}@example.invalid`;
  let providerWrites = 0;
  let primaryId = "old-address";
  const account = () => ({
    id: targetId,
    primaryEmailAddressId: primaryId,
    emailAddresses: [
      { id: "old-address", emailAddress: oldEmail, verification: { status: "verified" } },
      { id: "next-address", emailAddress: nextEmail, verification: { status: "verified" } },
      { id: "unverified-address", emailAddress: `unverified-${suffix}@example.invalid`, verification: { status: "unverified" } },
    ],
  });
  await applyStaffAccessMigration();
  await pool.query("INSERT INTO auth_users(id,email) VALUES($1,$2),($3,$4)", [
    targetId, oldEmail, actorId, `actor-${suffix}@example.invalid`,
  ]);
  await pool.query("INSERT INTO staff_access_profiles(user_id,role,approval_status) VALUES($1,'field_technician','approved')", [targetId]);

  const app = express();
  app.use(express.json());
  registerStaffContactProfileRoutes(app, (req, res, next) => {
    if (req.get("x-profile-test-admin") !== "yes") {
      res.status(403).json({ message: "Administrator access required" });
      return;
    }
    req.dbUser = { id: actorId } as NonNullable<typeof req.dbUser>;
    next();
  }, {
    isOwnerEmail: (email) => email === ownerEmail,
    getAccount: async (id) => { assert.equal(id, targetId); return account(); },
    setPrimaryEmail: async (id, addressId) => {
      assert.equal(id, targetId);
      providerWrites++;
      primaryId = addressId;
      return account();
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/staff-access/${targetId}/profile`;
  const headers = { "Content-Type": "application/json", "x-profile-test-admin": "yes" };
  const patch = (body: object) => fetch(url, { method: "PATCH", headers, body: JSON.stringify(body) });

  try {
    assert.equal((await fetch(url)).status, 403);
    const initial = await (await fetch(url, { headers })).json() as {
      verifiedEmails: string[]; updatedAt: string | null;
    };
    assert.deepEqual(initial.verifiedEmails, [oldEmail, nextEmail]);
    const input = {
      phone: "(954) 555-0123", jobTitle: "Field Technician", department: "Support",
      expectedEmail: oldEmail, expectedUpdatedAt: initial.updatedAt,
    };
    assert.equal((await patch({ ...input, phone: "bad 9545550123" })).status, 400);
    assert.equal((await patch({ ...input, email: `unverified-${suffix}@example.invalid` })).status, 409);
    assert.equal((await patch({ ...input, email: `other-${suffix}@example.invalid` })).status, 409);
    assert.equal((await patch({ ...input, email: ownerEmail })).status, 403);
    assert.equal(providerWrites, 0);
    assert.equal((await patch({ ...input, email: nextEmail })).status, 200);
    assert.equal(providerWrites, 1);
    const saved = await pool.query(
      `SELECT u.email,d.phone,d.job_title,d.department,p.role,p.approval_status
       FROM auth_users u JOIN staff_directory_details d ON d.user_id=u.id
       JOIN staff_access_profiles p ON p.user_id=u.id WHERE u.id=$1`,
      [targetId],
    );
    assert.deepEqual(saved.rows[0], {
      email: nextEmail, phone: "+19545550123", job_title: "Field Technician",
      department: "Support", role: "field_technician", approval_status: "approved",
    });
    assert.equal((await patch({ ...input, jobTitle: "Stale edit" })).status, 409);
    const current = await (await fetch(url, { headers })).json() as { updatedAt: string };
    assert.equal((await patch({
      phone: "", jobTitle: "", department: "",
      expectedEmail: nextEmail, expectedUpdatedAt: current.updatedAt,
    })).status, 200);
    const cleared = await pool.query("SELECT phone,job_title,department FROM staff_directory_details WHERE user_id=$1", [targetId]);
    assert.deepEqual(cleared.rows[0], { phone: null, job_title: null, department: null });
    await pool.query("UPDATE auth_users SET email=$2 WHERE id=$1", [targetId, ownerEmail]);
    const owner = await (await fetch(url, { headers })).json() as { emailChangeAvailable: boolean; updatedAt: string };
    assert.equal(owner.emailChangeAvailable, false);
    assert.equal((await patch({
      ...input, expectedEmail: ownerEmail, expectedUpdatedAt: owner.updatedAt, email: nextEmail,
    })).status, 403);
    assert.equal(providerWrites, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.query("DELETE FROM staff_access_audit WHERE target_user_id=$1 OR actor_user_id=$2", [targetId, actorId]);
    await pool.query("DELETE FROM auth_users WHERE id=ANY($1::text[])", [[targetId, actorId]]);
    await pool.end();
  }
});
