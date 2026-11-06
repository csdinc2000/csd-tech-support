import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import { createServer, type Server } from "node:http";
import { pool } from "./db";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { applyStaffAvatarsMigration } from "./migrations/2026-11-06-staff-avatars";
import { applyPttPagesMigration } from "./migrations/2026-11-06-ptt-pages";
import { effectivePageStatus, registerPttPageRoutes } from "./ptt-pages";
import { requiredFeatureForApiPath } from "./security";
import { isPublicApiRequest } from "./api-auth-boundary";

const marker = `ptt-pages-${process.pid}-${Date.now()}`;
const deskId = `${marker}-desk`;
const techAId = `${marker}-tech-a`;
const techBId = `${marker}-tech-b`;
const accountantId = `${marker}-accounting`;
const pendingId = `${marker}-pending`;
const allIds = [deskId, techAId, techBId, accountantId, pendingId];
let server: Server;
let baseUrl = "";

function request(path: string, actor: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-test-actor": actor, ...init?.headers },
  });
}

async function ring(actor: string, body: Record<string, unknown>) {
  return request("/api/ptt/pages", actor, { method: "POST", body: JSON.stringify(body) });
}

type Incoming = { rings: Array<{ id: number; groupId: string; callerName: string; channelId: string; channelName: string }> };
type Group = { groupId: string; channelId: string; pages: Array<{ id: number; targetUserId: string; name: string; status: string }> };

before(async () => {
  await applyStaffAccessMigration();
  await applyStaffAvatarsMigration();
  await applyPttPagesMigration();
  const names: Record<string, [string, string]> = {
    [deskId]: ["Fran", "Desk"], [techAId]: ["Alex", "Tech"], [techBId]: ["Blair", "Tech"],
    [accountantId]: ["Casey", "Books"], [pendingId]: ["Drew", "New"],
  };
  for (const id of allIds) {
    await pool.query(
      `INSERT INTO auth_users(id,email,first_name,last_name) VALUES($1,$2,$3,$4)
       ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email, first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name`,
      [id, `${id}@example.invalid`, ...names[id]],
    );
  }
  await pool.query(
    `INSERT INTO staff_access_profiles(user_id,role,approval_status,can_view_voicemails,feature_permissions)
     VALUES ($1,'secretary','approved',FALSE,'{}'), ($2,'field_technician','approved',FALSE,'{}'),
            ($3,'field_technician','approved',FALSE,'{}'), ($4,'accounting','approved',FALSE,'{}'),
            ($5,'field_technician','pending',FALSE,'{}')
     ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role, approval_status=EXCLUDED.approval_status,
       feature_permissions=EXCLUDED.feature_permissions`,
    [deskId, techAId, techBId, accountantId, pendingId],
  );

  const app = express();
  app.use(express.json());
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
  registerPttPageRoutes(app);
  server = createServer(app);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query("DELETE FROM auth_users WHERE id = ANY($1::text[])", [allIds]);
});

test("ring routes are staff-only and gated by the communications feature", () => {
  for (const [method, path] of [
    ["GET", "/api/ptt/roster"],
    ["POST", "/api/ptt/pages"],
    ["GET", "/api/ptt/pages/incoming"],
    ["POST", "/api/ptt/pages/12/respond"],
    ["GET", "/api/ptt/pages/groups/abc"],
    ["POST", "/api/ptt/pages/groups/abc/cancel"],
  ] as const) {
    assert.equal(isPublicApiRequest(method, path), false);
    assert.equal(requiredFeatureForApiPath(path, method), "communications");
  }
});

test("the roster lists approved staff with PTT access, never the caller, and marks who has the app open", async () => {
  // Tech A has the app open (polls for rings); Tech B does not.
  assert.equal((await request("/api/ptt/pages/incoming", techAId)).status, 200);
  const res = await request("/api/ptt/roster", deskId);
  assert.equal(res.status, 200);
  const { staff } = (await res.json()) as { staff: Array<{ id: string; name: string; online: boolean; role: string }> };
  const ours = staff.filter((entry) => allIds.includes(entry.id));
  assert.deepEqual(ours.map((entry) => entry.id).sort(), [techAId, techBId].sort());
  assert.equal(ours.find((entry) => entry.id === techAId)?.online, true);
  assert.equal(ours.find((entry) => entry.id === techBId)?.online, false);
  assert.equal(ours.find((entry) => entry.id === techAId)?.name, "Alex Tech");

  assert.equal((await request("/api/ptt/roster", accountantId)).status, 403);
  assert.equal((await request("/api/ptt/pages/incoming", pendingId)).status, 403);
});

