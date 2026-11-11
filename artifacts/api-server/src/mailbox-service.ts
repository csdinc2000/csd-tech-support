import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { pool } from "./db";
import { handleInboundHelpdeskEmail } from "./routes/helpdesk";
import { logger } from "./lib/logger";
import { getAppState, setAppState } from "./app-state";

const POLL_MS = 60_000;
// New mail handled per poll; the rest waits for the next minute.
const MAX_MESSAGES_PER_POLL = 25;
// On first start (or a mailbox reset) only unread mail from the last few days
// is imported, so years of old mail don't become tickets.
const BACKFILL_DAYS = Number(process.env.CSD_MAIL_BACKFILL_DAYS || 2);
const MAILBOX_LOCK_KEY = 7_418_203;
let workerTimer: ReturnType<typeof setInterval> | undefined;
let processing = false;

function mailboxSettings() {
  // The mailbox stays on its own host even when outbound SMTP is pointed at
  // a relay. IMAP reads its own vars first, falling back to the shared ones.
  const host = (process.env.CSD_IMAP_HOST || process.env.CSD_MAIL_HOST)?.trim();
  const user = (process.env.CSD_IMAP_USER || process.env.CSD_MAIL_USER)?.trim();
  const password = process.env.CSD_IMAP_PASSWORD || process.env.CSD_MAIL_PASSWORD;
  if (!host || !user || !password) return null;
  const port = Number(process.env.CSD_IMAP_PORT || process.env.CSD_MAIL_IMAP_PORT || 993);
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

/**
 * Automated mail that must not open tickets: bounces, auto-replies, bulk/list
 * mail and our own messages. Ticket autoresponders would otherwise reply to
 * them and loop.
 */
export function automatedMailReason(input: {
  fromEmail: string;
  mailboxUser: string;
  headers: Map<string, unknown> | { get(name: string): unknown };
}): string | null {
  const from = input.fromEmail.trim().toLowerCase();
  const header = (name: string) => String(input.headers.get(name) ?? "").toLowerCase();
  if (from && from === input.mailboxUser.trim().toLowerCase()) return "sent from the support mailbox itself";
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)([+@]|$)/.test(from)) return "automated sender";
  const autoSubmitted = header("auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no") return "auto-submitted";
  if (/^(bulk|list|junk|auto_reply)$/.test(header("precedence"))) return "bulk or auto-reply";
  if (header("x-autoreply") || header("x-autorespond") || header("list-unsubscribe") || header("list-id")) return "auto-reply or mailing list";
  return null;
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
  const skipReason = automatedMailReason({ fromEmail: sender.email, mailboxUser: settings.user, headers: parsed.headers });

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

  if (skipReason) {
    await pool.query(
      "UPDATE mailbox_received_messages SET status='skipped', error=$2, processed_at=now(), updated_at=now() WHERE id=$1",
      [row.id, `Not turned into a ticket: ${skipReason}`],
    );
    return;
  }

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

type MailboxCursor = { uidValidity: string; lastUid: number };

function cursorKey(settings: NonNullable<ReturnType<typeof mailboxSettings>>): string {
  return `mailbox-cursor:${settings.host}:${settings.user}:${settings.mailbox}`.toLowerCase();
}

/**
 * UIDs to handle this poll. New mail is tracked by UID (not the \Seen flag),
 * so a message staff already opened in webmail is still picked up, and old
 * unread mail is never bulk-imported.
 */
async function pendingUids(
  imap: ImapFlow,
  settings: NonNullable<ReturnType<typeof mailboxSettings>>,
): Promise<{ uids: number[]; cursor: MailboxCursor }> {
  const box = imap.mailbox;
  if (!box) throw new Error("Mailbox is not open");
  const uidValidity = String(box.uidValidity);
  const stored = await getAppState<MailboxCursor>(cursorKey(settings));
  if (stored && stored.uidValidity === uidValidity) {
    const found = (await imap.search({ uid: `${stored.lastUid + 1}:*` }, { uid: true })) || [];
    // "N:*" always matches the newest message, even when it is older than N.
    const uids = found.filter((uid) => uid > stored.lastUid).sort((a, b) => a - b);
    return { uids, cursor: stored };
  }
  // First run or the server reset UIDs: start at the current end of the
  // mailbox and import only recent unread mail.
  const since = new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60_000);
  const recentUnread = BACKFILL_DAYS > 0
    ? ((await imap.search({ seen: false, since }, { uid: true })) || [])
    : [];
  const cursor: MailboxCursor = { uidValidity, lastUid: Math.max(0, Number(box.uidNext) - 1) };
  await setAppState(cursorKey(settings), cursor);
  logger.info({ mailbox: settings.mailbox, backfill: recentUnread.length }, "Inbound mailbox cursor initialised");
  // Backfilled UIDs are all below the cursor, so handling them never moves it.
  return { uids: recentUnread.sort((a, b) => a - b), cursor };
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
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      tls: { rejectUnauthorized: true, servername: settings.host },
    });
    // ImapFlow emits asynchronous socket errors as EventEmitter events. Without
    // a listener, a transient provider timeout can terminate the whole API
    // process instead of failing this poll and allowing the next retry.
    imap.on("error", () => {
      logger.warn("Inbound mailbox connection error; the worker will retry.");
    });
    await imap.connect();
    const mailboxLock = await imap.getMailboxLock(settings.mailbox);
    try {
      const { uids, cursor } = await pendingUids(imap, settings);
      const key = cursorKey(settings);
      // One message at a time: running other IMAP commands inside a fetch()
      // iterator deadlocks ImapFlow, which stalled this worker before.
      for (const uid of uids.slice(0, MAX_MESSAGES_PER_POLL)) {
        try {
          const message = await imap.fetchOne(String(uid), { source: true }, { uid: true });
          if (message && message.source) {
            await processMailboxMessage(settings, uid, message.source as Buffer);
            await imap.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
            processed++;
          }
        } catch (error) {
          // Recorded as failed in mailbox_received_messages; move on so one
          // bad message can't block the mailbox.
          logger.warn({ err: error, mailbox: settings.mailbox, uid }, "Inbound mailbox message failed");
        }
        if (uid > cursor.lastUid) {
          cursor.lastUid = uid;
          await setAppState(key, cursor);
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

// Development and production share the real support mailbox but not a
// database, so both polling it would import every email twice (and send two
// autoresponders). Only production polls unless CSD_MAIL_WORKER=on.
export function mailboxWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.CSD_MAIL_WORKER || "").trim().toLowerCase();
  if (flag === "on" || flag === "true" || flag === "1") return true;
  if (flag === "off" || flag === "false" || flag === "0") return false;
  return env.NODE_ENV === "production";
}

export function startMailboxWorker(): void {
  if (!mailboxWorkerEnabled()) {
    logger.info("Mailbox IMAP worker off outside production (set CSD_MAIL_WORKER=on to enable)");
    return;
  }
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