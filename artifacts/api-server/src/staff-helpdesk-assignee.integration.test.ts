import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { pool } from "./db";
import { registerStaffInviteRoutes } from "./staff-invites";

test("helpdesk linking distinguishes approval from missing identity and remains safe to retry", async (t) => {
  const suffix = randomUUID();
  const ids = Object.fromEntries(["actor", "missingEmail", "pending", "existing", "create", "duplicate", "malformed"]
    .map((key) => [key, `helpdesk-test-${key}-${suffix}`]));
  const email = (key: string) => `${key}-${suffix}@example.invalid`;
  const helpdeskIds: number[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.dbUser = { id: ids.actor } as NonNullable<typeof req.dbUser>;
    next();
  });
  registerStaffInviteRoutes(app, {
    requireAdmin: (req, res, next) => {
      if (req.header("x-test-owner") !== "yes") {
        res.status(403).json({ message: "Owner access required" });
        return;
      }
      next();
    },
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start helpdesk test server");
  const post = (id: string, owner = true) => fetch(
    `http://127.0.0.1:${address.port}/api/staff-access/${encodeURIComponent(id)}/helpdesk-assignee`,
    { method: "POST", headers: owner ? { "x-test-owner": "yes" } : {} },
  );
  try {
    for (const [key, id] of Object.entries(ids)) {
      await pool.query(
        "INSERT INTO auth_users(id,email,first_name,last_name) VALUES($1,$2,'Regression','Staff')",
        [id, key === "missingEmail" ? null : key === "malformed" ? "invalid-email" : email(key)],
      );
      await pool.query(
        "INSERT INTO staff_access_profiles(user_id,role,approval_status) VALUES($1,'field_technician',$2)",
        [id, key === "pending" ? "pending" : "approved"],
      );
    }
    for (const key of ["existing", "duplicate", "duplicate"]) {
      const row = await pool.query(
        "INSERT INTO users(username,password,email,role) VALUES($1,$2,$3,'user') RETURNING id",
        [`helpdesk-${key}-${randomUUID()}`, "!disabled-test-password", ` ${email(key).toUpperCase()} `],
      );
      helpdeskIds.push(row.rows[0].id);
    }

    await t.test("owner authorization remains required", async () => {
      assert.equal((await post(ids.create, false)).status, 403);
    });
    await t.test("direct sign-in identity repair cannot bypass an invitation", async () => {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/staff-access/${ids.missingEmail}/helpdesk-identity`,
        { method: "POST", headers: { "x-test-owner": "yes", "Content-Type": "application/json" },
          body: JSON.stringify({ email: email("missingEmail"), confirmIdentity: true }) },
      );
      assert.equal(response.status, 410);
      assert.match((await response.json() as { message: string }).message, /invitation/);
      assert.equal((await pool.query("SELECT email FROM auth_users WHERE id=$1", [ids.missingEmail])).rows[0].email, null);
      assert.equal((await pool.query("SELECT 1 FROM auth_user_clerk_links WHERE auth_user_id=$1", [ids.missingEmail])).rowCount, 0);
    });
    await t.test("unknown account is not mislabeled as unapproved", async () => {
      assert.equal((await post(`absent-${suffix}`)).status, 404);
    });
    await t.test("pending accounts cannot link", async () => {
      const response = await post(ids.pending);
      assert.equal(response.status, 409);
      assert.match((await response.json() as { message: string }).message, /Approve this staff account/);
    });
    await t.test("approved email-less or malformed accounts explain the identity blocker", async () => {
      for (const id of [ids.missingEmail, ids.malformed]) {
        const response = await post(id);
        assert.equal(response.status, 409);
        const body = await response.json() as { code: string; message: string };
        assert.equal(body.code, "STAFF_EMAIL_REQUIRED");
        assert.match(body.message, /account is approved/);
        assert.equal((await pool.query("SELECT 1 FROM staff_helpdesk_links WHERE auth_user_id=$1", [id])).rowCount, 0);
        assert.equal((await pool.query("SELECT approval_status FROM staff_access_profiles WHERE user_id=$1", [id])).rows[0].approval_status, "approved");
      }
    });
    await t.test("a unique canonical email links the existing assignee", async () => {
      const response = await post(ids.existing);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json() as { id: number }).id, helpdeskIds[0]);
    });
    await t.test("duplicate canonical emails fail without linking", async () => {
      const response = await post(ids.duplicate);
      assert.equal(response.status, 409);
      assert.match((await response.json() as { message: string }).message, /Multiple helpdesk assignees/);
    });
    await t.test("creation and repeated requests use one assignee and one audit event", async () => {
      const first = await post(ids.create);
      assert.equal(first.status, 200, await first.clone().text());
      const assignee = await first.json() as { id: number; email: string };
      helpdeskIds.push(assignee.id);
      assert.equal(assignee.email, email("create"));
      // Once linked, a stale/missing email must not break an idempotent retry.
      await pool.query("UPDATE auth_users SET email=NULL WHERE id=$1", [ids.create]);
      const retry = await post(ids.create);
      assert.equal(retry.status, 200);
      assert.equal((await retry.json() as { id: number }).id, assignee.id);
      assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS count FROM staff_access_audit WHERE target_user_id=$1 AND action='helpdesk_assignee_linked'",
        [ids.create],
      )).rows[0].count, 1);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.query("DELETE FROM staff_access_audit WHERE target_user_id=ANY($1::text[])", [Object.values(ids)]);
    await pool.query("DELETE FROM staff_helpdesk_links WHERE auth_user_id=ANY($1::text[])", [Object.values(ids)]);
    await pool.query("DELETE FROM staff_access_profiles WHERE user_id=ANY($1::text[])", [Object.values(ids)]);
    await pool.query("DELETE FROM auth_users WHERE id=ANY($1::text[])", [Object.values(ids)]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::int[])", [helpdeskIds]);
  }
});
