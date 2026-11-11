import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { randomUUID } from "node:crypto";
import { apiAuthenticationBoundary } from "./api-auth-boundary";
import { pool } from "./db";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { applyCallForwardingOutcomesMigration } from "./migrations/2026-10-26-call-forwarding-outcomes";
import { applyCallForwardingStaffOutcomesMigration } from "./migrations/2026-10-27-call-forwarding-staff-outcomes";
import { listCallForwardingOutcomes, upsertCallForwardingOutcome } from "./twilio-settings-storage";
import {
  readForwardingCallOutcomes,
  readRingingCalls,
  registerIncomingCallAlerts,
} from "./incoming-call-alerts";

const business = "+12025550100";
const parent = { sid: "parent", parentCallSid: null, to: business, direction: "inbound", status: "in-progress" };
const leg = { sid: "leg", parentCallSid: "parent", to: "+12025550101", direction: "outbound-dial", status: "ringing" };

test("alerts only on real ringing legs and deduplicates one customer's call", async () => {
  let reads = 0;
  const result = await readRingingCalls({
    list: async () => [leg, { ...leg, sid: "second-leg" }],
    parent: async () => { reads++; return parent; },
  }, business);
  assert.equal(reads, 1);
  assert.equal(result.length, 1);
  assert.deepEqual(Object.keys(result[0]), ["id"]);
  assert.ok(!JSON.stringify(result).includes(business));
  assert.notEqual(result[0].id, parent.sid);
});

test("does not ring for answered legs, unrelated outbound calls, other numbers or ended callers", async () => {
  for (const item of [
    { ...leg, status: "completed" },
    { ...leg, status: "in-progress" },
    { ...leg, direction: "outbound-api", parentCallSid: null },
  ]) {
    assert.deepEqual(await readRingingCalls({
      list: async () => [item], parent: async () => { throw new Error("Should not fetch"); },
    }, business), []);
  }
  for (const item of [{ ...parent, to: "+12025550999" }, { ...parent, status: "completed" }]) {
    assert.deepEqual(await readRingingCalls({ list: async () => [leg], parent: async () => item }, business), []);
  }
});

test("provider failures are not misrepresented as silence/success", async () => {
  await assert.rejects(readRingingCalls({
    list: async () => { throw new Error("Provider unavailable"); }, parent: async () => parent,
  }, business), /Provider unavailable/);
});

test("the shared API gate denies ringing-call reads before Twilio access", async () => {
  const marker = `ringing-call-auth-${randomUUID()}`;
  const actors = {
    pending: `${marker}-pending`,
    noCommunications: `${marker}-no-communications`,
    communications: `${marker}-communications`,
  };
  const previousAdminEmails = process.env.ADMIN_EMAILS;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  let sourceLoads = 0;
  let listReads = 0;
  let parentReads = 0;

  try {
    process.env.ADMIN_EMAILS = "";
    await applyStaffAccessMigration();
    await pool.query(
      `INSERT INTO auth_users(id,email) VALUES
       ($1,$2),($3,$4),($5,$6)`,
      [
        actors.pending, `${actors.pending}@example.invalid`,
        actors.noCommunications, `${actors.noCommunications}@example.invalid`,
        actors.communications, `${actors.communications}@example.invalid`,
      ],
    );
    await pool.query(
      `INSERT INTO staff_access_profiles(user_id,role,approval_status,feature_permissions) VALUES
       ($1,'field_technician','pending','{}'::jsonb),
       ($2,'software_developer','approved','{}'::jsonb),
       ($3,'field_technician','approved','{}'::jsonb)`,
      [actors.pending, actors.noCommunications, actors.communications],
    );

    const app = express();
    // Substitute only Clerk session verification. Production requireAuth and
    // the shared approval/feature gate still resolve the real database rows.
    app.use((req, _res, next) => {
      const actor = req.header("x-test-actor");
      const userId = actor && Object.values(actors).includes(actor) ? actor : null;
      (req as any).auth = Object.assign(() => ({
        tokenType: "session_token",
        userId,
        sessionClaims: userId
          ? { userId, email: `${userId}@example.invalid` }
          : null,
      }), { [Symbol.for("@clerk/express.auth")]: true });
      next();
    });
    app.use(apiAuthenticationBoundary);
    registerIncomingCallAlerts(app, {
      loadRingingCallSource: async () => {
        sourceLoads++;
        return {
          businessNumber: business,
          reader: {
            list: async () => {
              listReads++;
              return [leg];
            },
            parent: async () => {
              parentReads++;
              return parent;
            },
          },
        };
      },
    });

    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not start ringing-call authorization test server");
    }
    const endpoint = `http://127.0.0.1:${address.port}/api/twilio/ringing-calls`;

    const signedOut = await fetch(endpoint);
    assert.equal(signedOut.status, 401);
    const signedOutBody = await signedOut.json() as { message: string };
    assert.equal(signedOutBody.message, "Authentication required");

    for (const actor of [actors.pending, actors.noCommunications]) {
      const denied = await fetch(endpoint, { headers: { "x-test-actor": actor } });
      assert.equal(denied.status, 403, `${actor}: ${await denied.clone().text()}`);
      const body = await denied.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(body), ["message"]);
      assert.ok(!JSON.stringify(body).includes(parent.sid));
    }

    assert.equal(sourceLoads, 0, "denied requests must not load a Twilio call source");
    assert.equal(listReads, 0, "denied requests must not list Twilio calls");
    assert.equal(parentReads, 0, "denied requests must not fetch parent calls");

    const authorized = await fetch(endpoint, {
      headers: { "x-test-actor": actors.communications },
    });
    assert.equal(authorized.status, 200, await authorized.clone().text());
    const body = await authorized.json() as {
      ringing: Array<{ id: string }>;
      checkedAt: string;
    };
    assert.deepEqual(Object.keys(body), ["ringing", "checkedAt"]);
    assert.deepEqual(Object.keys(body.ringing[0]), ["id"]);
    assert.match(body.ringing[0].id, /^[a-f0-9]{24}$/);
    assert.notEqual(body.ringing[0].id, parent.sid);
    assert.ok(!JSON.stringify(body).includes(parent.sid));
    assert.ok(Number.isFinite(Date.parse(body.checkedAt)));
    assert.equal(sourceLoads, 1);
    assert.equal(listReads, 1);
    assert.equal(parentReads, 1);
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => error ? reject(error) : resolve()),
      );
    }
    await pool.query("DELETE FROM auth_users WHERE id=ANY($1::text[])", [Object.values(actors)]);
    if (previousAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previousAdminEmails;
  }
});

