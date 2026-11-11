import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  __setInternalAlertStorageForTests,
  recordSharedRateLimitCleanupFailure,
  recordSharedRateLimitCleanupSuccess,
  SHARED_RATE_LIMIT_CLEANUP_ALERT_SOURCE,
  SHARED_RATE_LIMIT_CLEANUP_FAILURE_THRESHOLD,
} from "./internal-alerts";

type RecordedAlert = {
  source: string;
  alert: Record<string, unknown>;
};

function fakeStorage() {
  const upserts: RecordedAlert[] = [];
  const resolutions: string[] = [];
  return {
    upserts,
    resolutions,
    storage: {
      async upsertActiveAlertBySource(
        source: string,
        alert: Record<string, unknown>,
      ) {
        upserts.push({ source, alert });
        return alert as never;
      },
      async resolveActiveAlertsBySource(source: string) {
        resolutions.push(source);
      },
    },
  };
}

afterEach(() => {
  __setInternalAlertStorageForTests(null);
});

test("sustained cleanup failures update one sanitized incident source", async () => {
  const fake = fakeStorage();
  __setInternalAlertStorageForTests(fake.storage as never);

  for (
    let attempt = 1;
    attempt < SHARED_RATE_LIMIT_CLEANUP_FAILURE_THRESHOLD;
    attempt++
  ) {
    await recordSharedRateLimitCleanupFailure();
  }
  assert.equal(fake.upserts.length, 0);

  await recordSharedRateLimitCleanupFailure();
  await recordSharedRateLimitCleanupFailure();

  assert.equal(fake.upserts.length, 2);
  assert.ok(
    fake.upserts.every(
      ({ source }) => source === SHARED_RATE_LIMIT_CLEANUP_ALERT_SOURCE,
    ),
  );
  const serialized = JSON.stringify(fake.upserts);
  assert.doesNotMatch(serialized, /rate_key|shared_rate_limits|DELETE FROM/i);
  assert.match(serialized, /No request-limit keys, database errors, or database details/);
});

test("a successful cleanup resolves the incident and resets the failure streak", async () => {
  const fake = fakeStorage();
  __setInternalAlertStorageForTests(fake.storage as never);

  for (let attempt = 0; attempt < SHARED_RATE_LIMIT_CLEANUP_FAILURE_THRESHOLD; attempt++) {
    await recordSharedRateLimitCleanupFailure();
  }
  await recordSharedRateLimitCleanupSuccess();

  assert.deepEqual(fake.resolutions, [SHARED_RATE_LIMIT_CLEANUP_ALERT_SOURCE]);

  await recordSharedRateLimitCleanupFailure();
  assert.equal(fake.upserts.length, 1);
});