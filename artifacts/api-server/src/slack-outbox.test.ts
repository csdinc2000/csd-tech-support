import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { ChatPostMessageArguments } from "@slack/web-api";
import {
  __setSlackNotificationOutboxStoreForTests,
  enqueueSlackNotification,
  processSlackNotificationOutbox,
} from "./slack-outbox";
import { queueTicketNotification, queueIncomingCallNotification, queueAutomationNotification } from "./slack";
import { __setSlackQueueHealthStoreForTests, getSlackDeliveryHealth, __setSlackDeliveryHealthStoreForTests } from "./slack-delivery-health";
import { logger } from "./lib/logger";

const rows = new Map<string, any>();
let nextId = 1;
const queueOutcomes: Array<{ queued: boolean; category: string | null; at: Date }> = [];

beforeEach(() => {
  __setSlackQueueHealthStoreForTests({
    async record(queued, category, at) {
      queueOutcomes.push({ queued, category, at });
    },
    async get() {
      const latest = queueOutcomes.at(-1);
      if (!latest) return { state: "not_checked", lastAttemptAt: null, lastSuccessAt: null, activeFailure: null };
      const lastSuccess = [...queueOutcomes].reverse().find((outcome) => outcome.queued);
      return {
        state: latest.queued ? "healthy" : "failing",
        lastAttemptAt: latest.at.toISOString(),
        lastSuccessAt: lastSuccess?.at.toISOString() ?? null,
        activeFailure: latest.queued ? null : {
          category: latest.category as "queue_write_failed" | "payload_too_large",
          startedAt: queueOutcomes.find((outcome) => !outcome.queued)!.at.toISOString(),
          lastFailedAt: latest.at.toISOString(),
        },
      };
    },
  });
});

const memoryStore = {
  async enqueue(notification: any) {
    if (rows.has(notification.dedupeKey)) return;
    rows.set(notification.dedupeKey, {
      id: nextId++,
      dedupe_key: notification.dedupeKey,
      notification_type: notification.type,
      payload: notification.payload,
      emergency_alert_id: notification.emergencyAlertId ?? null,
      status: "pending",
      attempt_count: 0,
      last_error_category: null,
    });
  },
  async claim(limit: number, maxAttempts: number) {
    return [...rows.values()]
      .filter((row) => ["pending", "retry"].includes(row.status) && row.attempt_count < maxAttempts)
      .slice(0, limit)
      .map((row) => {
        row.status = "processing";
        row.attempt_count += 1;
        return row;
      });
  },
  async delivered(row: any) {
    row.status = "delivered";
    row.payload = null;
    row.last_error_category = null;
  },
  async failed(row: any, result: { reason: string }, terminal: boolean) {
    row.status = terminal ? "failed" : "retry";
    row.last_error_category = result.reason;
    if (terminal) row.payload = null;
  },
  async listFailures() {
    return [];
  },
  async retry(_id: number, _actorId: string) {
    return null;
  },
};

afterEach(() => {
  queueOutcomes.length = 0;
  __setSlackQueueHealthStoreForTests(null);
  __setSlackDeliveryHealthStoreForTests(null);
  rows.clear();
  nextId = 1;
  __setSlackNotificationOutboxStoreForTests(null);
});

test("outbox write failures warn owners without content, and a later enqueue clears only queue health", async () => {
  const privateText = "private ticket subject and contact";
  const logged: unknown[][] = [];
  const originalWarn = logger.warn;
  logger.warn = ((...args: unknown[]) => { logged.push(args); }) as typeof logger.warn;
  __setSlackNotificationOutboxStoreForTests({
    ...memoryStore,
    async enqueue() { throw new Error(`database failed: ${privateText}`); },
  });
  __setSlackDeliveryHealthStoreForTests({
    async record() {},
    async get() {
      return {
        state: "failing", lastAttemptAt: "2026-01-01T00:00:00.000Z",
        lastSuccessAt: null,
        activeFailure: {
          category: "slack_error", startedAt: "2026-01-01T00:00:00.000Z",
          lastFailedAt: "2026-01-01T00:00:00.000Z",
        },
      };
    },
  });
  try {
    await assert.doesNotReject(queueTicketNotification({
      id: 42, priority: "high", subject: privateText, status: "open",
    }, { name: "Private customer" }));
    const failing = await getSlackDeliveryHealth();
    assert.equal(failing.queue.activeFailure?.category, "queue_write_failed");
    assert.equal(failing.activeFailure?.category, "slack_error");
    assert.doesNotMatch(JSON.stringify({ failing, logged, queueOutcomes }), /private ticket|Private customer|database failed/);

    __setSlackNotificationOutboxStoreForTests(memoryStore);
    await queueTicketNotification({ id: 43, priority: "high", subject: "another", status: "open" }, { name: "Customer" });
    const recovered = await getSlackDeliveryHealth();
    assert.equal(recovered.queue.state, "healthy");
    assert.equal(recovered.queue.activeFailure, null);
    assert.equal(recovered.activeFailure?.category, "slack_error");
  } finally {
    logger.warn = originalWarn;
  }
});

