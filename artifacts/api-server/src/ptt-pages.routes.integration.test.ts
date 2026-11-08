import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import { createServer, type Server } from "node:http";
import { pool } from "./db";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { applyStaffAvatarsMigration } from "./migrations/2026-11-06-staff-avatars";
import { applyPttPagesMigration } from "./migrations/2026-11-06-ptt-pages";
import { effectivePageStatus, registerPttPageRoutes, resolvedPttPageStatus } from "./ptt-pages";
import { canJoinDirectChannel, isDirectChannelId, revokePttUserSessions } from "./ptt";
import { requiredFeatureForApiPath } from "./security";
import { isPublicApiRequest } from "./api-auth-boundary";

const marker = `ptt-pages-${process.pid}-${Date.now()}`;
const deskId = `${marker}-desk`;
const techAId = `${marker}-tech-a`;
const techBId = `${marker}-tech-b`;
const accountantId = `${marker}-accounting`;
const pendingId = `${marker}-pending`;
const adminId = `${marker}-admin`;
const offlineId = `${marker}-offline`;
const allIds = [deskId, techAId, techBId, accountantId, pendingId, adminId, offlineId];
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

type Incoming = { rings: Array<{ id: number; groupId: string; callerName: string; callerRole: string; channelId: string; channelName: string }> };
type Group = { groupId: string; channelId: string; pages: Array<{ id: number; targetUserId: string; name: string; role: string; status: string }> };

