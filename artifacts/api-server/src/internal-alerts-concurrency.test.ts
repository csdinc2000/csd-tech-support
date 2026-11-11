import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { alerts } from "@workspace/db";
import { db, pool } from "./db";
import {
  createSharedRateLimitCleanupHealthReporter,
  SHARED_RATE_LIMIT_CLEANUP_FAILURE_THRESHOLD,
} from "./internal-alerts";
import { DatabaseStorage } from "./storage";

const source = `shared-rate-limit-cleanup-test-${process.pid}-${Date.now()}`;
const testSources = [
  source,
  `${source}-recovery-first`,
  `${source}-failure-first`,
  `${source}-out-of-order-failures`,
];

after(async () => {
  await db.delete(alerts).where(inArray(alerts.alertSource, testSources));
  await pool.end();
});

test("separate cleanup workers merge simultaneous sustained failures into one sanitized incident", async () => {
  const workerA = createSharedRateLimitCleanupHealthReporter(
    new DatabaseStorage(),
    source,
  );
  const workerB = createSharedRateLimitCleanupHealthReporter(
    new DatabaseStorage(),
    source,
  );

  await Promise.all([
    ...Array.from(
      { length: SHARED_RATE_LIMIT_CLEANUP_FAILURE_THRESHOLD },
      () => workerA.recordFailure(),
    ),
    ...Array.from(
      { length: SHARED_RATE_LIMIT_CLEANUP_FAILURE_THRESHOLD },
      () => workerB.recordFailure(),
    ),
  ]);

  const incidents = await db
    .select()
    .from(alerts)
    .where(eq(alerts.alertSource, source));
  const active = incidents.filter((incident) => incident.status === "active");

  assert.equal(active.length, 1);
  assert.equal(active[0].severity, "warning");
  assert.equal(active[0].category, "system");
  assert.equal(active[0].businessImpact, "warning");
  assert.equal(active[0].isEmergency, false);
  assert.deepEqual(JSON.parse(active[0].affectedServices || "[]"), []);

  const serialized = JSON.stringify(active[0]);
  assert.doesNotMatch(
    serialized,
    /rate_key|shared_rate_limits|DELETE FROM|postgres(?:ql)?:|password|credential/i,
  );
  assert.match(
    active[0].description || "",
    /No request-limit keys, database errors, or database details are stored/,
  );

  await workerB.recordSuccess();

  const recovered = await db
    .select()
    .from(alerts)
    .where(eq(alerts.alertSource, source));
  assert.equal(
    recovered.filter((incident) => incident.status === "active").length,
    0,
  );
  assert.ok(recovered[0].resolvedAt instanceof Date);
});

for (const databaseOrder of ["recovery-first", "failure-first"] as const) {
  test(`a stale cleanup recovery cannot hide a sustained failure when the database applies ${databaseOrder}`, async () => {
    const raceSource = `${source}-${databaseOrder}`;
    const recoveryObservedAt = new Date("2026-09-21T12:00:00.000Z");
    const failureObservedAt = new Date("2026-09-21T12:00:01.000Z");
    const recoveryStorage = new DatabaseStorage();
    const failureStorage = new DatabaseStorage();
    let releaseFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const recoveryReporter = createSharedRateLimitCleanupHealthReporter(
      {
        upsertActiveAlertBySource:
          recoveryStorage.upsertActiveAlertBySource.bind(recoveryStorage),
        async resolveActiveAlertsBySource(...args) {
          if (databaseOrder === "failure-first") await firstFinished;
          await recoveryStorage.resolveActiveAlertsBySource(...args);
          if (databaseOrder === "recovery-first") releaseFirst();
        },
      },
      raceSource,
      () => recoveryObservedAt,
    );
    const failureReporter = createSharedRateLimitCleanupHealthReporter(
      {
        async upsertActiveAlertBySource(...args) {
          if (databaseOrder === "recovery-first") await firstFinished;
          const incident =
            await failureStorage.upsertActiveAlertBySource(...args);
          if (databaseOrder === "failure-first") releaseFirst();
          return incident;
        },
        resolveActiveAlertsBySource:
          failureStorage.resolveActiveAlertsBySource.bind(failureStorage),
      },
      raceSource,
      () => failureObservedAt,
    );

    for (
      let attempt = 1;
      attempt < SHARED_RATE_LIMIT_CLEANUP_FAILURE_THRESHOLD;
      attempt++
    ) {
      await failureReporter.recordFailure();
    }

    await Promise.all([
      recoveryReporter.recordSuccess(),
      failureReporter.recordFailure(),
    ]);

    const incidents = await db
      .select()
      .from(alerts)
      .where(eq(alerts.alertSource, raceSource));
    const active = incidents.filter((incident) => incident.status === "active");

    assert.equal(active.length, 1);
    assert.equal(active[0].createdAt?.getTime(), failureObservedAt.getTime());
    assert.deepEqual(JSON.parse(active[0].affectedServices || "[]"), []);
    assert.doesNotMatch(
      JSON.stringify(active[0]),
      /rate_key|shared_rate_limits|DELETE FROM|postgres(?:ql)?:|password|credential/i,
    );
  });
}