test("queue warning survives a temporary health-write outage and is recorded after recovery", async () => {
  let healthWriteAvailable = false;
  const persisted: Array<{ queued: boolean; category: string | null; at: Date }> = [];
  __setSlackQueueHealthStoreForTests({
    async record(queued, category, at) {
      if (!healthWriteAvailable) throw new Error("private notification content from database");
      persisted.push({ queued, category, at });
    },
    async get() {
      const latest = persisted.at(-1);
      return latest
        ? {
          state: latest.queued ? "healthy" : "failing",
          lastAttemptAt: latest.at.toISOString(), lastSuccessAt: null,
          activeFailure: latest.queued ? null : {
            category: "queue_write_failed", startedAt: latest.at.toISOString(), lastFailedAt: latest.at.toISOString(),
          },
        }
        : { state: "not_checked", lastAttemptAt: null, lastSuccessAt: null, activeFailure: null };
    },
  });
  __setSlackDeliveryHealthStoreForTests({
    async record() {},
    async get() { return { state: "not_checked", lastAttemptAt: null, lastSuccessAt: null, activeFailure: null }; },
  });
  __setSlackNotificationOutboxStoreForTests({
    ...memoryStore,
    async enqueue() { throw new Error("private notification content from outbox"); },
  });
  const originalError = logger.error;
  const logged: unknown[][] = [];
  logger.error = ((...args: unknown[]) => { logged.push(args); }) as typeof logger.error;
  try {
    await queueTicketNotification({ id: 44, priority: "high", subject: "private subject", status: "open" }, {});
    assert.equal((await getSlackDeliveryHealth()).queue.activeFailure?.category, "queue_write_failed");
    assert.doesNotMatch(JSON.stringify(logged), /private notification|private subject/);
    healthWriteAvailable = true;
    assert.equal((await getSlackDeliveryHealth()).queue.activeFailure?.category, "queue_write_failed");
    assert.equal(persisted.length, 1);
    __setSlackNotificationOutboxStoreForTests(memoryStore);
    await queueTicketNotification({ id: 45, priority: "high", subject: "next", status: "open" }, {});
    assert.equal((await getSlackDeliveryHealth()).queue.state, "healthy");
  } finally {
    logger.error = originalError;
  }
});

test("oversized notification records a fixed queue category, not its message", async () => {
  const privateText = "private-call-content".repeat(5_000);
  await assert.doesNotReject(queueIncomingCallNotification({ from: privateText, eventId: "call-oversized" }));
  assert.equal(queueOutcomes.at(-1)?.category, "payload_too_large");
  assert.doesNotMatch(JSON.stringify(queueOutcomes), /private-call-content/);
});

test("queued CRM notifications remain available until a background worker delivers them", async () => {
  __setSlackNotificationOutboxStoreForTests(memoryStore);

  await queueTicketNotification(
    { id: 42, priority: "high", subject: "Saved ticket", status: "open" },
    { name: "Customer" },
  );
  const queued = rows.get("ticket-42");
  assert.equal(queued.status, "pending");
  assert.equal(queued.notification_type, "ticket");
  assert.match(queued.payload.text, /Saved ticket/);

  // The persisted store survives the absence of a worker and is consumed when
  // a fresh worker starts, matching restart recovery behavior.
  let deliveredPayload: ChatPostMessageArguments | undefined;
  assert.equal(await processSlackNotificationOutbox(async (payload) => {
    deliveredPayload = payload;
    return { delivered: true };
  }), 1);
  assert.match(JSON.stringify(deliveredPayload), /Saved ticket/);
  assert.equal(queued.status, "delivered");
  assert.equal(queued.payload, null);
});

