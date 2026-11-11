import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import { apiAuthenticationBoundary } from "./api-auth-boundary";
import { pool } from "./db";
import { applyStaffInvitesMigration } from "./migrations/2026-09-23-staff-invites";
import { enforceAssignedResourceBoundary } from "./staff-access";
import { registerStaffDispatchRoutes } from "./staff-dispatch";

test("production API middleware rejects signed-out Dispatch history before database access", async () => {
  const originalQuery = pool.query;
  let databaseReads = 0;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;

  try {
    (pool as any).query = function () {
      databaseReads++;
      throw new Error("Signed-out Dispatch history must not query the database");
    };

    const app = express();
    app.use(express.json());
    // Simulate Clerk middleware resolving a request with no session.
    app.use((req, _res, next) => {
      (req as any).auth = Object.assign(() => ({
        tokenType: "session_token",
        userId: null,
        sessionClaims: null,
      }), { [Symbol.for("@clerk/express.auth")]: true });
      next();
    });
    app.use(apiAuthenticationBoundary);
    app.use(enforceAssignedResourceBoundary);
    registerStaffDispatchRoutes(app);

    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start Dispatch history test server");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    for (const path of ["/api/staff-dispatch/audit", "/api/staff-dispatch/client-messages"]) {
      const denied = await fetch(`${baseUrl}${path}`);
      assert.equal(denied.status, 401, `${path}: ${await denied.clone().text()}`);
      assert.equal((await denied.json()).message, "Authentication required");
      assert.equal(databaseReads, 0, `${path}: signed-out request must not reach database queries`);
    }
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => error ? reject(error) : resolve()),
      );
    }
    (pool as any).query = originalQuery;
  }
});

test("production API middleware keeps canonical and mixed-case Dispatch history owner-only for approved staff", async () => {
  const marker = `dispatch-history-${randomUUID()}`;
  const ownerId = `${marker}-owner`;
  const staffId = `${marker}-staff`;
  const ownerEmail = `${marker}-owner@example.invalid`;
  const staffEmail = `${marker}-staff@example.invalid`;
  const previousAdminEmails = process.env.ADMIN_EMAILS;
  const originalQuery = pool.query;
  const auditRows = [{ id: marker, action: "test.audit", outcome: "accepted" }];
  const messageRows = [{ id: marker, body: "isolated test history", status: "delivered" }];
  const historyReads: string[] = [];
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;

  try {
    await applyStaffInvitesMigration();
    await pool.query(
      `INSERT INTO auth_users(id,email,first_name) VALUES($1,$2,'Owner'),($3,$4,'Staff')`,
      [ownerId, ownerEmail, staffId, staffEmail],
    );
    await pool.query(
      `INSERT INTO staff_access_profiles(user_id,role,approval_status,feature_permissions)
       VALUES($1,'administrator','approved',$2::jsonb)`,
      [staffId, JSON.stringify({ dispatchAdmin: true })],
    );
    process.env.ADMIN_EMAILS = ownerEmail;

    // Only history reads are substituted; requireAuth and getStaffAccess still
    // resolve the newly created identities and approval from the database.
    (pool as any).query = function (sql: string, ...args: unknown[]) {
      if (typeof sql === "string" && sql.includes("FROM staff_dispatch_audit ORDER BY")) {
        historyReads.push("audit");
        return Promise.resolve({ rows: auditRows, rowCount: 1 });
      }
      if (typeof sql === "string" && sql.includes("FROM staff_dispatch_client_messages ORDER BY")) {
        historyReads.push("client-messages");
        return Promise.resolve({ rows: messageRows, rowCount: 1 });
      }
      return (originalQuery as (...params: unknown[]) => unknown).call(pool, sql, ...args);
    };

    const app = express();
    app.use(express.json());
    // Replace only Clerk's cryptographic session validation. The real
    // production requireAuth middleware must resolve the database user.
    app.use((req, _res, next) => {
      const actor = req.header("x-test-actor");
      const userId = actor === "owner" ? ownerId : actor === "staff" ? staffId : null;
      const email = actor === "owner" ? ownerEmail : actor === "staff" ? staffEmail : null;
      (req as any).auth = Object.assign(() => ({
        tokenType: "session_token",
        userId,
        sessionClaims: userId ? { userId, email } : null,
      }), { [Symbol.for("@clerk/express.auth")]: true });
      next();
    });
    app.use(apiAuthenticationBoundary);
    app.use(enforceAssignedResourceBoundary);
    registerStaffDispatchRoutes(app);

    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start Dispatch history test server");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    for (const [path, expectedRows, historyType] of [
      ["/api/staff-dispatch/audit", auditRows, "audit"],
      ["/API/Staff-Dispatch/AuDiT", auditRows, "audit"],
      ["/api/staff-dispatch/client-messages", messageRows, "client-messages"],
      ["/aPi/StAfF-DiSpAtCh/ClIeNt-MeSsAgEs", messageRows, "client-messages"],
    ] as const) {
      const readsBeforeStaffRequest = historyReads.length;
      const denied = await fetch(`${baseUrl}${path}`, { headers: { "x-test-actor": "staff" } });
      assert.equal(denied.status, 403, `${path}: ${await denied.clone().text()}`);
      assert.equal((await denied.json()).message, "Owner approval required");
      assert.equal(historyReads.length, readsBeforeStaffRequest, `${path}: staff must not reach the history query`);

      const allowed = await fetch(`${baseUrl}${path}`, { headers: { "x-test-actor": "owner" } });
      assert.equal(allowed.status, 200, `${path}: ${await allowed.clone().text()}`);
      assert.deepEqual(await allowed.json(), expectedRows, `${path}: owner must only see this history`);
      assert.deepEqual(historyReads.slice(readsBeforeStaffRequest), [historyType], `${path}: only the requested history is read`);
    }
    assert.deepEqual(historyReads, ["audit", "audit", "client-messages", "client-messages"]);
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => error ? reject(error) : resolve()),
      );
    }
    (pool as any).query = originalQuery;
    await pool.query("DELETE FROM staff_access_profiles WHERE user_id=$1", [staffId]);
    await pool.query("DELETE FROM auth_users WHERE id=ANY($1::text[])", [[ownerId, staffId]]);
    if (previousAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previousAdminEmails;
  }
});