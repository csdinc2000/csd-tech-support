import { pool } from "./db";
import { sendEmail } from "./helpdesk-email";
import { logger } from "./lib/logger";
import {
  invoiceEmailDeliveryError,
  renderInvoiceEmail,
  retryDelayMs,
  type InvoiceEmailKind,
  type InvoiceEmailPayload,
} from "./invoice-email-core";

const MAX_ATTEMPTS = 8;
const POLL_MS = 30_000;
let workerTimer: ReturnType<typeof setInterval> | undefined;
let processing = false;

export async function enqueueInvoiceEmail(
  client: { query: (sql: string, params?: unknown[]) => Promise<any> },
  input: {
    invoiceId: number;
    kind: InvoiceEmailKind;
    recipientEmail: string;
    payload: InvoiceEmailPayload;
    scheduledAt?: Date;
    idempotencyKey: string;
  },
) {
  const result = await client.query(
    `INSERT INTO invoice_email_outbox
       (invoice_id, kind, recipient_email, payload, scheduled_at, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
     RETURNING *`,
    [
      input.invoiceId, input.kind, input.recipientEmail, JSON.stringify(input.payload),
      input.scheduledAt || new Date(), input.idempotencyKey,
    ],
  );
  return result.rows[0];
}

export async function processInvoiceEmailOutbox(): Promise<number> {
  if (processing) return 0;
  processing = true;
  let processed = 0;
  try {
    while (processed < 20) {
      const client = await pool.connect();
      let item: any;
      try {
        await client.query("BEGIN");
        item = (await client.query(
          `SELECT o.*, i.status AS invoice_status
           FROM invoice_email_outbox o JOIN invoices i ON i.id=o.invoice_id
           WHERE o.status IN ('pending','failed') AND o.scheduled_at <= now()
             AND o.next_attempt_at <= now() AND o.attempt_count < $1
           ORDER BY o.scheduled_at, o.id FOR UPDATE OF o, i SKIP LOCKED LIMIT 1`,
          [MAX_ATTEMPTS],
        )).rows[0];
        if (!item) {
          await client.query("COMMIT");
          break;
        }
        if (item.invoice_status !== "sent") {
          await client.query(
            "UPDATE invoice_email_outbox SET status='cancelled', last_error=$2, updated_at=now() WHERE id=$1",
            [item.id, `Invoice is ${item.invoice_status}`],
          );
          await client.query("COMMIT");
          processed++;
          continue;
        }
        await client.query(
          "UPDATE invoice_email_outbox SET status='processing', attempt_count=attempt_count+1, updated_at=now() WHERE id=$1",
          [item.id],
        );
        const attempt = await client.query(
          `INSERT INTO invoice_email_delivery_attempts (outbox_id, invoice_id, attempt_number, status)
           SELECT $1,$2,COALESCE(MAX(attempt_number),0)+1,'sending'
           FROM invoice_email_delivery_attempts WHERE outbox_id=$1
           RETURNING id, attempt_number`,
          [item.id, item.invoice_id],
        );
        const attemptNumber = Number(item.attempt_count) + 1;
        const content = renderInvoiceEmail(item.kind, item.payload as InvoiceEmailPayload);
        const result = await sendEmail(item.recipient_email, content.subject, content.text, {
          html: content.html,
          operation: item.kind === "reminder" ? "invoice reminder" : "invoice",
          customArgs: {
            invoiceId: String(item.invoice_id),
            outboxId: String(item.id),
            attempt: String(attempt.rows[0].attempt_number),
          },
        });
        await client.query(
          "UPDATE invoice_email_delivery_attempts SET status='accepted', provider_message_id=$2, completed_at=now() WHERE id=$1",
          [attempt.rows[0].id, result.messageId],
        );
        await client.query(
          "UPDATE invoice_email_outbox SET status='accepted', accepted_at=now(), last_error=NULL, updated_at=now() WHERE id=$1",
          [item.id],
        );
        await client.query("COMMIT");
      } catch (error: any) {
        await client.query("ROLLBACK");
        const message = invoiceEmailDeliveryError(error);
        if (item) {
          try {
            await client.query("BEGIN");
            const invoice = (await client.query("SELECT status FROM invoices WHERE id=$1 FOR UPDATE", [item.invoice_id])).rows[0];
            if (invoice?.status === "sent") {
              const consecutiveAttempt = Number(item.attempt_count) + 1;
              const failed = await client.query(
                `UPDATE invoice_email_outbox
                 SET status='failed', attempt_count=$2, last_error=$3, next_attempt_at=$4, updated_at=now()
                 WHERE id=$1 AND status IN ('pending','failed') RETURNING id`,
                [item.id, consecutiveAttempt, message, new Date(Date.now() + retryDelayMs(consecutiveAttempt))],
              );
              if (failed.rows[0]) {
                await client.query(
                  `INSERT INTO invoice_email_delivery_attempts
                     (outbox_id,invoice_id,attempt_number,status,error,completed_at)
                   SELECT $1,$2,COALESCE(MAX(attempt_number),0)+1,'failed',$3,now()
                   FROM invoice_email_delivery_attempts WHERE outbox_id=$1`,
                  [item.id, item.invoice_id, message],
                );
              }
            }
            await client.query("COMMIT");
          } catch (recordError) {
            await client.query("ROLLBACK");
            logger.error({ error: recordError, outboxId: item.id }, "Invoice email failure could not be recorded");
          }
        }
        logger.warn({ error, outboxId: item?.id, invoiceId: item?.invoice_id }, "Invoice email delivery failed");
      } finally {
        client.release();
      }
      processed++;
    }
  } finally {
    processing = false;
  }
  return processed;
}

export function startInvoiceEmailOutboxWorker(): void {
  if (workerTimer) return;
  void processInvoiceEmailOutbox().catch((error) => logger.error({ error }, "Invoice email outbox run failed"));
  workerTimer = setInterval(() => {
    void processInvoiceEmailOutbox().catch((error) => logger.error({ error }, "Invoice email outbox run failed"));
  }, POLL_MS);
  workerTimer.unref();
}