test("delivery exceptions persist only a stable failure category and eventually clear the payload", async () => {
  __setSlackNotificationOutboxStoreForTests(memoryStore);
  await queueIncomingCallNotification({
    from: "555-0100",
    to: "555-0199",
    missed: true,
    eventId: "call-event-1",
  });

  const row = rows.get("call-call-event-1-missed");
  const logged: unknown[][] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => logged.push(args);
  console.warn = (...args: unknown[]) => logged.push(args);
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      await processSlackNotificationOutbox(async () => {
        throw new Error("connector leaked private call payload");
      });
    }
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }

  assert.equal(row.status, "failed");
  assert.equal(row.attempt_count, 8);
  assert.equal(row.last_error_category, "transport_error");
  assert.equal(row.payload, null);
  assert.doesNotMatch(JSON.stringify(logged), /private call payload|555-0100/);
});

test("duplicate event keys are queued only once", async () => {
  __setSlackNotificationOutboxStoreForTests(memoryStore);
  await enqueueSlackNotification({
    type: "ticket",
    dedupeKey: "ticket-duplicate",
    payload: { channel: "C_TEST", text: "first" },
  });
  await enqueueSlackNotification({
    type: "ticket",
    dedupeKey: "ticket-duplicate",
    payload: { channel: "C_TEST", text: "second" },
  });

  assert.equal(rows.size, 1);
  assert.equal(rows.get("ticket-duplicate").payload.text, "first");
});

test("patch and script notices survive a worker restart and deliver once", async () => {
  __setSlackNotificationOutboxStoreForTests(memoryStore);

  await queueAutomationNotification(
    "patch-install-204",
    { name: "Patch Installation", type: "patch-install" },
    "success",
    "Queued 2 patch(es) on 1 device(s)",
  );
  await queueAutomationNotification(
    "automation-execution-invocation-1",
    { name: "Check disk", type: "shell" },
    "failure",
    "Device 42: failed",
  );
  await queueAutomationNotification(
    "patch-install-204",
    { name: "Patch Installation", type: "patch-install" },
    "success",
    "Duplicate request",
  );
  assert.equal(rows.size, 2);
  assert.equal(rows.get("patch-install-204").status, "pending");
  assert.match(rows.get("patch-install-204").payload.text, /Patch Installation/);
  assert.doesNotMatch(JSON.stringify(rows.get("patch-install-204").payload), /Duplicate request/);

  // A new worker instance sees the same persisted rows, not process-local jobs.
  __setSlackNotificationOutboxStoreForTests(null);
  __setSlackNotificationOutboxStoreForTests(memoryStore);
  const delivered: string[] = [];
  assert.equal(await processSlackNotificationOutbox(async (payload) => {
    delivered.push(JSON.stringify(payload));
    return { delivered: true };
  }), 2);
  assert.match(delivered.join(" "), /Check disk/);
  assert.equal(rows.get("patch-install-204").status, "delivered");
  assert.equal(rows.get("automation-execution-invocation-1").payload, null);
  assert.equal(await processSlackNotificationOutbox(async () => {
    throw new Error("already delivered");
  }), 0);
});

test("automation notices retry after delivery failure without losing the saved payload", async () => {
  __setSlackNotificationOutboxStoreForTests(memoryStore);
  await queueAutomationNotification(
    "automation-execution-invocation-2",
    { name: "Check disk", type: "shell" },
    "success",
    "Device 42: completed",
  );
  const row = rows.get("automation-execution-invocation-2");
  assert.equal(await processSlackNotificationOutbox(async () => ({
    delivered: false, reason: "transport_error",
  })), 1);
  assert.equal(row.status, "retry");
  assert.match(row.payload.text, /Check disk/);

  __setSlackNotificationOutboxStoreForTests(null);
  __setSlackNotificationOutboxStoreForTests(memoryStore);
  assert.equal(await processSlackNotificationOutbox(async () => ({ delivered: true })), 1);
  assert.equal(row.attempt_count, 2);
  assert.equal(row.status, "delivered");
  assert.equal(row.payload, null);
});