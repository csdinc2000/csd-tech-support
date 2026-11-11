import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { pool } from "./db";
import { registerRoutes } from "./routes/routes";
import { applySharedRateLimitsMigration } from "./migrations/2026-09-16-shared-rate-limits";
import { applySlackNotificationOutboxMigration } from "./migrations/2026-09-27-slack-notification-outbox";

const marker = `provider-health-access-${process.pid}-${Date.now()}`;
const ownerId = `${marker}-owner`;
const staffId = `${marker}-staff`;
const ownerEmail = `${marker}-owner@example.invalid`;
let previousAdminEmails: string | undefined;
let server: Server;
let baseUrl = "";
let warningSettings:
  | { mode: "default"; value: null }
  | { mode: "percentage"; value: number }
  | { mode: "remainingCredits"; value: number } = { mode: "percentage", value: 15 };
let warningSettingsUpdateResult: unknown;
let warningSettingsAuditResult: unknown = { items: [], nextCursor: null };
let recheckCalls = 0;
let providerStatus: Record<string, unknown> = {
  available: false,
  state: "unavailable",
  reason: "permission_denied",
  checkedAt: "2026-09-16T12:00:00.000Z",
  balance: null,
  unexpectedProviderDetail: "must not leave the API boundary",
};

function request(path: string, actor?: "owner" | "staff", init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(actor ? { "x-test-actor": actor } : {}),
      ...init?.headers,
    },
  });
}

before(async () => {
  previousAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = ownerEmail;
  await applySharedRateLimitsMigration();
  await applySlackNotificationOutboxMigration();

  await pool.query(
    `INSERT INTO auth_users(id,email,first_name,last_name)
     VALUES($1,$2,'Owner','Test'),($3,$4,'Staff','Test')
     ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email`,
    [ownerId, ownerEmail, staffId, `${marker}-staff@example.invalid`],
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = req.header("x-test-actor");
    const userId = actor === "owner" ? ownerId : actor === "staff" ? staffId : undefined;
    const email = actor === "owner"
      ? ownerEmail
      : actor === "staff"
        ? `${marker}-staff@example.invalid`
        : undefined;
    (req as any).auth = Object.assign(() => ({
      userId,
      sessionClaims: userId ? { userId, email } : undefined,
    }), { [Symbol.for("@clerk/express.auth")]: true });
    if (userId) {
      req.dbUser = {
        id: userId,
        email: email ?? null,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }
    (req as any).log = { error() {}, warn() {}, info() {} };
    next();
  });

  server = await registerRoutes(app, {
    disableBackgroundServices: true,
    providerHealthAuthMiddleware: (req, res, next) => {
      if (!req.dbUser) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }
      next();
    },
    getProviderHealthWarningSettings: async () => warningSettings,
    getProviderHealthWarningSettingsAudit: async () => warningSettingsAuditResult as {
      items: [];
      nextCursor: null;
    },
    getProviderHealthEmailCapacityStatus: () => providerStatus,
    recheckProviderHealthEmailCapacity: async () => {
      recheckCalls++;
      return {
        available: false,
        state: "unavailable",
        reason: "permission_denied",
        checkedAt: "2026-09-16T12:00:00.000Z",
        balance: null,
        unexpectedProviderDetail: "must not leave the API boundary",
      };
    },
    updateProviderHealthWarningSettings: async (settings, _actor) => {
      warningSettings = settings;
      return (warningSettingsUpdateResult ?? settings) as typeof settings;
    },
  });
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query("DELETE FROM slack_notification_outbox WHERE dedupe_key LIKE $1", [`${marker}%`]);
  await pool.query("DELETE FROM shared_rate_limits WHERE rate_key = $1", [
    `provider-health-email-recheck:${ownerId}`,
  ]);
  await pool.query("DELETE FROM auth_users WHERE id IN ($1,$2)", [ownerId, staffId]);
  if (previousAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = previousAdminEmails;
});

test("provider health rejects unauthenticated and ordinary staff requests", async () => {
  assert.equal((await request("/api/provider-health/email")).status, 401);
  const staffResponse = await request("/api/provider-health/email", "staff");
  assert.equal(staffResponse.status, 403, await staffResponse.text());
});