before(async () => {
  await applyStaffAccessMigration();
  await applyStaffAvatarsMigration();
  await applyPttPagesMigration();
  const names: Record<string, [string, string]> = {
    [deskId]: ["Fran", "Desk"], [techAId]: ["Alex", "Tech"], [techBId]: ["Blair", "Tech"],
    [accountantId]: ["Casey", "Books"], [pendingId]: ["Drew", "New"],
    [adminId]: ["Avery", "Admin"], [offlineId]: ["Morgan", "Offline"],
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
             ($5,'field_technician','pending',FALSE,'{}'), ($6,'administrator','approved',FALSE,'{}'),
             ($7,'field_technician','approved',FALSE,'{}')
     ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role, approval_status=EXCLUDED.approval_status,
       feature_permissions=EXCLUDED.feature_permissions`,
    [deskId, techAId, techBId, accountantId, pendingId, adminId, offlineId],
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

test("the roster returns server roles, approved PTT staff, caller broadcast permissions, and app presence", async () => {
  // Tech A has the app open (polls for rings); Tech B does not.
  assert.equal((await request("/api/ptt/pages/incoming", techAId)).status, 200);
  const res = await request("/api/ptt/roster", deskId);
  assert.equal(res.status, 200);
  const { staff, callerRole, canBroadcast } = (await res.json()) as {
    staff: Array<{ id: string; name: string; online: boolean; role: string }>;
    callerRole: string;
    canBroadcast: boolean;
  };
  const ours = staff.filter((entry) => allIds.includes(entry.id));
  assert.deepEqual(ours.map((entry) => entry.id).sort(), [adminId, offlineId, techAId, techBId].sort());
  assert.equal(ours.find((entry) => entry.id === techAId)?.online, true);
  assert.equal(ours.find((entry) => entry.id === techBId)?.online, false);
  assert.equal(ours.find((entry) => entry.id === techAId)?.name, "Alex Tech");
  assert.equal(ours.find((entry) => entry.id === adminId)?.role, "administrator");
  assert.equal(callerRole, "secretary");
  assert.equal(canBroadcast, false);
  const adminRoster = await request("/api/ptt/roster", adminId);
  assert.equal((await adminRoster.json() as { canBroadcast: boolean }).canBroadcast, true);

  assert.equal((await request("/api/ptt/roster", accountantId)).status, 403);
  assert.equal((await request("/api/ptt/pages/incoming", pendingId)).status, 403);
});

test("a technician can ring another technician; only the caller and answered recipient may join", async () => {
  await request("/api/ptt/pages/incoming", techBId);
  const created = await ring(techAId, { targetUserIds: [techBId] });
  assert.equal(created.status, 201);
  const group = (await created.json()) as Group;
  assert.equal(group.channelId, `direct:${group.groupId}`);
  assert.ok(isDirectChannelId(group.channelId));
  assert.equal(await canJoinDirectChannel(techAId, group.channelId as `direct:${string}`), true);
  assert.equal(await canJoinDirectChannel(techBId, group.channelId as `direct:${string}`), false);
  assert.deepEqual(group.pages.map((p) => [p.targetUserId, p.role, p.status]), [[techBId, "field_technician", "ringing"]]);

  const incomingB = (await (await request("/api/ptt/pages/incoming", techBId)).json()) as Incoming;
  const mine = incomingB.rings.find((r) => r.groupId === group.groupId);
  assert.ok(mine);
  assert.equal(mine.callerName, "Alex Tech");
  assert.equal(mine.callerRole, "field_technician");
  assert.equal(mine.channelName, "Private call");

  // Only the person rung can answer it.
  const hijack = await request(`/api/ptt/pages/${mine.id}/respond`, techAId, { method: "POST", body: JSON.stringify({ action: "answer" }) });
  assert.equal(hijack.status, 409);

  const answered = await request(`/api/ptt/pages/${mine.id}/respond`, techBId, { method: "POST", body: JSON.stringify({ action: "answer" }) });
  assert.equal(answered.status, 200);
  assert.deepEqual(await answered.json(), { status: "answered", channelId: group.channelId });
  assert.equal(await canJoinDirectChannel(techBId, group.channelId as `direct:${string}`), true);
  const again = await request(`/api/ptt/pages/${mine.id}/respond`, techBId, { method: "POST", body: JSON.stringify({ action: "decline" }) });
  assert.equal(again.status, 409);

  const status = (await (await request(`/api/ptt/pages/groups/${group.groupId}`, techAId)).json()) as Group;
  assert.equal(status.pages[0].status, "answered");
  // Rings stop showing once answered, and other users cannot read the caller's ring status.
  const after = (await (await request("/api/ptt/pages/incoming", techBId)).json()) as Incoming;
  assert.equal(after.rings.some((r) => r.groupId === group.groupId), false);
  assert.equal((await request(`/api/ptt/pages/groups/${group.groupId}`, techBId)).status, 404);
});

test("administrators can broadcast all approved PTT staff; offline users are marked unavailable", async () => {
  for (const id of [deskId, techAId, techBId]) await request("/api/ptt/pages/incoming", id);
  const created = await ring(adminId, { channelId: "dispatch", everyone: true });
  assert.equal(created.status, 201);
  const group = (await created.json()) as Group;
  const ourTargets = group.pages.filter((p) => allIds.includes(p.targetUserId)).map((p) => p.targetUserId).sort();
  assert.deepEqual(ourTargets, [deskId, offlineId, techAId, techBId].sort());
  assert.equal(group.pages.some((p) => p.targetUserId === adminId), false);
  assert.equal(group.pages.find((p) => p.targetUserId === offlineId)?.status, "unavailable");

  for (const target of [deskId, techAId, techBId]) {
    const incoming = (await (await request("/api/ptt/pages/incoming", target)).json()) as Incoming;
    const ringEntry = incoming.rings.find((r) => r.groupId === group.groupId && r.channelId === "dispatch");
    assert.ok(ringEntry);
    assert.equal(ringEntry.callerRole, "administrator");
  }
  const ringB = group.pages.find((p) => p.targetUserId === techBId)!;
  const declined = await request(`/api/ptt/pages/${ringB.id}/respond`, techBId, { method: "POST", body: JSON.stringify({ action: "decline" }) });
  assert.equal(declined.status, 200);

  assert.equal((await request(`/api/ptt/pages/groups/${group.groupId}/cancel`, techAId, { method: "POST" })).status, 404);
  const cancelled = (await (await request(`/api/ptt/pages/groups/${group.groupId}/cancel`, adminId, { method: "POST" })).json()) as Group;
  const byTarget = Object.fromEntries(cancelled.pages.map((p) => [p.targetUserId, p.status]));
  assert.equal(byTarget[techAId], "cancelled");
  assert.equal(byTarget[techBId], "declined");
  assert.equal(byTarget[offlineId], "unavailable");
  const incomingA = (await (await request("/api/ptt/pages/incoming", techAId)).json()) as Incoming;
  assert.equal(incomingA.rings.some((r) => r.groupId === group.groupId), false);
});

test("administrators can call a role group and select specific people", async () => {
  await request("/api/ptt/pages/incoming", techAId);
  await request("/api/ptt/pages/incoming", techBId);
  const allPrivateResponse = await ring(adminId, { targetRole: "all" });
  assert.equal(allPrivateResponse.status, 201);
  const allPrivate = (await allPrivateResponse.json()) as Group;
  assert.ok(isDirectChannelId(allPrivate.channelId));
  assert.deepEqual(
    allPrivate.pages.filter((page) => [deskId, techAId, techBId, offlineId].includes(page.targetUserId))
      .map((page) => page.targetUserId).sort(),
    [deskId, offlineId, techAId, techBId].sort(),
  );
  assert.equal(allPrivate.pages.find((page) => page.targetUserId === offlineId)?.status, "unavailable");
  await request(`/api/ptt/pages/groups/${allPrivate.groupId}/cancel`, adminId, { method: "POST" });

  const roleCallResponse = await ring(adminId, { targetRole: "field_technician" });
  assert.equal(roleCallResponse.status, 201);
  const roleCall = (await roleCallResponse.json()) as Group;
  const fixtureRoleRecipients = roleCall.pages
    .filter((page) => [techAId, techBId, offlineId].includes(page.targetUserId))
    .map((page) => [page.targetUserId, page.role]);
  assert.deepEqual(fixtureRoleRecipients.sort(), [
    [offlineId, "field_technician"],
    [techAId, "field_technician"],
    [techBId, "field_technician"],
  ].sort());
  await request(`/api/ptt/pages/groups/${roleCall.groupId}/cancel`, adminId, { method: "POST" });

  const created = (await (await ring(adminId, { targetUserIds: [techAId, deskId] })).json()) as Group;
  assert.equal(created.pages.length, 2);
  assert.ok(isDirectChannelId(created.channelId));
  for (const id of [adminId, deskId, techAId]) {
    assert.equal(await canJoinDirectChannel(id, created.channelId as `direct:${string}`), id === adminId);
  }
  assert.equal(await canJoinDirectChannel(accountantId, created.channelId as `direct:${string}`), false);
  const deskPage = created.pages.find((page) => page.targetUserId === deskId)!;
  assert.equal(await canJoinDirectChannel(deskId, created.channelId as `direct:${string}`), false);
  const acceptDesk = await request(`/api/ptt/pages/${deskPage.id}/respond`, deskId, { method: "POST", body: JSON.stringify({ action: "answer" }) });
  assert.equal(acceptDesk.status, 200);
  assert.equal(await canJoinDirectChannel(deskId, created.channelId as `direct:${string}`), true);
  await request(`/api/ptt/pages/groups/${created.groupId}/cancel`, adminId, { method: "POST" });
});

test("a new ring replaces the caller's earlier ring to the same person, and bad input is rejected", async () => {
  await request("/api/ptt/pages/incoming", techBId);
  const first = (await (await ring(techAId, { targetUserIds: [techBId] })).json()) as Group;
  const second = (await (await ring(techAId, { targetUserIds: [techBId] })).json()) as Group;
  const incoming = (await (await request("/api/ptt/pages/incoming", techBId)).json()) as Incoming;
  const fromDesk = incoming.rings.filter((r) => r.groupId === first.groupId || r.groupId === second.groupId);
  assert.deepEqual(fromDesk.map((r) => r.groupId), [second.groupId]);

  assert.equal((await ring(adminId, { channelId: "nope", everyone: true })).status, 400);
  assert.equal((await ring(adminId, { everyone: true })).status, 400);
  // A forged private channel id is never joinable.
  assert.equal(await canJoinDirectChannel(deskId, "direct:00000000-0000-4000-8000-000000000000"), false);
  assert.equal((await ring(adminId, { targetUserIds: [accountantId, pendingId] })).status, 403);
  assert.equal((await ring(adminId, { targetUserIds: [] })).status, 400);
  assert.equal((await ring(accountantId, { channelId: "dispatch", everyone: true })).status, 403);
  assert.equal((await ring(deskId, { targetUserIds: [techAId, techBId] })).status, 403);
  assert.equal((await ring(deskId, { targetRole: "field_technician" })).status, 403);
  assert.equal((await ring(techAId, { targetUserIds: [deskId] })).status, 403);
  assert.equal((await ring(adminId, { targetUserIds: [pendingId] })).status, 403);
  assert.equal((await ring(adminId, { targetRole: "field_technician", everyone: true, channelId: "dispatch" })).status, 400);
  await request(`/api/ptt/pages/groups/${second.groupId}/cancel`, deskId, { method: "POST" });
});

test("offline direct-call targets are unavailable and cannot join until answered", async () => {
  const created = await ring(techAId, { targetUserIds: [offlineId] });
  assert.equal(created.status, 201);
  const group = (await created.json()) as Group;
  assert.equal(group.pages[0].status, "unavailable");
  assert.equal(await canJoinDirectChannel(offlineId, group.channelId as `direct:${string}`), false);
  const incoming = (await (await request("/api/ptt/pages/incoming", offlineId)).json()) as Incoming;
  assert.equal(incoming.rings.some((entry) => entry.groupId === group.groupId), false);
});

test("a staff access change closes active PTT invitations and revokes direct-call membership", async () => {
  await request("/api/ptt/pages/incoming", techBId);
  const created = (await (await ring(techAId, { targetUserIds: [techBId] })).json()) as Group;
  const page = created.pages[0];
  assert.equal((await request(`/api/ptt/pages/${page.id}/respond`, techBId, {
    method: "POST",
    body: JSON.stringify({ action: "answer" }),
  })).status, 200);
  assert.equal(await canJoinDirectChannel(techBId, created.channelId as `direct:${string}`), true);

  revokePttUserSessions(techBId);
  let status = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await pool.query("SELECT status FROM ptt_pages WHERE id = $1", [page.id]);
    status = result.rows[0]?.status;
    if (status === "unavailable") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(status, "unavailable");
  assert.equal(await canJoinDirectChannel(techBId, created.channelId as `direct:${string}`), false);
  const group = (await (await request(`/api/ptt/pages/groups/${created.groupId}`, techAId)).json()) as Group;
  assert.equal(group.pages[0].status, "unavailable");
});

test("an unanswered ring is reported as missed once it expires", async () => {
  await request("/api/ptt/pages/incoming", techBId);
  const created = (await (await ring(techAId, { targetUserIds: [techBId] })).json()) as Group;
  await pool.query(`UPDATE ptt_pages SET expires_at = NOW() - INTERVAL '1 second' WHERE group_id = $1`, [created.groupId]);
  const status = (await (await request(`/api/ptt/pages/groups/${created.groupId}`, techAId)).json()) as Group;
  assert.equal(status.pages[0].status, "missed");
  const incoming = (await (await request("/api/ptt/pages/incoming", techBId)).json()) as Incoming;
  assert.equal(incoming.rings.some((r) => r.groupId === created.groupId), false);
  const late = await request(`/api/ptt/pages/${status.pages[0].id}/respond`, techBId, { method: "POST", body: JSON.stringify({ action: "answer" }) });
  assert.equal(late.status, 409);

  assert.equal(effectivePageStatus("ringing", new Date(Date.now() + 1000)), "ringing");
  assert.equal(effectivePageStatus("answered", new Date(0)), "answered");
});

test("recipient status distinguishes connected, accepted, unavailable, and revoked staff", () => {
  const expiresAt = new Date(Date.now() + 60_000);
  assert.equal(resolvedPttPageStatus({ status: "answered", expiresAt, approved: true, connected: true, online: true }), "connected");
  assert.equal(resolvedPttPageStatus({ status: "answered", expiresAt, approved: true, connected: false, online: true }), "answered");
  assert.equal(resolvedPttPageStatus({ status: "answered", expiresAt, approved: true, connected: false, online: false }), "unavailable");
  assert.equal(resolvedPttPageStatus({ status: "ringing", expiresAt, approved: false, connected: false, online: true }), "unavailable");
});
