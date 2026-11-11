import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { pool } from "./db";
import { applyEmailCapacitySettingsMigration } from "./migrations/2026-09-14-email-capacity-settings";
import { registerRoutes } from "./routes/routes";

const marker = `email-capacity-settings-${process.pid}-${Date.now()}`;
const ownerId = `${marker}-owner`;
const staffId = `${marker}-staff`;
const ownerEmail = `${marker}-owner@example.invalid`;
const staffEmail = `${marker}-staff@example.invalid`;
let previousAdminEmails: string | undefined;
let previousSettings: { warning_mode: string; warning_value: number | null } | undefined;
let server: Server | undefined;
let baseUrl = "";

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actor = req.header("x-test-actor");
    const userId = actor === "owner" ? ownerId : actor === "staff" ? staffId : undefined;
    const email = actor === "owner" ? ownerEmail : actor === "staff" ? staffEmail : undefined;
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
  });
  server.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server!.close((error) => error ? reject(error) : resolve());
  });
  server = undefined;
}

function request(path: string, actor: "owner" | "staff", init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      "x-test-actor": actor,
      ...init?.headers,
    },
  });
}

before(async () => {
  previousAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = ownerEmail;
  await applyEmailCapacitySettingsMigration();

  const saved = await pool.query<{ warning_mode: string; warning_value: number | null }>(
    "SELECT warning_mode, warning_value FROM email_capacity_settings WHERE id = 1",
  );
  previousSettings = saved.rows[0];

  await pool.query(
    `INSERT INTO auth_users(id,email,first_name,last_name)
     VALUES($1,$2,'Owner','Test'),($3,$4,'Staff','Test')
     ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email`,
    [ownerId, ownerEmail, staffId, staffEmail],
  );
  await pool.query("DELETE FROM email_capacity_settings WHERE id = 1");
  await pool.query("DELETE FROM email_capacity_settings_audit WHERE actor_user_id IN ($1,$2)", [ownerId, staffId]);
  await startServer();
});

after(async () => {
  await stopServer();
  await pool.query("DELETE FROM email_capacity_settings_audit WHERE actor_user_id IN ($1,$2)", [ownerId, staffId]);
  if (previousSettings) {
    await pool.query(
      `INSERT INTO email_capacity_settings(id, warning_mode, warning_value)
       VALUES(1, $1, $2)
       ON CONFLICT(id) DO UPDATE
         SET warning_mode=EXCLUDED.warning_mode, warning_value=EXCLUDED.warning_value`,
      [previousSettings.warning_mode, previousSettings.warning_value],
    );
  } else {
    await pool.query("DELETE FROM email_capacity_settings WHERE id = 1");
  }
  await pool.query("DELETE FROM auth_users WHERE id IN ($1,$2)", [ownerId, staffId]);
  if (previousAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = previousAdminEmails;
});

test("email warning settings are owner-only", async () => {
  const getResponse = await request("/api/provider-health/email", "staff");
  assert.equal(getResponse.status, 403, await getResponse.text());

  const patchResponse = await request("/api/provider-health/email/warning-settings", "staff", {
    method: "PATCH",
    body: JSON.stringify({ mode: "percentage", value: 25 }),
  });
  assert.equal(patchResponse.status, 403, await patchResponse.text());

  const historyResponse = await request("/api/provider-health/email/warning-settings/history", "staff");
  assert.equal(historyResponse.status, 403, await historyResponse.text());
  const exportResponse = await request("/api/provider-health/email/warning-settings/history/export", "staff");
  assert.equal(exportResponse.status, 403, await exportResponse.text());
  const anonymousExport = await fetch(`${baseUrl}/api/provider-health/email/warning-settings/history/export`);
  assert.equal(anonymousExport.status, 401);
});

test("owners can read and update email warning settings", async () => {
  const initial = await request("/api/provider-health/email", "owner");
  assert.equal(initial.status, 200, await initial.clone().text());
  assert.deepEqual((await initial.json() as any).warningSettings, { mode: "default", value: null });

  const updated = await request("/api/provider-health/email/warning-settings", "owner", {
    method: "PATCH",
    body: JSON.stringify({ mode: "percentage", value: 25 }),
  });
  assert.equal(updated.status, 200, await updated.clone().text());
  assert.deepEqual(await updated.json(), { mode: "percentage", value: 25 });

  const historyResponse = await request("/api/provider-health/email/warning-settings/history", "owner");
  assert.equal(historyResponse.status, 200, await historyResponse.clone().text());
  const historyPage = await historyResponse.json() as any;
  assert.equal(historyPage.items.length, 1);
  assert.equal(historyPage.nextCursor, null);
  assert.deepEqual(historyPage.items[0].actor, { userId: ownerId, email: ownerEmail });
  assert.deepEqual(historyPage.items[0].previousSettings, { mode: "default", value: null });
  assert.deepEqual(historyPage.items[0].newSettings, { mode: "percentage", value: 25 });
  assert.equal(Number.isNaN(Date.parse(historyPage.items[0].changedAt)), false);
  assert.deepEqual(
    Object.keys(historyPage.items[0]).sort(),
    ["actor", "changedAt", "id", "newSettings", "previousSettings"],
  );
});

test("invalid percentages and remaining-credit thresholds are rejected", async () => {
  const invalidSettings = [
    { mode: "percentage", value: 0 },
    { mode: "percentage", value: 101 },
    { mode: "remainingCredits", value: 0 },
    { mode: "remainingCredits", value: 1_000_000_001 },
  ];

  for (const settings of invalidSettings) {
    const response = await request("/api/provider-health/email/warning-settings", "owner", {
      method: "PATCH",
      body: JSON.stringify(settings),
    });
    assert.equal(response.status, 400, `${JSON.stringify(settings)}: ${await response.text()}`);
  }
});

test("saved email warning settings survive server reinitialization", async () => {
  await stopServer();
  await startServer();

  const response = await request("/api/provider-health/email", "owner");
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json() as any).warningSettings, { mode: "percentage", value: 25 });
});

