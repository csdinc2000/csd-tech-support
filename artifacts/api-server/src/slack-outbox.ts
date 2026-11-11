import type { ChatPostMessageArguments } from "@slack/web-api";
import { pool } from "./db";
import { logger } from "./lib/logger";
import type { SlackDeliveryResult } from "./slack";
import { recordSlackQueueOutcome, type SlackQueueFailureCategory } from "./slack-delivery-health";

const MAX_ATTEMPTS = 8;
const POLL_MS = 15_000;
const BATCH_SIZE = 20;
const RETRY_DELAYS_MS = [15_000, 60_000, 300_000, 900_000, 3_600_000];
const MAX_PAYLOAD_BYTES = 64 * 1024;

class OversizedSlackPayloadError extends Error {}

export type SlackNotificationType = "ticket" | "intake" | "call" | "device_alert" | "emergency" | "automation" | "meeting";
export type SlackNotification = {
  dedupeKey: string;
  type: SlackNotificationType;
  payload: ChatPostMessageArguments;
  emergencyAlertId?: number;
};

type OutboxRow = {
  id: number;
  notification_type: SlackNotificationType;
  payload: ChatPostMessageArguments;
  emergency_alert_id: number | null;
  attempt_count: number;
};

type OutboxStore = {
  enqueue(notification: SlackNotification): Promise<void>;
  claim(limit: number, maxAttempts: number): Promise<OutboxRow[]>;
  delivered(row: OutboxRow): Promise<void>;
  failed(row: OutboxRow, result: Extract<SlackDeliveryResult, { delivered: false }>, terminal: boolean, retryDelayMs: number): Promise<void>;
  listFailures(): Promise<SlackTerminalFailure[]>;
  retry(id: number, actorId: string): Promise<SlackRetryResult | null>;
};

export type SlackTerminalFailure = {
  id: number;
  type: SlackNotificationType;
  failedAt: string;
  category: "not_configured" | "http_error" | "slack_error" | "transport_error" | "timeout";
  retryId: number | null;
  retryRequestedAt: string | null;
};

export type SlackRetryResult = { retryId: number; retryRequestedAt: string };

const databaseStore: OutboxStore = {
  async enqueue(notification) {
    const serialized = JSON.stringify(notification.payload);
    if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
      throw new OversizedSlackPayloadError();
    }
    await pool.query(
      `INSERT INTO slack_notification_outbox
         (dedupe_key, notification_type, payload, emergency_alert_id)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        notification.dedupeKey,
        notification.type,
        serialized,
        notification.emergencyAlertId ?? null,
      ],
    );
  },

  async claim(limit, maxAttempts) {
    await pool.query(
      `UPDATE slack_notification_outbox
       SET status = 'failed', payload = NULL,
           last_error_category = COALESCE(last_error_category, 'timeout'),
           updated_at = now()
       WHERE status = 'processing'
         AND attempt_count >= $1
         AND updated_at < now() - interval '2 minutes'`,
      [maxAttempts],
    );
    const result = await pool.query<OutboxRow>(
      `WITH ready AS (
         SELECT id
         FROM slack_notification_outbox
         WHERE (
             (status IN ('pending', 'retry') AND next_attempt_at <= now())
             OR (status = 'processing' AND updated_at < now() - interval '2 minutes')
           )
           AND attempt_count < $2
         ORDER BY next_attempt_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE slack_notification_outbox item
       SET status = 'processing',
           attempt_count = item.attempt_count + 1,
           updated_at = now()
       FROM ready
       WHERE item.id = ready.id
       RETURNING item.id, item.notification_type, item.payload,
                 item.emergency_alert_id, item.attempt_count`,
      [limit, maxAttempts],
    );
    return result.rows;
  },

  async delivered(row) {
    await pool.query(
      `UPDATE slack_notification_outbox
       SET status = 'delivered', payload = NULL, last_error_category = NULL, updated_at = now()
       WHERE id = $1`,
      [row.id],
    );
    if (row.emergency_alert_id != null) {
      await recordEmergencyAttempt(row, "sent", null);
    }
  },

  async failed(row, result, terminal, retryDelayMs) {
    await pool.query(
      `UPDATE slack_notification_outbox
       SET status = $2,
           payload = CASE WHEN $2 = 'failed' THEN NULL ELSE payload END,
           last_error_category = $3,
           next_attempt_at = now() + ($4 * interval '1 millisecond'),
           updated_at = now()
       WHERE id = $1`,
      [row.id, terminal ? "failed" : "retry", result.reason, retryDelayMs],
    );
    if (row.emergency_alert_id != null) {
      await recordEmergencyAttempt(row, "failed", `Slack delivery failed (${result.reason})`);
    }
  },
  async listFailures() {
    const result = await pool.query<{
      id: string; notification_type: SlackNotificationType; updated_at: Date;
      last_error_category: SlackTerminalFailure["category"];
      retry_id: string | null; retry_requested_at: Date | null;
    }>(
      `SELECT original.id, original.notification_type, original.updated_at,
              original.last_error_category, retry.id AS retry_id, retry.retry_requested_at
       FROM slack_notification_outbox original
       LEFT JOIN slack_notification_outbox retry ON retry.retry_of_id = original.id
       WHERE original.status = 'failed'
       ORDER BY original.updated_at DESC, original.id DESC
       LIMIT 50`,
    );
    return result.rows.map((row) => ({
      id: Number(row.id), type: row.notification_type,
      failedAt: row.updated_at.toISOString(), category: row.last_error_category,
      retryId: row.retry_id == null ? null : Number(row.retry_id),
      retryRequestedAt: row.retry_requested_at?.toISOString() ?? null,
    }));
  },
  async retry(id, actorId) {
    // The original content is intentionally erased. A retry sends only a
    // metadata recovery notice, never reconstructs private message content.
    await pool.query(
      `INSERT INTO slack_notification_outbox
         (dedupe_key, notification_type, payload, retry_of_id, retry_requested_by, retry_requested_at)
       SELECT 'manual-retry-' || id, notification_type,
              jsonb_build_object(
                'channel', 'configured-channel',
                'text', 'Slack notification delivery recovery: ' || notification_type || ' event failed at ' ||
                        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') ||
                        '. Original message content is unavailable.'
              ),
              id, $2, now()
       FROM slack_notification_outbox
       WHERE id = $1 AND status = 'failed'
       ON CONFLICT DO NOTHING`,
      [id, actorId],
    );
    const result = await pool.query<{ id: string; retry_requested_at: Date }>(
      `SELECT retry.id, retry.retry_requested_at
       FROM slack_notification_outbox original
       JOIN slack_notification_outbox retry ON retry.retry_of_id = original.id
       WHERE original.id = $1 AND original.status = 'failed'`,
      [id],
    );
    const row = result.rows[0];
    return row ? { retryId: Number(row.id), retryRequestedAt: row.retry_requested_at.toISOString() } : null;
  },
};

async function recordEmergencyAttempt(
  row: OutboxRow,
  status: "sent" | "failed",
  errorMessage: string | null,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO emergency_alert_log
         (alert_id, contact_id, notification_method, status, attempt_number, error_message)
       VALUES ($1, NULL, 'slack', $2, $3, $4)`,
      [row.emergency_alert_id, status, row.attempt_count, errorMessage],
    );
  } catch {
    logger.warn({ outboxId: row.id }, "Could not record sanitized Slack emergency attempt");
  }
}

