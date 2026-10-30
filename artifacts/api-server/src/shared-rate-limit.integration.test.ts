import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { pool } from "./db";
import { applySharedRateLimitsMigration } from "./migrations/2026-09-16-shared-rate-limits";
import { cleanupExpiredSharedRateLimits, sharedRateLimit } from "./security";

const rateKey = `shared-rate-limit-test:${process.pid}:${Date.now()}`;
const cleanupIsolationKey = `${rateKey}:cleanup-isolation`;
const cleanupRetryKey = `${rateKey}:cleanup-retry`;
const cleanupKeyPrefix = `${rateKey}:cleanup:`;
const servers: Server[] = [];
const baseUrls: string[] = [];

before(async () => {
  await applySharedRateLimitsMigration();
  for (let index = 0; index < 2; index++) {
    const app = express();
    app.post(
      "/limited",
      sharedRateLimit({ windowMs: 60_000, max: 3, key: () => rateKey }),
      (_req, res) => res.json({ ok: true }),
    );
    app.post(
      "/cleanup-isolation",
      sharedRateLimit({ windowMs: 60_000, max: 1, key: () => cleanupIsolationKey }),
      (_req, res) => res.json({ ok: true }),
    );
    app.post(
      "/cleanup-retry",
      sharedRateLimit({ windowMs: 60_000, max: 1, key: () => cleanupRetryKey }),
      (_req, res) => res.json({ ok: true }),
    );
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    servers.push(server);
    baseUrls.push(`http://127.0.0.1:${address.port}`);
  }
});

after(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await pool.query(
    "DELETE FROM shared_rate_limits WHERE rate_key = ANY($1::text[]) OR rate_key LIKE $2",
    [[rateKey, cleanupIsolationKey, cleanupRetryKey], `${cleanupKeyPrefix}%`],
  );
});

test("slow or failed cleanup does not delay or fail a limited request", async () => {
  const originalQuery = pool.query.bind(pool);
  let rejectCleanup!: (error: Error) => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    (pool as any).query = (text: unknown, values?: unknown[]) => {
      if (
        typeof text === "string" &&
        text.includes("DELETE FROM shared_rate_limits") &&
        text.includes("FOR UPDATE SKIP LOCKED")
      ) {
        resolve();
        return new Promise((_resolve, reject) => {
          rejectCleanup = reject;
        });
      }
      return originalQuery(text as string, values);
    };
  });

  try {
    const request = fetch(`${baseUrls[0]}/cleanup-isolation`, { method: "POST" });
    await cleanupStarted;
    let timeout: NodeJS.Timeout | undefined;
    const response = await Promise.race([
      request,
      new Promise<never>((_resolve, reject) =>
        {
          timeout = setTimeout(
            () => reject(new Error("Request waited for rate-limit cleanup")),
            500,
          );
        },
      ),
    ]);
    if (timeout) clearTimeout(timeout);
    assert.equal(response.status, 200);

    rejectCleanup(new Error("expected cleanup failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    (pool as any).query = originalQuery;
  }
});

test("cleanup is scheduled again after a failed run and the cleanup interval", async () => {
  const originalQuery = pool.query.bind(pool);
  const originalDateNow = Date.now;
  let now = originalDateNow() + 120_000;
  let cleanupAttempts = 0;
  const cleanupCompletions: Array<{
    resolve: (value: { rowCount: number }) => void;
    reject: (error: Error) => void;
  }> = [];

  Date.now = () => now;
  (pool as any).query = (text: unknown, values?: unknown[]) => {
    if (
      typeof text === "string" &&
      text.includes("DELETE FROM shared_rate_limits") &&
      text.includes("FOR UPDATE SKIP LOCKED")
    ) {
      cleanupAttempts++;
      return new Promise<{ rowCount: number }>((resolve, reject) => {
        cleanupCompletions.push({ resolve, reject });
      });
    }
    return originalQuery(text as string, values);
  };

  try {
    const firstResponse = await fetch(`${baseUrls[0]}/cleanup-retry`, { method: "POST" });
    assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
    assert.deepEqual(await firstResponse.json(), { ok: true });
    assert.equal(cleanupAttempts, 1);

    cleanupCompletions[0].reject(new Error("expected cleanup failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    now += 60_000;
    const secondResponse = await fetch(`${baseUrls[1]}/cleanup-retry`, { method: "POST" });
    assert.equal(secondResponse.status, 429, await secondResponse.clone().text());
    assert.equal(cleanupAttempts, 2);

    cleanupCompletions[1].resolve({ rowCount: 0 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(await secondResponse.json(), {
      message: "Too many requests, please try again later.",
    });
  } finally {
    Date.now = originalDateNow;
    for (const completion of cleanupCompletions) {
      completion.resolve({ rowCount: 0 });
    }
    (pool as any).query = originalQuery;
  }
});

test("shared limiter combines allowances across API instances", async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${baseUrls[attempt % 2]}/limited`, { method: "POST" });
    assert.equal(response.status, 200, await response.text());
  }

  const limited = await fetch(`${baseUrls[1]}/limited`, { method: "POST" });
  assert.equal(limited.status, 429, await limited.clone().text());
  const retryAfter = Number(limited.headers.get("retry-after"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 60);
});

test("cleanup removes only expired rows in bounded concurrent batches", async () => {
  while (await cleanupExpiredSharedRateLimits()) {
    // Keep the assertion independent of expired records left by other tests.
  }
  const expiredKeys = Array.from(
    { length: 5 },
    (_, index) => `${cleanupKeyPrefix}expired:${index}`,
  );
  const activeKey = `${cleanupKeyPrefix}active`;
  await pool.query(
    `INSERT INTO shared_rate_limits (rate_key, hit_count, reset_at)
     SELECT key, 1, NOW() - INTERVAL '1 minute'
     FROM unnest($1::text[]) AS key
     UNION ALL
     SELECT $2, 1, NOW() + INTERVAL '1 minute'`,
    [expiredKeys, activeKey],
  );

  const deleted = await Promise.all([
    cleanupExpiredSharedRateLimits(2),
    cleanupExpiredSharedRateLimits(2),
  ]);
  assert.ok(deleted.every((count) => count <= 2));

  const remaining = await pool.query<{ rate_key: string }>(
    `SELECT rate_key
     FROM shared_rate_limits
     WHERE rate_key = ANY($1::text[]) OR rate_key = $2`,
    [expiredKeys, activeKey],
  );
  const remainingKeys = new Set(remaining.rows.map((row) => row.rate_key));
  assert.equal(remainingKeys.has(activeKey), true);
  assert.equal(
    expiredKeys.filter((key) => remainingKeys.has(key)).length,
    1,
  );
});