test("concurrent first-time updates produce a continuous audit chain", async () => {
  await pool.query("DELETE FROM email_capacity_settings_audit WHERE actor_user_id = $1", [ownerId]);
  await pool.query("DELETE FROM email_capacity_settings WHERE id = 1");

  const updates = [
    { mode: "percentage", value: 20 },
    { mode: "remainingCredits", value: 500 },
  ];
  const responses = await Promise.all(updates.map((settings) =>
    request("/api/provider-health/email/warning-settings", "owner", {
      method: "PATCH",
      body: JSON.stringify(settings),
    })
  ));
  for (const response of responses) {
    assert.equal(response.status, 200, await response.text());
  }

  const historyResponse = await request("/api/provider-health/email/warning-settings/history", "owner");
  assert.equal(historyResponse.status, 200, await historyResponse.clone().text());
  const history = (await historyResponse.json() as any).items;
  assert.equal(history.length, 2);
  assert.deepEqual(history[1].previousSettings, { mode: "default", value: null });
  assert.deepEqual(history[0].previousSettings, history[1].newSettings);

  const currentResponse = await request("/api/provider-health/email", "owner");
  assert.equal(currentResponse.status, 200, await currentResponse.clone().text());
  assert.deepEqual((await currentResponse.json() as any).warningSettings, history[0].newSettings);
});