test("ringing one person pops up only for them; answering returns the talk group", async () => {
  const created = await ring(deskId, { channelId: "field", targetUserIds: [techAId] });
  assert.equal(created.status, 201);
  const group = (await created.json()) as Group;
  assert.equal(group.channelId, "field");
  assert.deepEqual(group.pages.map((p) => [p.targetUserId, p.status]), [[techAId, "ringing"]]);

  const incomingA = (await (await request("/api/ptt/pages/incoming", techAId)).json()) as Incoming;
  const mine = incomingA.rings.find((r) => r.groupId === group.groupId);
  assert.ok(mine);
  assert.equal(mine.callerName, "Fran Desk");
  assert.equal(mine.channelName, "Field Technicians");
  const incomingB = (await (await request("/api/ptt/pages/incoming", techBId)).json()) as Incoming;
  assert.equal(incomingB.rings.some((r) => r.groupId === group.groupId), false);

  // Only the person rung can answer it.
  const hijack = await request(`/api/ptt/pages/${mine.id}/respond`, techBId, { method: "POST", body: JSON.stringify({ action: "answer" }) });
  assert.equal(hijack.status, 409);

  const answered = await request(`/api/ptt/pages/${mine.id}/respond`, techAId, { method: "POST", body: JSON.stringify({ action: "answer" }) });
  assert.equal(answered.status, 200);
  assert.deepEqual(await answered.json(), { status: "answered", channelId: "field" });
  const again = await request(`/api/ptt/pages/${mine.id}/respond`, techAId, { method: "POST", body: JSON.stringify({ action: "decline" }) });
  assert.equal(again.status, 409);

  const status = (await (await request(`/api/ptt/pages/groups/${group.groupId}`, deskId)).json()) as Group;
  assert.equal(status.pages[0].status, "answered");
  // Rings stop showing once answered, and other users cannot read the caller's ring status.
  const after = (await (await request("/api/ptt/pages/incoming", techAId)).json()) as Incoming;
  assert.equal(after.rings.some((r) => r.groupId === group.groupId), false);
  assert.equal((await request(`/api/ptt/pages/groups/${group.groupId}`, techBId)).status, 404);
});

test("ring everyone reaches all PTT staff at once, skipping people without access; cancel stops it", async () => {
  const created = await ring(deskId, { channelId: "dispatch", everyone: true });
  assert.equal(created.status, 201);
  const group = (await created.json()) as Group;
  const ourTargets = group.pages.filter((p) => allIds.includes(p.targetUserId)).map((p) => p.targetUserId).sort();
  assert.deepEqual(ourTargets, [techAId, techBId].sort());
  assert.equal(group.pages.some((p) => p.targetUserId === deskId), false);

  for (const tech of [techAId, techBId]) {
    const incoming = (await (await request("/api/ptt/pages/incoming", tech)).json()) as Incoming;
    assert.ok(incoming.rings.some((r) => r.groupId === group.groupId && r.channelId === "dispatch"));
  }
  const ringB = group.pages.find((p) => p.targetUserId === techBId)!;
  const declined = await request(`/api/ptt/pages/${ringB.id}/respond`, techBId, { method: "POST", body: JSON.stringify({ action: "decline" }) });
  assert.equal(declined.status, 200);

  assert.equal((await request(`/api/ptt/pages/groups/${group.groupId}/cancel`, techAId, { method: "POST" })).status, 404);
  const cancelled = (await (await request(`/api/ptt/pages/groups/${group.groupId}/cancel`, deskId, { method: "POST" })).json()) as Group;
  const byTarget = Object.fromEntries(cancelled.pages.map((p) => [p.targetUserId, p.status]));
  assert.equal(byTarget[techAId], "cancelled");
  assert.equal(byTarget[techBId], "declined");
  const incomingA = (await (await request("/api/ptt/pages/incoming", techAId)).json()) as Incoming;
  assert.equal(incomingA.rings.some((r) => r.groupId === group.groupId), false);
});

test("a new ring replaces the caller's earlier ring to the same person, and bad input is rejected", async () => {
  const first = (await (await ring(deskId, { channelId: "dispatch", targetUserIds: [techBId] })).json()) as Group;
  const second = (await (await ring(deskId, { channelId: "priority", targetUserIds: [techBId] })).json()) as Group;
  const incoming = (await (await request("/api/ptt/pages/incoming", techBId)).json()) as Incoming;
  const fromDesk = incoming.rings.filter((r) => r.groupId === first.groupId || r.groupId === second.groupId);
  assert.deepEqual(fromDesk.map((r) => r.channelId), ["priority"]);

  assert.equal((await ring(deskId, { channelId: "nope", everyone: true })).status, 400);
  assert.equal((await ring(deskId, { channelId: "dispatch", targetUserIds: [accountantId, pendingId] })).status, 400);
  assert.equal((await ring(deskId, { channelId: "dispatch", targetUserIds: [] })).status, 400);
  assert.equal((await ring(accountantId, { channelId: "dispatch", everyone: true })).status, 403);
  await request(`/api/ptt/pages/groups/${second.groupId}/cancel`, deskId, { method: "POST" });
});

test("an unanswered ring is reported as missed once it expires", async () => {
  const created = (await (await ring(deskId, { channelId: "field", targetUserIds: [techAId] })).json()) as Group;
  await pool.query(`UPDATE ptt_pages SET expires_at = NOW() - INTERVAL '1 second' WHERE group_id = $1`, [created.groupId]);
  const status = (await (await request(`/api/ptt/pages/groups/${created.groupId}`, deskId)).json()) as Group;
  assert.equal(status.pages[0].status, "missed");
  const incoming = (await (await request("/api/ptt/pages/incoming", techAId)).json()) as Incoming;
  assert.equal(incoming.rings.some((r) => r.groupId === created.groupId), false);
  const late = await request(`/api/ptt/pages/${status.pages[0].id}/respond`, techAId, { method: "POST", body: JSON.stringify({ action: "answer" }) });
  assert.equal(late.status, 409);

  assert.equal(effectivePageStatus("ringing", new Date(Date.now() + 1000)), "ringing");
  assert.equal(effectivePageStatus("answered", new Date(0)), "answered");
});
