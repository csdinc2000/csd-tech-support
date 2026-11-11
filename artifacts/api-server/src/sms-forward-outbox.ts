import { db } from "./db";
import { sendSms, toE164 } from "./twilio";
import { smsForwardDeliveries } from "@workspace/db";
import { sql } from "drizzle-orm";
import { APPROVED_RECIPIENT } from "./staff-dispatch";

const MAX_ATTEMPTS = 5;
let workerTimer: NodeJS.Timeout | null = null;
let processing = false;

export function parseSmsForwardTargets(
  configured: string | null | undefined,
  legacyTarget?: string | null,
): string[] {
  const raw = configured == null ? [legacyTarget || ""] : configured.split(",");
  return [...new Set(
    raw
      .map((value) => value.trim())
      .filter(Boolean)
      .map(toE164)
      .filter((value) => /^\+\d{8,15}$/.test(value)),
  )].slice(0, 5);
}

export async function enqueueSmsForwardBroadcast(input: {
  inboundMessageSid: string;
  sourceNumber: string;
  businessNumber: string;
  body: string;
  targets: string[];
}): Promise<void> {
  if (!input.inboundMessageSid || input.targets.length === 0) return;
  await db
    .insert(smsForwardDeliveries)
    .values(input.targets.map((targetNumber) => ({
      inboundMessageSid: input.inboundMessageSid,
      targetNumber,
      sourceNumber: input.sourceNumber,
      businessNumber: input.businessNumber,
      body: input.body,
      status: "pending",
      nextAttemptAt: new Date(),
    })))
    .onConflictDoNothing({
      target: [
        smsForwardDeliveries.inboundMessageSid,
        smsForwardDeliveries.targetNumber,
      ],
    });
  void processSmsForwardDeliveries();
}

async function claimDeliveries() {
  const result: any = await db.execute(sql`
    WITH ready AS (
      SELECT id
      FROM sms_forward_deliveries
      WHERE (
          (status IN ('pending', 'retry') AND next_attempt_at <= NOW())
          OR (status = 'sending' AND updated_at < NOW() - INTERVAL '2 minutes')
        )
        AND attempts < ${MAX_ATTEMPTS}
      ORDER BY next_attempt_at, id
      LIMIT 25
      FOR UPDATE SKIP LOCKED
    )
    UPDATE sms_forward_deliveries delivery
    SET status = 'sending',
        attempts = delivery.attempts + 1,
        updated_at = NOW()
    FROM ready
    WHERE delivery.id = ready.id
    RETURNING delivery.*
  `);
  return result?.rows ?? result ?? [];
}

async function dispatchDelivery(delivery: any): Promise<void> {
  try {
    if (String(delivery.inbound_message_sid).startsWith("staff:")) {
      // Approval or message preferences may change after an event was queued.
      const eligible: any = await db.execute(sql`
        SELECT r.id FROM staff_dispatch_recipients r
        WHERE r.phone=${delivery.target_number} AND r.enabled=TRUE AND r.receive_messages=TRUE
          AND ${sql.raw(APPROVED_RECIPIENT)}
          AND NOT EXISTS (
            SELECT 1 FROM staff_dispatch_sms_consent c WHERE c.phone=r.phone AND c.consented=FALSE
          ) LIMIT 1
      `);
      if (!eligible.rows.length) {
        await db.execute(sql`
          UPDATE sms_forward_deliveries SET status='canceled',
            last_error='Staff recipient is no longer approved or enabled for text notifications', updated_at=NOW()
          WHERE id=${Number(delivery.id)}
        `);
        return;
      }
    }
    const message = await sendSms(delivery.target_number, delivery.body, {
      proxyDeliveryId: Number(delivery.id),
      proxyDeliveryKind: "sms-forward",
    });
    await db.execute(sql`
      UPDATE sms_forward_deliveries
      SET status = CASE
            WHEN status IN ('delivered', 'failed', 'undelivered') THEN status
            ELSE ${message.status || "queued"}
          END,
          provider_message_sid = COALESCE(provider_message_sid, ${message.sid}),
          last_error = NULL,
          updated_at = NOW()
      WHERE id = ${Number(delivery.id)}
    `);
  } catch (error: any) {
    const attempts = Number(delivery.attempts || 1);
    const terminal = attempts >= MAX_ATTEMPTS;
    const delaySeconds = [15, 60, 300, 900, 3600][Math.min(attempts - 1, 4)];
    const message = String(error?.message || error || "SMS forwarding failed").slice(0, 1000);
    await db.execute(sql`
      UPDATE sms_forward_deliveries
      SET status = ${terminal ? "failed" : "retry"},
          last_error = ${message},
          next_attempt_at = NOW() + (${delaySeconds} || ' seconds')::interval,
          updated_at = NOW()
      WHERE id = ${Number(delivery.id)}
    `);
    console.error(
      `[sms-forward] target=${delivery.target_number} attempt=${attempts} ${terminal ? "FAILED" : "retry scheduled"}:`,
      message,
    );
  }
}

export async function processSmsForwardDeliveries(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    const deliveries = await claimDeliveries();
    await Promise.allSettled(deliveries.map(dispatchDelivery));
  } catch (error) {
    console.error("[sms-forward] outbox worker failed:", error);
  } finally {
    processing = false;
  }
}

export function startSmsForwardOutboxWorker(): void {
  if (workerTimer) return;
  void processSmsForwardDeliveries();
  workerTimer = setInterval(() => void processSmsForwardDeliveries(), 15_000);
  workerTimer.unref?.();
}