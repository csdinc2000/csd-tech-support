import { pool } from "./db";
import { logger } from "./lib/logger";
import type { SlackDeliveryResult } from "./slack";

export type SlackFailureCategory = Exclude<SlackDeliveryResult, { delivered: true }>["reason"];
export type SlackQueueFailureCategory = "queue_write_failed" | "payload_too_large";

export type SlackQueueHealth = {
  state: "not_checked" | "healthy" | "failing";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  activeFailure: {
    category: SlackQueueFailureCategory;
    startedAt: string;
    lastFailedAt: string;
  } | null;
};

export type SlackDeliveryHealth = {
  state: "not_checked" | "healthy" | "failing";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  activeFailure: {
    category: SlackFailureCategory;
    startedAt: string;
    lastFailedAt: string;
  } | null;
  queue: SlackQueueHealth;
};

type HealthStore = {
  record(result: SlackDeliveryResult): Promise<void>;
  get(): Promise<Omit<SlackDeliveryHealth, "queue">>;
};

type QueueHealthStore = {
  record(queued: boolean, category: SlackQueueFailureCategory | null, at: Date): Promise<void>;
  get(): Promise<SlackQueueHealth>;
};

const queueDatabaseStore: QueueHealthStore = {
  async record(queued, category, at) {
    await pool.query(
      `INSERT INTO slack_queue_outcomes (queued, failure_category, attempted_at)
       VALUES ($1, $2, $3)`,
      [queued, category, at],
    );
  },
  async get() {
    const result = await pool.query<{
      queued: boolean;
      failure_category: SlackQueueFailureCategory | null;
      attempted_at: Date;
    }>(`
      SELECT queued, failure_category, attempted_at
      FROM slack_queue_outcomes
      ORDER BY attempted_at DESC, id DESC
      LIMIT 500
    `);
    const latest = result.rows[0];
    if (!latest) {
      return { state: "not_checked", lastAttemptAt: null, lastSuccessAt: null, activeFailure: null };
    }
    const lastSuccess = result.rows.find((row) => row.queued);
    if (latest.queued) {
      return {
        state: "healthy", lastAttemptAt: latest.attempted_at.toISOString(),
        lastSuccessAt: latest.attempted_at.toISOString(), activeFailure: null,
      };
    }
    const failures = result.rows.filter((row) => !row.queued);
    return {
      state: "failing",
      lastAttemptAt: latest.attempted_at.toISOString(),
      lastSuccessAt: lastSuccess?.attempted_at.toISOString() ?? null,
      activeFailure: {
        category: latest.failure_category!,
        startedAt: failures[failures.length - 1]!.attempted_at.toISOString(),
        lastFailedAt: latest.attempted_at.toISOString(),
      },
    };
  },
};

const databaseStore: HealthStore = {
  async record(result) {
    await pool.query(
      `INSERT INTO slack_delivery_outcomes (delivered, failure_category)
       VALUES ($1, $2)`,
      [result.delivered, result.delivered ? null : result.reason],
    );
  },
  async get() {
    const result = await pool.query<{
      delivered: boolean;
      failure_category: SlackFailureCategory | null;
      attempted_at: Date;
    }>(`
      SELECT delivered, failure_category, attempted_at
      FROM slack_delivery_outcomes
      ORDER BY attempted_at DESC, id DESC
      LIMIT 500
    `);
    const latest = result.rows[0];
    if (!latest) {
      return { state: "not_checked", lastAttemptAt: null, lastSuccessAt: null, activeFailure: null };
    }
    const lastSuccess = result.rows.find((row) => row.delivered);
    if (latest.delivered) {
      return {
        state: "healthy",
        lastAttemptAt: latest.attempted_at.toISOString(),
        lastSuccessAt: latest.attempted_at.toISOString(),
        activeFailure: null,
      };
    }
    const unresolvedFailures = result.rows.filter((row) => !row.delivered);
    const oldestFailure = unresolvedFailures[unresolvedFailures.length - 1]!;
    return {
      state: "failing",
      lastAttemptAt: latest.attempted_at.toISOString(),
      lastSuccessAt: lastSuccess?.attempted_at.toISOString() ?? null,
      activeFailure: {
        category: latest.failure_category!,
        startedAt: oldestFailure.attempted_at.toISOString(),
        lastFailedAt: latest.attempted_at.toISOString(),
      },
    };
  },
};

let store: HealthStore = databaseStore;
let queueStore: QueueHealthStore = queueDatabaseStore;
// If the outbox database is unavailable, its health table may be unavailable
// too. Keep only the latest sanitized outcome until a database write recovers.
let pendingQueueOutcome: { queued: boolean; category: SlackQueueFailureCategory | null; at: Date } | null = null;
let flushInProgress: Promise<void> | null = null;

async function flushPendingQueueOutcome(): Promise<void> {
  if (flushInProgress) return flushInProgress;
  const pending = pendingQueueOutcome;
  if (!pending) return;
  flushInProgress = (async () => {
    try {
      await queueStore.record(pending.queued, pending.category, pending.at);
      if (pendingQueueOutcome === pending) pendingQueueOutcome = null;
    } catch {
      // Keep the sanitized outcome for the next attempt. Never log raw errors.
    }
  })();
  try {
    await flushInProgress;
  } finally {
    flushInProgress = null;
  }
}

export function __setSlackQueueHealthStoreForTests(override: QueueHealthStore | null): void {
  queueStore = override ?? queueDatabaseStore;
  pendingQueueOutcome = null;
}

export function __setSlackDeliveryHealthStoreForTests(override: HealthStore | null): void {
  store = override ?? databaseStore;
}

export async function recordSlackDeliveryOutcome(result: SlackDeliveryResult): Promise<void> {
  try {
    await store.record(result);
  } catch {
    logger.error("Failed to record sanitized Slack delivery health outcome");
  }
}

export async function recordSlackQueueOutcome(
  queued: boolean,
  category: SlackQueueFailureCategory | null,
  at: Date,
): Promise<void> {
  await flushPendingQueueOutcome();
  try {
    await queueStore.record(queued, category, at);
  } catch {
    // An outbox/database outage can also prevent the health write. Never log
    // the exception: it may contain the notification payload or query values.
    logger.error("Failed to record sanitized Slack queue health outcome");
    if (!pendingQueueOutcome || at >= pendingQueueOutcome.at) {
      pendingQueueOutcome = { queued, category, at };
    }
  }
}

export async function getSlackDeliveryHealth(): Promise<SlackDeliveryHealth> {
  await flushPendingQueueOutcome();
  const [delivery, queue] = await Promise.all([store.get(), queueStore.get()]);
  const pending = pendingQueueOutcome;
  if (pending && (!queue.lastAttemptAt || pending.at.getTime() > Date.parse(queue.lastAttemptAt))) {
    const at = pending.at.toISOString();
    return {
      ...delivery,
      queue: pending.queued
        ? { state: "healthy", lastAttemptAt: at, lastSuccessAt: at, activeFailure: null }
        : {
          state: "failing", lastAttemptAt: at, lastSuccessAt: queue.lastSuccessAt,
          activeFailure: {
            category: pending.category!, startedAt: queue.activeFailure?.startedAt ?? at,
            lastFailedAt: at,
          },
        },
    };
  }
  return { ...delivery, queue };
}