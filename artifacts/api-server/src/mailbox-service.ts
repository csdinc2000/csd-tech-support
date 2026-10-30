import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { pool } from "./db";
import { handleInboundHelpdeskEmail } from "./routes/helpdesk";
import { logger } from "./lib/logger";

const POLL_MS = 60_000;
const MAILBOX_LOCK_KEY = 7_418_203;
let workerTimer: ReturnType<typeof setInterval> | undefined;
let processing = false;

function mailboxSettings() {
  const host = process.env.CSD_MAIL_HOST?.trim();
  const user = process.env.CSD_MAIL_USER?.trim();
  const password = process.env.CSD_MAIL_PASSWORD;
  if (!host || !user || !password) return null;
  const port = Number(process.env.CSD_MAIL_IMAP_PORT || 993);
  return {
    host,
    user,
    password,
    port: Number.isInteger(port) && port > 0 ? port : 993,
    mailbox: process.env.CSD_MAIL_INBOX?.trim() || "INBOX",
  };
}

export function isMailboxConfigured(): boolean {
  return mailboxSettings() !== null;
}

export async function ensureMailboxSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mailbox_received_messages (
      id bigserial PRIMARY KEY,
      dedupe_key text NOT NULL UNIQUE,
      mailbox text NOT NULL,
      uid bigint,
      message_id text,
      from_email text NOT NULL,
      subject text NOT NULL,
      received_at timestamptz,
      ticket_id integer REFERENCES tickets(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'processing',
      error text,
      processed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS mailbox_received_messages_status_idx
      ON mailbox_received_messages(status, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS mailbox_received_messages_message_id_idx
      ON mailbox_received_messages(message_id)
      WHERE message_id IS NOT NULL;
  `);
}

function parsedFrom(parsed: ParsedMail): { email: string; name: string } {
  const address = parsed.from?.value?.[0];
  return {
    email: address?.address || parsed.from?.text || "",
    name: address?.name || "",
  };
}

function parsedText(parsed: ParsedMail): string {
  return parsed.text?.trim() || (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");
}

async function processMailboxMessage(
  settings: NonNullable<ReturnType<typeof mailboxSettings>>,
  uid: number,
  source: Buffer,
): Promise<void> {
  const parsed = await simpleParser(source);
  const sender = parsedFrom(parsed);
  const body = parsedText(parsed);
  const subject = parsed.subject?.trim() || "(no subject)";
  if (!sender.email || !body) throw new Error("Inbound email did not contain a sender and body");

  const messageId = parsed.messageId?.trim() || null;
  const dedupeKey = messageId ? `message:${messageId}` : `uid:${settings.mailbox}:${uid}`;
  const existing = (await pool.query(
    "SELECT id, status FROM mailbox_received_messages WHERE dedupe_key=$1 OR ($2::text IS NOT NULL AND message_id=$2) LIMIT 1",
    [dedupeKey, messageId],
  )).rows[0];
  if (existing?.status === "processed") return;

  const row = existing
    ? (await pool.query(
      `UPDATE mailbox_received_messages
       SET status='processing', error=NULL, updated_at=now()
       WHERE id=$1
       RETURNING id`,
      [existing.id],
    )).rows[0]
    : (await pool.query(
      `INSERT INTO mailbox_received_messages
         (dedupe_key, mailbox, uid, message_id, from_email, subject, received_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'processing')
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [dedupeKey, settings.mailbox, uid, messageId, sender.email, subject, parsed.date || new Date()],
    )).rows[0];
  if (!row) return;

  try {
    const result = await handleInboundHelpdeskEmail({
      from: sender.email,
      fromName: sender.name,
      subject,
      body,
      inReplyTo: parsed.inReplyTo || "",
    });
    await pool.query(
      `UPDATE mailbox_received_messages
       SET status='processed', ticket_id=$2, processed_at=now(), updated_at=now()
       WHERE id=$1`,
      [row.id, result.ticketId],
    );
  } catch (error: any) {
    await pool.query(
      "UPDATE mailbox_received_messages SET status='failed', error=$2, updated_at=now() WHERE id=$1",
      [row.id, String(error?.message || "Inbound email processing failed").slice(0, 2000)],
    );
    throw error;
  }
}

async function pollMailbox(): Promise<number> {
  const settings = mailboxSettings();
  if (!settings || processing) return 0;
  processing = true;
  const lockClient = await pool.connect();
  let imap: ImapFlow | undefined;
  let processed = 0;
  try {
    const lock = (await lockClient.query("SELECT pg_try_advisory_lock($1) AS locked", [MAILBOX_LOCK_KEY])).rows[0]?.locked;
    if (!lock) return 0;
    imap = new ImapFlow({
      host: settings.host,
      port: settings.port,
      secure: true,
      auth: { user: settings.user, pass: settings.password },
      logger: false,
    });
    await imap.connect();
    const mailboxLock = await imap.getMailboxLock(settings.mailbox);
    try {
      for await (const message of imap.fetch({ seen: false }, { uid: true, source: true })) {
        try {
          await processMailboxMessage(settings, message.uid, message.source as Buffer);
          await imap.messageFlagsAdd(message.uid, ["\\Seen"]);
          processed++;
        } catch (error) {
          logger.warn({ error, mailbox: settings.mailbox, uid: message.uid }, "Inbound mailbox message failed");
        }
      }
    } finally {
      mailboxLock.release();
    }
    await imap.logout();
    return processed;
  } finally {
    if (imap) {
      try { await imap.close(); } catch {}
    }
    try { await lockClient.query("SELECT pg_advisory_unlock($1)", [MAILBOX_LOCK_KEY]); } catch {}
    lockClient.release();
    processing = false;
  }
}

export function startMailboxWorker(): void {
  if (workerTimer || !isMailboxConfigured()) {
    if (!isMailboxConfigured()) logger.info("Mailbox IMAP worker disabled: mailbox credentials are not configured");
    return;
  }
  void pollMailbox().catch((error) => logger.error({ error }, "Mailbox poll failed"));
  workerTimer = setInterval(() => {
    void pollMailbox().catch((error) => logger.error({ error }, "Mailbox poll failed"));
  }, POLL_MS);
  workerTimer.unref();
}