test("owners see sanitized terminal failures and repeated retry requests queue exactly one audited recovery notice", async () => {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO slack_notification_outbox
      (dedupe_key, notification_type, status, attempt_count, payload, last_error_category)
     VALUES ($1, 'call', 'failed', 8, NULL, 'transport_error') RETURNING id`,
    [`${marker}-failed`],
  );
  const id = Number(inserted.rows[0]!.id);
  const listUrl = "/api/provider-health/slack/failures";
  const retryUrl = `${listUrl}/${id}/retry`;
  assert.equal((await request(listUrl)).status, 401);
  assert.equal((await request(listUrl, "staff")).status, 403);
  assert.equal((await request(retryUrl, "staff", { method: "POST" })).status, 403);
  assert.equal((await request(retryUrl, undefined, { method: "POST" })).status, 401);

  const failuresResponse = await request(listUrl, "owner");
  assert.equal(failuresResponse.status, 200);
  const failures = await failuresResponse.json() as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(failures.find((row) => row.id === id)!).sort(),
    ["category", "failedAt", "id", "retryId", "retryRequestedAt", "type"]);
  assert.equal(failures.find((row) => row.id === id)?.category, "transport_error");
  assert.equal(failures.find((row) => row.id === id)?.type, "call");

  const responses = await Promise.all([
    request(retryUrl, "owner", { method: "POST" }),
    request(retryUrl, "owner", { method: "POST" }),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const retryResults = await Promise.all(responses.map((response) => response.json())) as Array<{ retryId: number }>;
  assert.equal(retryResults[0]!.retryId, retryResults[1]!.retryId);
  const saved = await pool.query<{
    retry_requested_by: string; payload: { text: string }; retry_of_id: string;
  }>("SELECT retry_requested_by, payload, retry_of_id FROM slack_notification_outbox WHERE retry_of_id = $1", [id]);
  assert.equal(saved.rowCount, 1);
  assert.equal(saved.rows[0]!.retry_requested_by, ownerId);
  assert.equal(Number(saved.rows[0]!.retry_of_id), id);
  assert.match(saved.rows[0]!.payload.text, /call event failed/);
  const updatedFailures = await (await request(listUrl, "owner")).json() as Array<{ id: number; retryId: number | null; retryRequestedAt: string | null }>;
  assert.equal(updatedFailures.find((row) => row.id === id)?.retryId, retryResults[0]!.retryId);
  assert.ok(updatedFailures.find((row) => row.id === id)?.retryRequestedAt);
  assert.equal((await request(`${listUrl}/999999999/retry`, "owner", { method: "POST" })).status, 404);
  assert.equal((await request(`${listUrl}/invalid/retry`, "owner", { method: "POST" })).status, 400);
  await pool.query("DELETE FROM slack_notification_outbox WHERE retry_of_id = $1", [id]);
});

test("provider health returns only the sanitized monitoring contract to owners", async () => {
  const response = await request("/api/provider-health/email", "owner");
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as Record<string, unknown>;

  assert.deepEqual(Object.keys(body).sort(), [
    "proactiveCapacityMonitoring",
    "provider",
    "safeDefaults",
    "warningSettings",
  ]);
  assert.deepEqual(
    Object.keys(body.proactiveCapacityMonitoring as Record<string, unknown>).sort(),
    ["available", "balance", "checkedAt", "reason", "state"],
  );
  assert.deepEqual(
    Object.keys(body.warningSettings as Record<string, unknown>).sort(),
    ["mode", "value"],
  );
  assert.deepEqual(
    Object.keys(body.safeDefaults as Record<string, unknown>).sort(),
    ["percentage", "remainingCredits"],
  );
});

test("provider health rejects missing or invalid required provider status fields without exposing details", async () => {
  const malformedStatuses: Record<string, unknown>[] = [
    {
      available: false,
      state: "unavailable",
      reason: "permission_denied",
      checkedAt: "2026-09-16T12:00:00.000Z",
    },
    {
      available: "no",
      state: "provider-secret-state",
      reason: "permission_denied",
      checkedAt: "2026-09-16T12:00:00.000Z",
      balance: null,
    },
  ];

  for (const malformedStatus of malformedStatuses) {
    providerStatus = malformedStatus;
    const response = await request("/api/provider-health/email", "owner");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "Email provider health is temporarily unavailable",
    });
  }

  providerStatus = {
    available: false,
    state: "unavailable",
    reason: "permission_denied",
    checkedAt: "2026-09-16T12:00:00.000Z",
    balance: null,
    unexpectedProviderDetail: "must not leave the API boundary",
  };
});

test("provider health warning settings reject non-owners and remain usable by owners", async () => {
  const path = "/api/provider-health/email/warning-settings";
  const init = { method: "PATCH", body: JSON.stringify({ mode: "default", value: null }) };

  assert.equal((await request(path, undefined, init)).status, 401);
  assert.equal((await request(path, "staff", init)).status, 403);

  const ownerResponse = await request(path, "owner", init);
  assert.equal(ownerResponse.status, 200, await ownerResponse.clone().text());
  assert.deepEqual(await ownerResponse.json(), { mode: "default", value: null });

  const invalidResponse = await request(path, "owner", {
    method: "PATCH",
    body: JSON.stringify({ mode: "percentage", value: 0 }),
  });
  assert.equal(invalidResponse.status, 400);
});

test("provider health warning settings reject malformed persistence responses without exposing details", async () => {
  const unsanitizedStorageDetail = "storage-row-secret-must-not-leak";
  warningSettingsUpdateResult = {
    mode: "percentage",
    value: "invalid",
    unsanitizedStorageDetail,
  };

  try {
    const response = await request("/api/provider-health/email/warning-settings", "owner", {
      method: "PATCH",
      body: JSON.stringify({ mode: "percentage", value: 20 }),
    });
    const responseText = await response.text();

    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(responseText), {
      error: "Email provider health is temporarily unavailable",
    });
    assert.equal(responseText.includes(unsanitizedStorageDetail), false);
  } finally {
    warningSettingsUpdateResult = undefined;
  }
});

test("provider health warning history rejects malformed persistence responses without exposing details", async () => {
  const unsanitizedStorageDetail = "audit-storage-row-secret-must-not-leak";
  warningSettingsAuditResult = {
    items: [{
      id: "audit-1",
      actor: { userId: ownerId, email: ownerEmail },
      previousSettings: { mode: "default", value: null },
      newSettings: { mode: "percentage", value: "invalid" },
      changedAt: "2026-09-16T12:00:00.000Z",
      unsanitizedStorageDetail,
    }],
    nextCursor: null,
  };

  try {
    const response = await request(
      "/api/provider-health/email/warning-settings/history",
      "owner",
    );
    const responseText = await response.text();

    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(responseText), {
      error: "Email provider health is temporarily unavailable",
    });
    assert.equal(responseText.includes(unsanitizedStorageDetail), false);

    const exportResponse = await request(
      "/api/provider-health/email/warning-settings/history/export",
      "owner",
    );
    const exportText = await exportResponse.text();
    assert.equal(exportResponse.status, 500);
    assert.equal(exportResponse.headers.get("content-type")?.startsWith("text/csv"), false);
    assert.equal(exportText.includes(unsanitizedStorageDetail), false);
  } finally {
    warningSettingsAuditResult = { items: [], nextCursor: null };
  }
});

test("provider health recheck is owner-only, sanitized, and rate-limited", async () => {
  const path = "/api/provider-health/email/recheck";
  const init = { method: "POST" };

  assert.equal((await request(path, undefined, init)).status, 401);
  assert.equal((await request(path, "staff", init)).status, 403);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await request(path, "owner", init);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["available", "balance", "checkedAt", "reason", "state"]);
    assert.deepEqual(body, {
      available: false,
      state: "unavailable",
      reason: "permission_denied",
      checkedAt: "2026-09-16T12:00:00.000Z",
      balance: null,
    });
  }

  const limited = await request(path, "owner", init);
  assert.equal(limited.status, 429, await limited.clone().text());
  assert.ok(limited.headers.get("retry-after"));
  assert.equal(recheckCalls, 3);
});
