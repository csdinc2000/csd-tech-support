import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { pool } from "./db";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { applyStaffInvitesMigration } from "./migrations/2026-09-23-staff-invites";
import { registerStaffInviteRoutes } from "./staff-invites";

test("owner-only Clerk account discovery is read-only and uses primary email plus strict identity links", async () => {
  await applyStaffAccessMigration();
  await applyStaffInvitesMigration();
  const marker = `staff-account-discovery-${process.pid}-${Date.now()}`;
  const ownerEmail = `${marker}-owner@example.invalid`;
  const directId = `user_${process.pid}${Date.now()}Direct`;
  const linkedClerkId = `user_${marker}_linked`;
  const linkedStaffId = `legacy_${marker}_linked`;
  const collisionClerkId = `user_${marker}_collision`;
  const collisionStaffId = `legacy_${marker}_collision`;
  const primaryEmailStaffId = `legacy_${marker}_primary-email`;
  const secondaryEmailStaffId = `legacy_${marker}_secondary-email`;
  const donardId = `user_${marker}_donard`;
  const noPrimaryEmailId = `user_${marker}_no-email`;
  const displayOnlyId = `user_${marker}_display-only`;
  const userIds = [
    directId,
    linkedStaffId,
    collisionStaffId,
    primaryEmailStaffId,
    secondaryEmailStaffId,
  ];
  const inviteEmails = [
    "direct@example.invalid",
    "secondary@example.invalid",
    "Display@Example.invalid",
  ];
  const oldAdminEmails = process.env.ADMIN_EMAILS;
  let server: Server | undefined;
  let providerFails = false;
  const listCalls: Array<Record<string, unknown>> = [];

  try {
    process.env.ADMIN_EMAILS = ownerEmail;
    await pool.query(
      `INSERT INTO auth_users(id,email,first_name,last_name)
       VALUES
         ($1,'direct-local@example.invalid','Direct local','User'),
         ($2,'linked-local@example.invalid','Linked local','User'),
         ($3,'collision@example.invalid','Collision local','User'),
         ($4,'primary-unverified@example.invalid','Email match only','User'),
         ($5,'secondary@example.invalid','Secondary email only','User')`,
      userIds,
    );
    await pool.query(
      `INSERT INTO staff_access_profiles(user_id,role,approval_status,can_view_voicemails,feature_permissions)
       VALUES
         ($1,'accounting','approved',TRUE,'{}'),
         ($2,'accounting','pending',TRUE,'{}'),
         ($3,'accounting','suspended',TRUE,'{}'),
         ($4,'accounting','approved',TRUE,'{}'),
         ($5,'accounting','suspended',TRUE,'{}')`,
      userIds,
    );
    await pool.query(
      "INSERT INTO auth_user_clerk_links(clerk_user_id,auth_user_id) VALUES($1,$2)",
      [linkedClerkId, linkedStaffId],
    );
    await pool.query(
      `INSERT INTO staff_invites(email,role,token_hash,expires_at)
       VALUES
         ('direct@example.invalid','accounting',$1,NOW() + INTERVAL '7 days'),
         ('secondary@example.invalid','accounting',$2,NOW() + INTERVAL '7 days'),
         ('Display@Example.invalid','accounting',$3,NOW() + INTERVAL '7 days'),
         (' display@example.invalid ','accounting',$4,NOW() + INTERVAL '7 days')`,
      [
        createHash("sha256").update(`${marker}-invite-direct`).digest("hex"),
        createHash("sha256").update(`${marker}-invite-secondary`).digest("hex"),
        createHash("sha256").update(`${marker}-invite-old`).digest("hex"),
        createHash("sha256").update(`${marker}-invite-new`).digest("hex"),
      ],
    );
    await pool.query(
      `UPDATE staff_invites SET accepted_at = NOW() - INTERVAL '1 day'
       WHERE token_hash = $1`,
      [createHash("sha256").update(`${marker}-invite-old`).digest("hex")],
    );
    await pool.query(
      `UPDATE staff_invites SET revoked_at = NOW()
       WHERE token_hash = $1`,
      [createHash("sha256").update(`${marker}-invite-new`).digest("hex")],
    );
    await pool.query(
      `UPDATE staff_invites SET created_at = CASE
         WHEN token_hash = $1 THEN NOW() - INTERVAL '2 days'
         ELSE NOW()
       END
       WHERE token_hash = ANY($2::text[])`,
      [
        createHash("sha256").update(`${marker}-invite-old`).digest("hex"),
        [
          createHash("sha256").update(`${marker}-invite-old`).digest("hex"),
          createHash("sha256").update(`${marker}-invite-new`).digest("hex"),
        ],
      ],
    );

    const records = [
      {
        id: directId,
        emailAddresses: [{ id: "direct-primary", emailAddress: "direct@example.invalid", verification: { status: "verified" } }],
        primaryEmailAddressId: "direct-primary",
        firstName: "  Direct ",
        lastName: " User ",
      },
      {
        id: linkedClerkId,
        emailAddresses: [
          { id: "linked-primary", emailAddress: "primary-unverified@example.invalid", verification: { status: "unverified" } },
          { id: "linked-secondary", emailAddress: "secondary@example.invalid", verification: { status: "verified" } },
        ],
        primaryEmailAddressId: "linked-primary",
        firstName: null,
        lastName: "Linked",
      },
      {
        id: collisionClerkId,
        emailAddresses: [{ id: "collision-primary", emailAddress: "collision@example.invalid", verification: { status: "verified" } }],
        primaryEmailAddressId: "collision-primary",
        firstName: "Email",
        lastName: "Collision",
        publicMetadata: { userId: collisionStaffId },
      },
      {
        id: donardId,
        emailAddresses: [{ id: "donard-primary", emailAddress: "donard@example.invalid", verification: { status: "verified" } }],
        primaryEmailAddressId: "donard-primary",
        firstName: " ",
        lastName: null,
      },
      {
        id: noPrimaryEmailId,
        emailAddresses: [{ id: "non-primary", emailAddress: "secondary@example.invalid", verification: { status: "verified" } }],
        primaryEmailAddressId: null,
        firstName: null,
        lastName: null,
      },
      {
        id: displayOnlyId,
        emailAddresses: [{ id: "display-primary", emailAddress: "Display@Example.invalid", verification: { status: "verified" } }],
        primaryEmailAddressId: "display-primary",
        firstName: "Display",
        lastName: "Only",
      },
      ...Array.from({ length: 16 }, (_, index) => ({
        id: `user_${marker}_page_${index}`,
        emailAddresses: [],
        primaryEmailAddressId: null,
        firstName: null,
        lastName: null,
      })),
    ];
    const watchedUserIds = [...new Set([...userIds, ...records.map((account) => account.id)])];
    const watchedClerkIds = records.map((account) => account.id);

    const app = express();
    app.use((req, _res, next) => {
      const email = req.header("x-test-email") || "";
      const auth = (() => ({
        tokenType: "session_token",
        userId: "test-clerk-user",
        sessionClaims: { email },
      })) as (() => unknown) & Record<PropertyKey, unknown>;
      auth[Symbol.for("@clerk/express.auth")] = true;
      (req as unknown as { auth: typeof auth }).auth = auth;
      req.dbUser = { id: "test-db-user" } as NonNullable<typeof req.dbUser>;
      next();
    });
    registerStaffInviteRoutes(app, {
      listAccounts: async (options) => {
        listCalls.push(options);
        if (providerFails) throw new Error("raw Clerk payload containing a secret");
        if (options.userId) {
          const selected = records.filter((account) => options.userId!.includes(account.id));
          return { data: selected, totalCount: selected.length };
        }
        return {
          data: records.slice(options.offset, options.offset + options.limit),
          totalCount: records.length,
        };
      },
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start account discovery test server");
    const base = `http://127.0.0.1:${address.port}`;
    const request = (path: string, email = ownerEmail) =>
      fetch(`${base}${path}`, { headers: { "x-test-email": email } });

    const unauthorized = await request(
      `/api/staff-access/accounts?clerkUserId=${encodeURIComponent(directId)}`,
      "not-owner@example.invalid",
    );
    assert.equal(unauthorized.status, 403);
    assert.equal(listCalls.length, 0);

    const invalidQuery = await request(`/api/staff-access/accounts?q=${"x".repeat(101)}`);
    assert.equal(invalidQuery.status, 400);
    const malformedClerkUserId = await request("/api/staff-access/accounts?clerkUserId=user_bad-id");
    assert.equal(malformedClerkUserId.status, 400);
    const tooLongClerkUserId = await request(
      `/api/staff-access/accounts?clerkUserId=user_${"A".repeat(96)}`,
    );
    assert.equal(tooLongClerkUserId.status, 400);
    const repeatedClerkUserId = await request(
      "/api/staff-access/accounts?clerkUserId=user_First1&clerkUserId=user_Second2",
    );
    assert.equal(repeatedClerkUserId.status, 400);
    assert.equal(listCalls.length, 0);

    const beforeSnapshot = await snapshotDiscoveryState(watchedUserIds, watchedClerkIds, inviteEmails);
    const firstPageResponse = await request("/api/staff-access/accounts?q=%20Donard%20Williams%20&offset=0");
    assert.equal(firstPageResponse.status, 200);
    const firstPage = await firstPageResponse.json() as any;
    assert.equal(firstPage.accounts.length, 20);
    assert.equal(firstPage.totalCount, 22);
    assert.equal(firstPage.nextOffset, 20);
    assert.deepEqual(listCalls[0], {
      query: "Donard Williams",
      limit: 20,
      offset: 0,
      orderBy: "-created_at",
    });

    const direct = firstPage.accounts.find((account: any) => account.clerkUserId === directId);
    assert.deepEqual(direct, {
      clerkUserId: directId,
      email: "direct@example.invalid",
      firstName: "Direct",
      lastName: "User",
      emailVerified: true,
      staffUserId: directId,
      approvalStatus: "approved",
      invitationStatus: "pending",
    });
    const linked = firstPage.accounts.find((account: any) => account.clerkUserId === linkedClerkId);
    assert.equal(linked.emailVerified, false);
    assert.equal(linked.staffUserId, linkedStaffId);
    assert.equal(linked.approvalStatus, "pending");
    assert.equal(linked.invitationStatus, null);
    const collision = firstPage.accounts.find((account: any) => account.clerkUserId === collisionClerkId);
    assert.equal(collision.staffUserId, null);
    assert.equal(collision.approvalStatus, null);
    const donard = firstPage.accounts.find((account: any) => account.clerkUserId === donardId);
    assert.deepEqual(donard, {
      clerkUserId: donardId,
      email: "donard@example.invalid",
      firstName: null,
      lastName: null,
      emailVerified: true,
      staffUserId: null,
      approvalStatus: null,
      invitationStatus: null,
    });
    const noPrimaryEmail = firstPage.accounts.find((account: any) => account.clerkUserId === noPrimaryEmailId);
    assert.equal(noPrimaryEmail.email, null);
    assert.equal(noPrimaryEmail.emailVerified, false);
    assert.equal(noPrimaryEmail.staffUserId, null);

    const secondPageResponse = await request("/api/staff-access/accounts?q=%20Donard%20Williams%20&offset=20");
    assert.equal(secondPageResponse.status, 200);
    const secondPage = await secondPageResponse.json() as any;
    assert.equal(secondPage.accounts.length, 2);
    assert.equal(secondPage.nextOffset, null);
    assert.equal(listCalls[1].offset, 20);
    assert.equal(Object.hasOwn(listCalls[0], "userId"), false);

    const exactSelectionResponse = await request(
      `/api/staff-access/accounts?clerkUserId=${encodeURIComponent(directId)}`,
    );
    assert.equal(exactSelectionResponse.status, 200);
    const exactSelection = await exactSelectionResponse.json() as any;
    assert.equal(exactSelection.accounts.length, 1);
    assert.equal(exactSelection.accounts[0].clerkUserId, directId);
    assert.equal(exactSelection.accounts[0].staffUserId, directId);
    assert.equal(exactSelection.totalCount, 1);
    assert.equal(exactSelection.nextOffset, null);
    assert.deepEqual(listCalls[2], {
      query: undefined,
      limit: 20,
      offset: 0,
      orderBy: "-created_at",
      userId: [directId],
    });

    const displayOnly = firstPage.accounts.find((account: any) => account.clerkUserId === displayOnlyId);
    assert.equal(displayOnly.staffUserId, null);
    assert.equal(displayOnly.invitationStatus, "revoked");

    providerFails = true;
    const providerFailure = await request("/api/staff-access/accounts");
    assert.equal(providerFailure.status, 503);
    const failureBody = await providerFailure.text();
    assert.doesNotMatch(failureBody, /raw Clerk payload|secret/);
    assert.deepEqual(await snapshotDiscoveryState(watchedUserIds, watchedClerkIds, inviteEmails), beforeSnapshot);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await pool.query("DELETE FROM staff_invites WHERE LOWER(BTRIM(email)) = ANY($1::text[])", [
      inviteEmails.map((email) => email.toLowerCase()),
    ]);
    await pool.query("DELETE FROM staff_access_audit WHERE target_user_id = ANY($1::text[])", [userIds]);
    await pool.query("DELETE FROM staff_access_profiles WHERE user_id = ANY($1::text[])", [userIds]);
    await pool.query("DELETE FROM auth_user_clerk_links WHERE clerk_user_id = $1", [linkedClerkId]);
    await pool.query("DELETE FROM auth_users WHERE id = ANY($1::text[])", [userIds]);
    if (oldAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = oldAdminEmails;
  }
});

async function snapshotDiscoveryState(
  userIds: string[],
  clerkIds: string[],
  inviteEmails: string[],
): Promise<string> {
  const [users, profiles, links, invitations, audit] = await Promise.all([
    pool.query("SELECT * FROM auth_users WHERE id = ANY($1::text[]) ORDER BY id", [userIds]),
    pool.query("SELECT * FROM staff_access_profiles WHERE user_id = ANY($1::text[]) ORDER BY user_id", [userIds]),
    pool.query("SELECT * FROM auth_user_clerk_links WHERE clerk_user_id = ANY($1::text[]) ORDER BY clerk_user_id", [clerkIds]),
    pool.query(
      "SELECT * FROM staff_invites WHERE LOWER(BTRIM(email)) = ANY($1::text[]) ORDER BY id",
      [inviteEmails.map((email) => email.toLowerCase())],
    ),
    pool.query("SELECT * FROM staff_access_audit WHERE target_user_id = ANY($1::text[]) ORDER BY id", [userIds]),
  ]);
  return JSON.stringify([users.rows, profiles.rows, links.rows, invitations.rows, audit.rows]);
}