test("owners can page through warning history without gaps or duplicates", async () => {
  const firstResponse = await request(
    "/api/provider-health/email/warning-settings/history?limit=1",
    "owner",
  );
  assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
  const firstPage = await firstResponse.json() as any;
  assert.equal(firstPage.items.length, 1);
  assert.equal(typeof firstPage.nextCursor, "string");

  const secondResponse = await request(
    `/api/provider-health/email/warning-settings/history?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    "owner",
  );
  assert.equal(secondResponse.status, 200, await secondResponse.clone().text());
  const secondPage = await secondResponse.json() as any;
  assert.equal(secondPage.items.length, 1);
  assert.notEqual(secondPage.items[0].id, firstPage.items[0].id);
  assert.equal(secondPage.nextCursor, null);
});

test("new warning changes do not shift older cursor pages", async () => {
  await pool.query("DELETE FROM email_capacity_settings_audit WHERE actor_user_id = $1", [ownerId]);
  await pool.query("DELETE FROM email_capacity_settings WHERE id = 1");

  for (const settings of [
    { mode: "percentage", value: 20 },
    { mode: "remainingCredits", value: 500 },
    { mode: "percentage", value: 30 },
  ]) {
    const response = await request("/api/provider-health/email/warning-settings", "owner", {
      method: "PATCH",
      body: JSON.stringify(settings),
    });
    assert.equal(response.status, 200, await response.text());
  }

  const originalHistoryResponse = await request(
    "/api/provider-health/email/warning-settings/history?limit=100",
    "owner",
  );
  assert.equal(
    originalHistoryResponse.status,
    200,
    await originalHistoryResponse.clone().text(),
  );
  const originalHistory = (await originalHistoryResponse.json() as any).items;
  assert.equal(originalHistory.length, 3);

  const firstResponse = await request(
    "/api/provider-health/email/warning-settings/history?limit=2",
    "owner",
  );
  assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
  const firstPage = await firstResponse.json() as any;
  assert.deepEqual(
    firstPage.items.map((item: any) => item.id),
    originalHistory.slice(0, 2).map((item: any) => item.id),
  );
  assert.equal(typeof firstPage.nextCursor, "string");

  const newChangeResponse = await request(
    "/api/provider-health/email/warning-settings",
    "owner",
    {
      method: "PATCH",
      body: JSON.stringify({ mode: "remainingCredits", value: 250 }),
    },
  );
  assert.equal(newChangeResponse.status, 200, await newChangeResponse.text());

  const secondResponse = await request(
    `/api/provider-health/email/warning-settings/history?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    "owner",
  );
  assert.equal(secondResponse.status, 200, await secondResponse.clone().text());
  const secondPage = await secondResponse.json() as any;

  assert.deepEqual(
    secondPage.items.map((item: any) => item.id),
    originalHistory.slice(2).map((item: any) => item.id),
  );
  assert.equal(secondPage.nextCursor, null);
  assert.deepEqual(
    [...firstPage.items, ...secondPage.items].map((item: any) => item.id),
    originalHistory.map((item: any) => item.id),
  );
});

test("warning history rejects invalid pagination input", async () => {
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=not-a-number",
    "cursor=not-a-cursor",
    "fromDate=not-a-date",
    "toDate=2026-02-30T00:00:00.000Z",
    "fromDate=2026-09-21T04:00:00.000Z",
    "toDate=2026-09-22T04:00:00.000Z",
    "fromDate=2026-09-22T04:00:00.000Z&toDate=2026-09-21T04:00:00.000Z",
  ]) {
    const response = await request(
      `/api/provider-health/email/warning-settings/history?${query}`,
      "owner",
    );
    assert.equal(response.status, 400, `${query}: ${await response.text()}`);
  }
});

