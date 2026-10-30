import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { WebSocket, type WebSocketServer } from "ws";
import { pool } from "./db";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { applyStaffInvitesMigration } from "./migrations/2026-09-23-staff-invites";
import { getStaffAccess, getStaffAssignmentScope, registerStaffAccessRoutes } from "./staff-access";
import { isAdminUser } from "./security";
import { createPttSessionToken, setupPttServer } from "./ptt";

test("owner status protects the last active owner and blocks a suspended actor", async () => {
  await applyStaffAccessMigration();
  await applyStaffInvitesMigration();
  const suffix = `${process.pid}-${Date.now()}`;
  const first = `owner-status-first-${suffix}`;
  const second = `owner-status-second-${suffix}`;
  const firstEmail = `${first}@example.invalid`;
  const secondEmail = `${second}@example.invalid`;
  const oldOwners = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = firstEmail;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  let pttServer: WebSocketServer | undefined;
  const sockets: WebSocket[] = [];
  const closeEvents = new WeakMap<WebSocket, Promise<number>>();
  const helloEvents = new WeakMap<WebSocket, Promise<void>>();
  try {
    await pool.query(
      "INSERT INTO auth_users(id,email) VALUES($1,$3),($2,$4)",
      [first, second, firstEmail, secondEmail],
    );
    await pool.query(
      "INSERT INTO staff_access_profiles(user_id,role,approval_status) VALUES($1,'administrator','approved'),($2,'administrator','approved')",
      [first, second],
    );
    const app = express();
    app.use(express.json());
    app.use(async (req, _res, next) => {
      const actor = String(req.header("x-test-actor") || first);
      req.dbUser = { id: actor, email: actor === first ? firstEmail : secondEmail } as NonNullable<typeof req.dbUser>;
      const auth = Object.assign(() => ({
        tokenType: "session_token",
        userId: actor,
        sessionClaims: { email: actor === first ? firstEmail : secondEmail },
      }), { [Symbol.for("@clerk/express.auth")]: true });
      (req as typeof req & { auth: () => unknown }).auth = auth;
      const result = await pool.query(
        `SELECT p.approval_status FROM staff_access_profiles p WHERE p.user_id=$1
         AND EXISTS (SELECT 1 FROM staff_access_audit a WHERE a.target_user_id=$1 AND a.action='owner_status_updated')`,
        [actor],
      );
      req.ownerApprovalStatus = result.rows[0]?.approval_status ?? "approved";
      next();
    });
    app.get("/test/owner-access", async (req, res) => {
      res.json({
        isAdmin: isAdminUser(req),
        access: await getStaffAccess(req),
        unrestricted: (await getStaffAssignmentScope(req)).unrestricted,
      });
    });
    registerStaffAccessRoutes(app, { isOwner: (req) =>
      [first, second].includes(req.dbUser?.id ?? "") && process.env.ADMIN_EMAILS?.split(",").includes(req.dbUser?.id === first ? firstEmail : secondEmail) === true });
    server = app.listen(0);
    pttServer = setupPttServer(server);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");
    const change = async (target: string, status: string, actor = first) => {
      const version = await pool.query("SELECT updated_at FROM staff_access_profiles WHERE user_id=$1", [target]);
      return fetch(`http://127.0.0.1:${address.port}/api/staff-access/${target}/owner-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-test-actor": actor },
        body: JSON.stringify({ approvalStatus: status, expectedUpdatedAt: version.rows[0].updated_at }),
      });
    };
    const openRadio = async (token: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/ptt?token=${token}`);
      sockets.push(socket);
      closeEvents.set(socket, new Promise((resolve) => socket.once("close", resolve)));
      helloEvents.set(socket, new Promise((resolve) => socket.on("message", (data) => {
        if (JSON.parse(data.toString()).type === "hello") resolve();
      })));
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      return socket;
    };
    const closed = (socket: WebSocket) => new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Radio socket did not close")), 2_000);
      void closeEvents.get(socket)!.then((code) => { clearTimeout(timer); resolve(code); });
    });
    const firstRadio = await openRadio(createPttSessionToken({ id: first, name: "First", email: firstEmail }, true, Date.now(), true));
    const secondRadio = await openRadio(createPttSessionToken({ id: second, name: "Second", email: secondEmail }, true, Date.now(), true));
    const aliasRadio = await openRadio(createPttSessionToken({ id: `${second}-alias`, name: "Second alias", email: secondEmail }, true, Date.now(), true));
    await Promise.all([helloEvents.get(firstRadio), helloEvents.get(secondRadio), helloEvents.get(aliasRadio)]);
    const secondClosed = closed(secondRadio);
    const aliasClosed = closed(aliasRadio);
    const unusedToken = createPttSessionToken({ id: `${second}-alias`, name: "Second alias", email: secondEmail }, true, Date.now(), true);
    assert.equal((await change(first, "suspended")).status, 409);
    process.env.ADMIN_EMAILS = `${firstEmail},${secondEmail}`;
    assert.equal((await change(second, "suspended")).status, 200);
    assert.equal(await secondClosed, 1008);
    assert.equal(await aliasClosed, 1008, "another local identity for the same owner is disconnected");
    assert.equal(firstRadio.readyState, WebSocket.OPEN, "another owner's radio remains connected");
    const rejected = await openRadio(unusedToken);
    assert.equal(await closed(rejected), 1008, "an unused token cannot connect after suspension");
    const suspended = await fetch(`http://127.0.0.1:${address.port}/test/owner-access`, { headers: { "x-test-actor": second } });
    const suspendedBody = await suspended.json() as { isAdmin: boolean; unrestricted: boolean; access: { role: string; approvalStatus: string; features: { billing: boolean } } };
    assert.equal(suspendedBody.isAdmin, false);
    assert.equal(suspendedBody.access.role, "owner");
    assert.equal(suspendedBody.access.approvalStatus, "suspended");
    assert.equal(suspendedBody.access.features.billing, false);
    assert.equal(suspendedBody.unrestricted, false);
    assert.equal((await change(first, "pending", second)).status, 403);
    assert.equal((await change(first, "pending")).status, 409);
    assert.equal((await change(second, "approved")).status, 200);
    const oldToken = await openRadio(unusedToken);
    assert.equal(await closed(oldToken), 1008, "reapproval cannot restore a revoked token");
    const revision = await pool.query("SELECT updated_at FROM staff_access_profiles WHERE user_id=$1", [second]);
    const freshToken = createPttSessionToken(
      { id: second, name: "Second", email: secondEmail }, true, Date.now(), true,
      new Date(revision.rows[0].updated_at).toISOString(),
    );
    const restored = await openRadio(freshToken);
    await Promise.race([
      helloEvents.get(restored)!,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Fresh radio session did not receive hello")), 2_000)),
    ]);
    assert.equal((await change(first, "pending", second)).status, 200);
    const audit = await pool.query(
      "SELECT COUNT(*)::int AS n FROM staff_access_audit WHERE target_user_id=$1 AND action='owner_status_updated'",
      [first],
    );
    assert.equal(audit.rows[0].n, 1);
  } finally {
    for (const socket of sockets) socket.terminate();
    if (pttServer) await new Promise<void>((resolve) => pttServer!.close(() => resolve()));
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await pool.query("DELETE FROM auth_users WHERE id=ANY($1::text[])", [[first, second]]);
    if (oldOwners === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = oldOwners;
  }
});