test("forwarding details separate provider progress from confirmed human acceptance", async () => {
  const outcomes = await readForwardingCallOutcomes({
    list: async () => [
      { sid: "leg-1", to: "+12025550101", status: "ringing", duration: null, dateUpdated: null },
      { sid: "leg-2", to: "+12025550102", status: "completed", duration: 12, dateUpdated: null },
    ],
  }, [
    { key: "primary", number: "+12025550101" },
    { key: "backup1", number: "+12025550102" },
  ], [
    { childCallSid: "leg-2", attemptKey: "backup1", destinationNumber: "+12025550102", humanAccepted: true },
  ]);

  assert.equal(outcomes[0].attemptKey, "primary");
  assert.equal(outcomes[0].providerStatus, "ringing");
  assert.equal(outcomes[0].humanAccepted, null);
  assert.equal(outcomes[0].audibleHandsetRingingConfirmed, false);
  assert.equal(outcomes[1].attemptKey, "backup1");
  assert.equal(outcomes[1].humanAccepted, true);
  assert.equal(outcomes[1].audibleHandsetRingingConfirmed, false);
});

test("staff phone acceptance is matched by child call SID, not just destination", async () => {
  const outcomes = await readForwardingCallOutcomes({
    list: async () => [
      { sid: "leg-1", to: "+12025550101", status: "canceled", duration: 0, dateUpdated: null },
      { sid: "leg-2", to: "+12025550101", status: "completed", duration: 12, dateUpdated: null },
    ],
  }, [], [
    { childCallSid: "leg-2", attemptKey: "staff", destinationNumber: "+12025550101", humanAccepted: true },
  ]);

  assert.equal(outcomes[0].attemptKey, "other");
  assert.equal(outcomes[0].humanAccepted, null);
  assert.equal(outcomes[1].attemptKey, "staff");
  assert.equal(outcomes[1].humanAccepted, true);
});

test("later provider status callbacks cannot erase confirmed staff acceptance", async () => {
  const parentCallSid = `CA${randomUUID().replace(/-/g, "").slice(0, 32)}`;
  const childCallSid = `CA${randomUUID().replace(/-/g, "").slice(0, 32)}`;
  await applyCallForwardingOutcomesMigration();
  await applyCallForwardingStaffOutcomesMigration();

  try {
    await upsertCallForwardingOutcome({
      parentCallSid,
      childCallSid,
      attemptKey: "staff",
      destinationNumber: "+12025550101",
      providerStatus: "unknown",
      humanAccepted: true,
    });
    await upsertCallForwardingOutcome({
      parentCallSid,
      childCallSid,
      attemptKey: "staff",
      destinationNumber: "+12025550101",
      providerStatus: "completed",
      humanAccepted: false,
    });
    const [outcome] = await listCallForwardingOutcomes(parentCallSid);
    assert.equal(outcome?.providerStatus, "completed");
    assert.equal(outcome?.humanAccepted, true);
  } finally {
    await pool.query("DELETE FROM call_forwarding_outcomes WHERE parent_call_sid = $1", [parentCallSid]);
  }
});