test("owners can filter a non-UTC local date around midnight while paging", async () => {
  await pool.query("DELETE FROM email_capacity_settings_audit WHERE actor_user_id = $1", [ownerId]);
  await pool.query(
    `INSERT INTO email_capacity_settings_audit (
       actor_user_id, actor_email, previous_mode, previous_value, new_mode, new_value, changed_at
     ) VALUES
       ($1, $2, 'default', NULL, 'percentage', 20, '2026-07-02T03:30:00Z'),
       ($1, $2, 'percentage', 20, 'percentage', 30, '2026-07-02T04:30:00Z'),
       ($1, $2, 'percentage', 30, 'remainingCredits', 500, '2026-07-03T03:30:00Z'),
       ($1, $2, 'remainingCredits', 500, 'default', NULL, '2026-07-03T04:30:00Z')`,
    [ownerId, ownerEmail],
  );

  const firstResponse = await request(
    "/api/provider-health/email/warning-settings/history?limit=1&fromDate=2026-07-02T04%3A00%3A00.000Z&toDate=2026-07-03T04%3A00%3A00.000Z",
    "owner",
  );
  assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
  const firstPage = await firstResponse.json() as any;
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.items[0].changedAt, "2026-07-03T03:30:00.000Z");
  assert.equal(typeof firstPage.nextCursor, "string");

  const secondResponse = await request(
    `/api/provider-health/email/warning-settings/history?limit=1&fromDate=2026-07-02T04%3A00%3A00.000Z&toDate=2026-07-03T04%3A00%3A00.000Z&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    "owner",
  );
  assert.equal(secondResponse.status, 200, await secondResponse.clone().text());
  const secondPage = await secondResponse.json() as any;
  assert.equal(secondPage.items.length, 1);
  assert.equal(secondPage.items[0].changedAt, "2026-07-02T04:30:00.000Z");
  assert.equal(secondPage.nextCursor, null);
});

test("CSV export uses the inclusive local dates, stable history order, and all pages", async () => {
  await pool.query("DELETE FROM email_capacity_settings_audit WHERE actor_user_id = $1", [ownerId]);
  await pool.query(
    `INSERT INTO email_capacity_settings_audit (
      actor_user_id, actor_email, previous_mode, previous_value, new_mode, new_value, changed_at
    )
    SELECT $1, $2, 'default', NULL, 'percentage', 20,
      '2035-07-02T04:00:00Z'::timestamptz + n * interval '1 minute'
    FROM generate_series(0, 104) AS n`,
    [ownerId, ownerEmail],
  );
  await pool.query(
    `INSERT INTO email_capacity_settings_audit (
      actor_user_id, actor_email, previous_mode, previous_value, new_mode, new_value, changed_at
    ) VALUES
      ($1, '=HYPERLINK("test")', 'default', NULL, 'remainingCredits', 500, '2035-07-03T03:59:59Z'),
      ($1, $2, 'default', NULL, 'percentage', 50, '2035-07-03T04:00:00Z'),
      ($1, $2, 'default', NULL, 'percentage', 60, '2035-07-02T03:59:59Z')`,
    [ownerId, ownerEmail],
  );
  const dates = "fromDate=2035-07-02T04%3A00%3A00.000Z&toDate=2035-07-03T04%3A00%3A00.000Z";
  const response = await request(`/api/provider-health/email/warning-settings/history/export?${dates}`, "owner");
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get("content-type") ?? "", /^text\/csv/);
  assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/);
  const csv = await response.text();
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines.length, 107); // header + 105 minute changes + the last second of the day
  assert.equal(lines[0], '"Change time (UTC)","Owner ID","Owner email","Previous setting","New setting"');
  assert.match(lines[1], /^"2035-07-03T03:59:59.000Z"/);
  assert.ok(lines[1].includes(`"'=HYPERLINK(""test"")"`));
  assert.match(lines.at(-1) ?? "", /^"2035-07-02T04:00:00.000Z"/);
  assert.equal(csv.includes("2035-07-03T04:00:00.000Z"), false);
  assert.equal(csv.includes("2035-07-02T03:59:59.000Z"), false);
  assert.equal(csv.includes("provider_unavailable"), false);
  const pageResponse = await request(`/api/provider-health/email/warning-settings/history?limit=100&${dates}`, "owner");
  const page = await pageResponse.json() as any;
  assert.deepEqual(lines.slice(1, 101).map((line) => line.slice(1, 25)),
    page.items.map((item: any) => item.changedAt));
});

test("CSV export rejects invalid dates without downloading an audit file", async () => {
  for (const query of [
    "fromDate=2035-07-02T04%3A00%3A00Z",
    "fromDate=2035-07-03T04%3A00%3A00Z&toDate=2035-07-02T04%3A00%3A00Z",
    "fromDate=2035-02-30T04%3A00%3A00Z&toDate=2035-03-03T04%3A00%3A00Z",
  ]) {
    const response = await request(`/api/provider-health/email/warning-settings/history/export?${query}`, "owner");
    assert.equal(response.status, 400, await response.text());
    assert.equal(response.headers.get("content-type")?.startsWith("text/csv"), false);
  }
});