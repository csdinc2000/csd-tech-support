import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { pool } from "./db";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { applyStaffInvitesMigration } from "./migrations/2026-09-23-staff-invites";
import { registerStaffAccountDeletionRoutes } from "./staff-account-deletion";

test("only owners can permanently remove a confirmed staff identity and its audit history", async () => {
  await applyStaffAccessMigration();
  await applyStaffInvitesMigration();
  const suffix = `${process.pid}-${Date.now()}`;
  const targetId = `delete-test-${suffix}`;
  const actorId = `delete-actor-${suffix}`;
  const email = `delete-test-${suffix}@example.invalid`;
  let owner = false;
  let failClerk = false;
  let clerkDeletes = 0;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    await pool.query("INSERT INTO auth_users(id,email) VALUES($1,$3),($2,$4)", [targetId, actorId, email, `owner-${suffix}@example.invalid`]);
    await pool.query("INSERT INTO staff_access_profiles(user_id,role,approval_status) VALUES($1,'field_technician','approved')", [targetId]);
    await pool.query(
      "INSERT INTO staff_access_audit(target_user_id,actor_user_id,previous_access,new_access) VALUES($1,$2,'{}'::jsonb,'{}'::jsonb)",
      [targetId, actorId],
    );
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.dbUser = { id: actorId } as NonNullable<typeof req.dbUser>;
      next();
    });
    registerStaffAccountDeletionRoutes(app, {
      isOwner: () => owner,
      findClerkUsers: async () => [{ id: `user_${suffix}`, email }],
      deleteClerkUser: async () => {
        clerkDeletes++;
        if (failClerk) throw new Error("Simulated provider failure");
      },
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");
    const remove = (confirmEmail: string, id = targetId) => fetch(`http://127.0.0.1:${address.port}/api/staff-access/${id}/account`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmEmail }),
    });
    assert.equal((await remove(email)).status, 403);
    owner = true;
    assert.equal((await remove("wrong@example.invalid")).status, 409);
    assert.equal((await remove(`owner-${suffix}@example.invalid`, actorId)).status, 403);
    failClerk = true;
    assert.equal((await remove(email)).status, 500);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM auth_users WHERE id=$1", [targetId])).rows[0].n, 1);
    failClerk = false;
    assert.equal((await remove(email)).status, 200);
    assert.equal(clerkDeletes, 2);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM auth_users WHERE id=$1", [targetId])).rows[0].n, 0);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM staff_access_audit WHERE target_user_id=$1", [targetId])).rows[0].n, 0);
  } finally {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await pool.query("DELETE FROM auth_users WHERE id=$1", [actorId]);
  }
});