test("a delayed older failure cannot make an intermediate recovery hide a newer failure", async () => {
  const raceSource = `${source}-out-of-order-failures`;
  const olderFailureObservedAt = new Date("2026-09-21T12:00:01.000Z");
  const recoveryObservedAt = new Date("2026-09-21T12:00:02.000Z");
  const newerFailureObservedAt = new Date("2026-09-21T12:00:03.000Z");
  const newerStorage = new DatabaseStorage();
  const olderStorage = new DatabaseStorage();
  const recoveryStorage = new DatabaseStorage();
  let releaseNewer!: () => void;
  let releaseOlder!: () => void;
  const newerFinished = new Promise<void>((resolve) => {
    releaseNewer = resolve;
  });
  const olderFinished = new Promise<void>((resolve) => {
    releaseOlder = resolve;
  });

  const newerReporter = createSharedRateLimitCleanupHealthReporter(
    {
      async upsertActiveAlertBySource(...args) {
        const incident = await newerStorage.upsertActiveAlertBySource(...args);
        releaseNewer();
        return incident;
      },
      resolveActiveAlertsBySource:
        newerStorage.resolveActiveAlertsBySource.bind(newerStorage),
    },
    raceSource,
    () => newerFailureObservedAt,
  );
  const olderReporter = createSharedRateLimitCleanupHealthReporter(
    {
      async upsertActiveAlertBySource(...args) {
        await newerFinished;
        const incident = await olderStorage.upsertActiveAlertBySource(...args);
        releaseOlder();
        return incident;
      },
      resolveActiveAlertsBySource:
        olderStorage.resolveActiveAlertsBySource.bind(olderStorage),
    },
    raceSource,
    () => olderFailureObservedAt,
  );
  const recoveryReporter = createSharedRateLimitCleanupHealthReporter(
    {
      upsertActiveAlertBySource:
        recoveryStorage.upsertActiveAlertBySource.bind(recoveryStorage),
      async resolveActiveAlertsBySource(...args) {
        await olderFinished;
        await recoveryStorage.resolveActiveAlertsBySource(...args);
      },
    },
    raceSource,
    () => recoveryObservedAt,
  );

  for (
    let attempt = 1;
    attempt < SHARED_RATE_LIMIT_CLEANUP_FAILURE_THRESHOLD;
    attempt++
  ) {
    await Promise.all([
      newerReporter.recordFailure(),
      olderReporter.recordFailure(),
    ]);
  }

  await Promise.all([
    newerReporter.recordFailure(),
    olderReporter.recordFailure(),
    recoveryReporter.recordSuccess(),
  ]);

  const incidents = await db
    .select()
    .from(alerts)
    .where(eq(alerts.alertSource, raceSource));
  const active = incidents.filter((incident) => incident.status === "active");

  assert.equal(active.length, 1);
  assert.equal(active[0].createdAt?.getTime(), newerFailureObservedAt.getTime());
  assert.deepEqual(JSON.parse(active[0].affectedServices || "[]"), []);
  assert.doesNotMatch(
    JSON.stringify(active[0]),
    /rate_key|shared_rate_limits|DELETE FROM|postgres(?:ql)?:|password|credential/i,
  );
});