let store: OutboxStore = databaseStore;
let workerTimer: NodeJS.Timeout | undefined;
let processing = false;

export function __setSlackNotificationOutboxStoreForTests(override: OutboxStore | null): void {
  store = override ?? databaseStore;
}

export async function enqueueSlackNotification(notification: SlackNotification): Promise<void> {
  try {
    await store.enqueue(notification);
  } catch (error) {
    const category: SlackQueueFailureCategory =
      error instanceof OversizedSlackPayloadError ? "payload_too_large" : "queue_write_failed";
    await recordSlackQueueOutcome(false, category, new Date());
    throw error;
  }
  // A duplicate key is already durably present and counts as a successful enqueue.
  await recordSlackQueueOutcome(true, null, new Date());
}

export async function listSlackTerminalFailures(): Promise<SlackTerminalFailure[]> {
  return store.listFailures();
}

export async function retrySlackTerminalFailure(id: number, actorId: string): Promise<SlackRetryResult | null> {
  return store.retry(id, actorId);
}

export async function processSlackNotificationOutbox(
  deliver: (payload: ChatPostMessageArguments) => Promise<SlackDeliveryResult>,
): Promise<number> {
  if (processing) return 0;
  processing = true;
  let processed = 0;
  try {
    const rows = await store.claim(BATCH_SIZE, MAX_ATTEMPTS);
    await Promise.all(rows.map(async (row) => {
      let result: SlackDeliveryResult;
      try {
        result = await deliver(row.payload);
      } catch {
        // Connector exceptions can contain message bodies; persist only the
        // stable failure category and never log the thrown value.
        result = { delivered: false, reason: "transport_error" };
      }
      if (result.delivered) {
        await store.delivered(row);
      } else {
        const terminal = row.attempt_count >= MAX_ATTEMPTS;
        const delay = RETRY_DELAYS_MS[Math.min(row.attempt_count - 1, RETRY_DELAYS_MS.length - 1)];
        await store.failed(row, result, terminal, delay);
      }
      processed++;
    }));
  } catch {
    logger.warn("Slack notification outbox worker failed");
  } finally {
    processing = false;
  }
  return processed;
}

export function startSlackNotificationOutboxWorker(
  deliver: (payload: ChatPostMessageArguments) => Promise<SlackDeliveryResult>,
): void {
  if (workerTimer) return;
  const run = () => {
    void processSlackNotificationOutbox(deliver);
  };
  run();
  workerTimer = setInterval(run, POLL_MS);
  workerTimer.unref?.();
}