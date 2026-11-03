// Shared SMS inbox for the single CSD business line.
//
// Every customer gets one conversation (keyed by phone digits, same grouping
// as the Messages thread list). The team sees who owns it, whether it's open
// or done, what they haven't read, who sent each reply, team-only notes, and
// the customer's calls and voicemails on the same timeline.
//
// Customers only ever see the main number: replies from the web inbox and
// replies relayed from a technician's own cell ("#12 on my way") both go out
// through sendSms() on the business line.
import type { Express, Request } from "express";
import { pool } from "./db";
import { toValidE164 } from "./phone-validation";
import { getTwilioSettings } from "./twilio-settings-storage";
import { enqueueSmsForwardBroadcast, parseSmsForwardTargets } from "./sms-forward-outbox";
import { configuredForwardTargets } from "./voice-routing";

export type SentBy = { userId: string | null; name: string };
// Always the business-line sender (twilio.ts sendSms); who sent it is stamped afterwards.
export type InboxSendSms = (
  to: string,
  body: string,
) => Promise<{ sid: string; from?: string | null; to?: string; status?: string }>;

// A forwarded text may only be answered by a phone that received it recently.
const RELAY_WINDOW_DAYS = 14;
const NOTE_MAX_LENGTH = 2000;
const SMS_MAX_LENGTH = 1600;

/** "+1 (954) 555-0101" and "9545550101" both → "9545550101". */
export function threadKeyFor(phone: string | null | undefined): string {
  const digits = (phone || "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/** SQL twin of threadKeyFor for a column name we control (never user input). */
function threadKeySql(column: string): string {
  const digits = `regexp_replace(COALESCE(${column}, ''), '\\D', '', 'g')`;
  return `(CASE WHEN length(${digits}) = 11 AND left(${digits}, 1) = '1' THEN substring(${digits} FROM 2) ELSE ${digits} END)`;
}

export function formatPhoneDisplay(phone: string | null | undefined): string {
  const key = threadKeyFor(phone);
  return key.length === 10 ? `(${key.slice(0, 3)}) ${key.slice(3, 6)}-${key.slice(6)}` : phone || "Unknown";
}

/** "#12 On my way" → relay "On my way" into conversation 12. */
export function parseRelayReply(body: string): { conversationId: number; message: string } | null {
  const match = /^#(\d{1,9})\s+(\S[\s\S]*)$/.exec((body || "").trim());
  if (!match) return null;
  return { conversationId: Number(match[1]), message: match[2].trim() };
}

export function customerLabel(phone: string, contactName?: string | null): string {
  const display = formatPhoneDisplay(phone);
  return contactName ? `${contactName} ${display}` : display;
}

/** Text sent to technicians' cells for an inbound customer message. */
export function forwardBodyFor(input: {
  conversationId: number | null;
  label: string;
  lineNote?: string;
  body: string;
}): string {
  const head = `From ${input.label}${input.lineNote || ""}: ${input.body}`;
  if (input.conversationId == null) return head;
  return `#${input.conversationId} ${head}\nReply "#${input.conversationId} your message" to text back as CSD.`;
}

/** Copy of a team reply sent to the other technicians so nobody double-answers. */
export function mirrorBodyFor(input: {
  conversationId: number | null;
  senderName: string;
  label: string;
  body: string;
}): string {
  const prefix = input.conversationId == null ? "" : `#${input.conversationId} `;
  return `${prefix}${input.senderName} replied to ${input.label}: ${input.body}`;
}

export function staffDisplayName(user: { firstName?: string | null; lastName?: string | null; email?: string | null } | undefined): string {
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  return name || user?.email || "CSD staff";
}

// ── Lookups ──────────────────────────────────────────────────────────────────

/** Best CRM name for a phone number, or null. */
export async function lookupContactName(phone: string): Promise<string | null> {
  const key = threadKeyFor(phone);
  if (!key) return null;
  const result = await pool.query(
    `SELECT full_name, company FROM crm_contacts
      WHERE ${threadKeySql("mobile_phone")} = $1 OR ${threadKeySql("office_phone")} = $1
      ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [key],
  );
  const row = result.rows[0];
  return (row?.full_name || "").trim() || row?.company || null;
}

/**
 * Staff/alert phones and our own lines. Texts to and from these are internal
 * (forwards, alerts, dispatch) and must not appear as customer conversations.
 */
export async function internalThreadKeys(): Promise<Set<string>> {
  const settings = await getTwilioSettings();
  const numbers = [
    settings.twilioPhoneNumber,
    settings.voicemailNotifyNumber,
    process.env.CSD_CALL_ALERT_PHONE,
    ...parseSmsForwardTargets(settings.smsForwardNumbers, settings.smsForwardToNumber),
    ...configuredForwardTargets(settings).map((target) => target.number),
  ];
  const extra = await pool.query(
    `SELECT phone_number AS phone FROM tracking_numbers
     UNION ALL
     SELECT phone FROM staff_dispatch_recipients`,
  ).catch(() => pool.query(`SELECT phone_number AS phone FROM tracking_numbers`)).catch(() => ({ rows: [] as any[] }));
  numbers.push(...extra.rows.map((row: any) => row.phone));
  return new Set(numbers.map(threadKeyFor).filter(Boolean));
}

// ── Conversation state ──────────────────────────────────────────────────────

export type ConversationRow = {
  id: number;
  thread_key: string;
  customer_number: string;
  status: "open" | "done";
  assigned_user_id: string | null;
};

/**
 * Find or create the conversation for a customer number. An inbound customer
 * text reopens a "done" conversation so it lands back in the Open queue.
 */
export async function ensureConversation(customerNumber: string, inbound = false): Promise<ConversationRow> {
  const key = threadKeyFor(customerNumber);
  if (!key) throw new Error("Customer number is required");
  const result = await pool.query(
    `INSERT INTO sms_conversations (thread_key, customer_number, status, last_inbound_at)
     VALUES ($1, $2, 'open', CASE WHEN $3::boolean THEN NOW() END)
     ON CONFLICT (thread_key) DO UPDATE SET
       customer_number = EXCLUDED.customer_number,
       status = CASE WHEN $3::boolean THEN 'open' ELSE sms_conversations.status END,
       closed_at = CASE WHEN $3::boolean THEN NULL ELSE sms_conversations.closed_at END,
       last_inbound_at = CASE WHEN $3::boolean THEN NOW() ELSE sms_conversations.last_inbound_at END,
       updated_at = NOW()
     RETURNING id, thread_key, customer_number, status, assigned_user_id`,
    [key, toValidE164(customerNumber) ?? customerNumber, inbound],
  );
  return result.rows[0];
}

/** Replying claims an unowned conversation and marks it read for the sender. */
async function noteTeamReply(conversationId: number, userId: string | null): Promise<void> {
  if (!userId) return;
  await pool.query(
    `UPDATE sms_conversations SET assigned_user_id = $2, assigned_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND assigned_user_id IS NULL`,
    [conversationId, userId],
  );
  await markRead(conversationId, userId);
}

async function markRead(conversationId: number, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO sms_conversation_reads (conversation_id, user_id, last_read_at) VALUES ($1, $2, NOW())
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = NOW()`,
    [conversationId, userId],
  );
}

/** Stamp the technician on an outbound row written by sendSms(). */
export async function recordSentBy(messageSid: string, sentBy: SentBy): Promise<void> {
  await pool.query(
    `UPDATE sms_messages SET sent_by_user_id = $2, sent_by_name = $3 WHERE message_sid = $1`,
    [messageSid, sentBy.userId, sentBy.name],
  );
}

/** Queue a copy of a team reply to every forwarding phone except the sender's. */
export async function mirrorReplyToTeam(input: {
  messageSid: string;
  conversationId: number | null;
  customerNumber: string;
  businessNumber: string;
  senderName: string;
  body: string;
  excludePhone?: string | null;
}): Promise<void> {
  const settings = await getTwilioSettings();
  if (!settings.smsForwardEnabled || !input.messageSid) return;
  const customerKey = threadKeyFor(input.customerNumber);
  const skip = new Set([customerKey, threadKeyFor(input.businessNumber || settings.twilioPhoneNumber), threadKeyFor(input.excludePhone)]);
  const targets = parseSmsForwardTargets(settings.smsForwardNumbers, settings.smsForwardToNumber)
    .filter((target) => !skip.has(threadKeyFor(target)));
  if (targets.length === 0) return;
  const contactName = await lookupContactName(input.customerNumber).catch(() => null);
  await enqueueSmsForwardBroadcast({
    inboundMessageSid: input.messageSid,
    sourceNumber: toValidE164(input.customerNumber) ?? input.customerNumber,
    businessNumber: toValidE164(input.businessNumber) ?? settings.twilioPhoneNumber,
    body: mirrorBodyFor({
      conversationId: input.conversationId,
      senderName: input.senderName,
      label: customerLabel(input.customerNumber, contactName),
      body: input.body,
    }),
    targets,
  });
}

/**
 * Send a team reply as the business line: stamps who sent it, claims the
 * conversation if nobody owns it, and mirrors it to the other technicians.
 */
export async function sendTeamReply(input: {
  customerNumber: string;
  body: string;
  sentBy: SentBy;
  sendSms: InboxSendSms;
  excludeMirrorPhone?: string | null;
  mirror?: typeof mirrorReplyToTeam;
}): Promise<{ sid: string; from?: string | null; to?: string; status?: string; conversationId: number | null }> {
  const sent = await input.sendSms(input.customerNumber, input.body);
  let conversationId: number | null = null;
  try {
    const conversation = await ensureConversation(input.customerNumber);
    conversationId = conversation.id;
    await recordSentBy(sent.sid, input.sentBy);
    await noteTeamReply(conversation.id, input.sentBy.userId);
  } catch (error) {
    console.error("[shared-inbox] reply bookkeeping failed:", error);
  }
  await (input.mirror ?? mirrorReplyToTeam)({
    messageSid: sent.sid,
    conversationId,
    customerNumber: input.customerNumber,
    businessNumber: sent.from || "",
    senderName: input.sentBy.name,
    body: input.body,
    excludePhone: input.excludeMirrorPhone,
  }).catch((error) => console.error("[shared-inbox] failed to mirror team reply:", error));
  return { ...sent, conversationId };
}

// ── Reply-by-text relay ─────────────────────────────────────────────────────

/** Who a staff phone belongs to, for "sent by". Falls back to the number. */
async function staffIdentityForPhone(phone: string): Promise<SentBy> {
  const result = await pool.query(
    `SELECT r.display_name, hl.auth_user_id
       FROM staff_dispatch_recipients r
       LEFT JOIN staff_helpdesk_links hl ON hl.helpdesk_user_id = r.linked_user_id
      WHERE r.phone = $1 LIMIT 1`,
    [toValidE164(phone) ?? phone],
  ).catch(() => ({ rows: [] as any[] }));
  const row = result.rows[0];
  return {
    userId: row?.auth_user_id ?? null,
    name: row?.display_name || `Tech ${formatPhoneDisplay(phone)}`,
  };
}

/**
 * A technician texted "#12 message" to the business line from their own cell.
 * Relay it to conversation 12's customer from the main number — but only if
 * this phone was sent that conversation's forward recently, so a typo'd code
 * can't reach some other customer. Returns the confirmation texted back.
 */
export async function relayStaffReply(
  input: { staffPhone: string; conversationId: number; message: string },
  deps: { sendSms: InboxSendSms; mirror?: typeof mirrorReplyToTeam },
): Promise<string> {
  const staffPhone = toValidE164(input.staffPhone);
  if (!staffPhone) return "Not sent: unrecognized phone.";
  const conversation = await pool.query(
    `SELECT id, customer_number, thread_key FROM sms_conversations WHERE id = $1`,
    [input.conversationId],
  );
  const row = conversation.rows[0];
  const refused = `Not sent: #${input.conversationId} wasn't forwarded to this phone. Reply using the code on the text you received.`;
  if (!row) return refused;
  const forwarded = await pool.query(
    `SELECT 1 FROM sms_forward_deliveries
      WHERE target_number = $1 AND ${threadKeySql("source_number")} = $2
        AND created_at > NOW() - make_interval(days => $3)
      LIMIT 1`,
    [staffPhone, row.thread_key, RELAY_WINDOW_DAYS],
  );
  if (forwarded.rows.length === 0) return refused;
  if (input.message.length > SMS_MAX_LENGTH) return "Not sent: message is too long.";

  const contactName = await lookupContactName(row.customer_number).catch(() => null);
  const label = customerLabel(row.customer_number, contactName);
  try {
    const sentBy = await staffIdentityForPhone(staffPhone);
    await sendTeamReply({
      customerNumber: row.customer_number,
      body: input.message,
      sentBy,
      sendSms: deps.sendSms,
      mirror: deps.mirror,
      excludeMirrorPhone: staffPhone,
    });
    return `Sent to ${label} from the CSD main line.`;
  } catch (error: any) {
    return `Not sent to ${label}: ${String(error?.message || "send failed").slice(0, 120)}`;
  }
}

// ── Inbox read model ────────────────────────────────────────────────────────

export type InboxFilter = "open" | "mine" | "unassigned" | "done" | "all";

type ThreadAggregate = {
  thread_key: string;
  counterparty: string;
  last_message: string;
  last_direction: string;
  last_sent_by: string | null;
  last_at: string;
  last_inbound_at: string | null;
  message_count: string;
};

const THREAD_AGGREGATE_SQL = `
  WITH keyed AS (
    SELECT m.*, CASE WHEN m.direction = 'inbound' THEN m.from_number ELSE m.to_number END AS counterparty,
           ${threadKeySql("CASE WHEN m.direction = 'inbound' THEN m.from_number ELSE m.to_number END")} AS thread_key
      FROM sms_messages m
  )
  SELECT thread_key,
         (array_agg(counterparty ORDER BY created_at DESC))[1] AS counterparty,
         (array_agg(body ORDER BY created_at DESC))[1] AS last_message,
         (array_agg(direction ORDER BY created_at DESC))[1] AS last_direction,
         (array_agg(sent_by_name ORDER BY created_at DESC))[1] AS last_sent_by,
         MAX(created_at) AS last_at,
         MAX(created_at) FILTER (WHERE direction = 'inbound') AS last_inbound_at,
         COUNT(*) AS message_count
    FROM keyed WHERE thread_key <> ''
   GROUP BY thread_key
   ORDER BY MAX(created_at) DESC
   LIMIT 300`;

export async function listInbox(userId: string | null, filter: InboxFilter) {
  const internal = await internalThreadKeys();
  const threads = ((await pool.query(THREAD_AGGREGATE_SQL)).rows as ThreadAggregate[])
    .filter((thread) => !internal.has(thread.thread_key));

  // Backfill conversation rows for history that predates the shared inbox:
  // threads the customer spoke last start open, the rest start done.
  if (threads.length) {
    await pool.query(
      `INSERT INTO sms_conversations (thread_key, customer_number, status, last_inbound_at, read_baseline_at)
       SELECT k, n, s, NULLIF(t, '')::timestamptz, NOW()
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS x(k, n, s, t)
       ON CONFLICT (thread_key) DO NOTHING`,
      [
        threads.map((t) => t.thread_key),
        threads.map((t) => toValidE164(t.counterparty) ?? t.counterparty),
        threads.map((t) => (t.last_direction === "inbound" ? "open" : "done")),
        threads.map((t) => (t.last_inbound_at ? new Date(t.last_inbound_at).toISOString() : "")),
      ],
    );
  }

  const state = await pool.query(
    `SELECT c.id, c.thread_key, c.status, c.assigned_user_id, c.read_baseline_at,
            u.first_name, u.last_name, u.email, r.last_read_at
       FROM sms_conversations c
       LEFT JOIN auth_users u ON u.id = c.assigned_user_id
       LEFT JOIN sms_conversation_reads r ON r.conversation_id = c.id AND r.user_id = $2
      WHERE c.thread_key = ANY($1::text[])`,
    [threads.map((t) => t.thread_key), userId],
  );
  const byKey = new Map(state.rows.map((row: any) => [row.thread_key, row]));
  const names = await contactNamesByKey(threads.map((t) => t.thread_key));

  const rows = threads.map((thread) => {
    const conv: any = byKey.get(thread.thread_key);
    const readMark = conv?.last_read_at ?? conv?.read_baseline_at ?? null;
    const unread = Boolean(
      thread.last_inbound_at && (!readMark || new Date(thread.last_inbound_at) > new Date(readMark)),
    );
    return {
      conversationId: conv?.id ?? null,
      threadKey: thread.thread_key,
      customerNumber: toValidE164(thread.counterparty) ?? thread.counterparty,
      contactId: names.get(thread.thread_key)?.id ?? null,
      contactName: names.get(thread.thread_key)?.name ?? null,
      status: (conv?.status ?? "open") as "open" | "done",
      assignedUserId: conv?.assigned_user_id ?? null,
      assignedName: conv?.assigned_user_id ? staffDisplayName({ firstName: conv.first_name, lastName: conv.last_name, email: conv.email }) : null,
      lastMessage: thread.last_message,
      lastDirection: thread.last_direction,
      lastSentBy: thread.last_sent_by,
      lastAt: thread.last_at,
      messageCount: Number(thread.message_count),
      unread,
    };
  });

  const counts = {
    open: rows.filter((r) => r.status === "open").length,
    mine: rows.filter((r) => r.status === "open" && userId && r.assignedUserId === userId).length,
    unassigned: rows.filter((r) => r.status === "open" && !r.assignedUserId).length,
    done: rows.filter((r) => r.status === "done").length,
    all: rows.length,
    unread: rows.filter((r) => r.unread).length,
  };
  const filtered = rows.filter((r) => {
    if (filter === "all") return true;
    if (filter === "done") return r.status === "done";
    if (r.status !== "open") return false;
    if (filter === "mine") return Boolean(userId) && r.assignedUserId === userId;
    if (filter === "unassigned") return !r.assignedUserId;
    return true;
  });
  // The client's Clerk id isn't always the local staff id, so say who "me" is.
  return { conversations: filtered, counts, currentUserId: userId };
}

async function contactNamesByKey(keys: string[]): Promise<Map<string, { id: number; name: string }>> {
  const map = new Map<string, { id: number; name: string }>();
  if (!keys.length) return map;
  const result = await pool.query(
    `SELECT id, full_name, company, ${threadKeySql("mobile_phone")} AS mobile_key, ${threadKeySql("office_phone")} AS office_key
       FROM crm_contacts
      WHERE ${threadKeySql("mobile_phone")} = ANY($1::text[]) OR ${threadKeySql("office_phone")} = ANY($1::text[])
      ORDER BY updated_at DESC NULLS LAST`,
    [keys],
  );
  for (const row of result.rows) {
    const name = (row.full_name || "").trim() || row.company || "";
    for (const key of [row.mobile_key, row.office_key]) {
      if (key && !map.has(key)) map.set(key, { id: row.id, name });
    }
  }
  return map;
}

/** Texts, notes, calls and voicemails for one customer, oldest first. */
export async function conversationTimeline(threadKey: string) {
  const conversation = await pool.query(
    `SELECT c.*, u.first_name, u.last_name, u.email
       FROM sms_conversations c LEFT JOIN auth_users u ON u.id = c.assigned_user_id
      WHERE c.thread_key = $1`,
    [threadKey],
  );
  const conv = conversation.rows[0];
  if (!conv) return null;

  const [messages, notes, calls, voicemails, names] = await Promise.all([
    pool.query(
      `SELECT * FROM (
         SELECT id, body, direction, status, error_code, sent_by_name, created_at
           FROM sms_messages
          WHERE ${threadKeySql("CASE WHEN direction = 'inbound' THEN from_number ELSE to_number END")} = $1
          ORDER BY created_at DESC LIMIT 500
       ) recent ORDER BY created_at`,
      [threadKey],
    ),
    pool.query(
      `SELECT id, author_name, body, created_at FROM sms_conversation_notes WHERE conversation_id = $1 ORDER BY created_at`,
      [conv.id],
    ),
    pool.query(
      `SELECT id, direction, status, duration_seconds, had_voicemail, created_at
         FROM call_log
        WHERE ${threadKeySql("CASE WHEN direction = 'outbound' THEN to_number ELSE from_number END")} = $1
        ORDER BY created_at DESC LIMIT 100`,
      [threadKey],
    ),
    pool.query(
      `SELECT id, duration_seconds, transcription, listened, created_at
         FROM voicemails WHERE ${threadKeySql("from_number")} = $1
        ORDER BY created_at DESC LIMIT 50`,
      [threadKey],
    ),
    contactNamesByKey([threadKey]),
  ]);

  const items = [
    ...messages.rows.map((m: any) => ({
      kind: "message" as const, id: `message-${m.id}`, at: m.created_at, body: m.body,
      direction: m.direction, status: m.status, errorCode: m.error_code, sentBy: m.sent_by_name,
    })),
    ...notes.rows.map((n: any) => ({ kind: "note" as const, id: `note-${n.id}`, at: n.created_at, body: n.body, author: n.author_name })),
    ...calls.rows.map((c: any) => ({
      kind: "call" as const, id: `call-${c.id}`, at: c.created_at, direction: c.direction ?? "inbound",
      status: c.status, durationSeconds: c.duration_seconds ?? 0, hadVoicemail: c.had_voicemail,
    })),
    ...voicemails.rows.map((v: any) => ({
      kind: "voicemail" as const, id: `voicemail-${v.id}`, voicemailId: v.id, at: v.created_at,
      durationSeconds: v.duration_seconds ?? 0, transcription: v.transcription, listened: v.listened,
    })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return {
    conversation: {
      conversationId: conv.id,
      threadKey: conv.thread_key,
      customerNumber: conv.customer_number,
      contactId: names.get(threadKey)?.id ?? null,
      contactName: names.get(threadKey)?.name ?? null,
      status: conv.status,
      assignedUserId: conv.assigned_user_id,
      assignedName: conv.assigned_user_id ? staffDisplayName({ firstName: conv.first_name, lastName: conv.last_name, email: conv.email }) : null,
    },
    items,
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

function actor(req: Request): SentBy {
  return { userId: req.dbUser?.id ?? null, name: staffDisplayName(req.dbUser ?? undefined) };
}

const FILTERS: InboxFilter[] = ["open", "mine", "unassigned", "done", "all"];

export function registerSharedInboxRoutes(app: Express): void {
  app.get("/api/sms/inbox", async (req, res) => {
    try {
      const requested = String(req.query.filter || "open") as InboxFilter;
      res.json(await listInbox(req.dbUser?.id ?? null, FILTERS.includes(requested) ? requested : "open"));
    } catch (error: any) {
      console.error("GET /api/sms/inbox failed:", error);
      res.status(500).json({ error: error?.message || "Failed to load inbox" });
    }
  });

  // Approved staff a conversation can be assigned to.
  app.get("/api/sms/inbox/assignees", async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT a.id, a.first_name, a.last_name, a.email
           FROM auth_users a JOIN staff_access_profiles p ON p.user_id = a.id
          WHERE p.approval_status = 'approved'
          ORDER BY COALESCE(NULLIF(a.first_name, ''), a.email), a.id`,
      );
      res.json(result.rows.map((row: any) => ({
        id: row.id,
        name: staffDisplayName({ firstName: row.first_name, lastName: row.last_name, email: row.email }),
      })));
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Failed to load staff" });
    }
  });

  app.get("/api/sms/inbox/:threadKey", async (req, res): Promise<any> => {
    try {
      const timeline = await conversationTimeline(threadKeyFor(req.params.threadKey));
      if (!timeline) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      res.json(timeline);
    } catch (error: any) {
      console.error("GET /api/sms/inbox/:threadKey failed:", error);
      res.status(500).json({ error: error?.message || "Failed to load conversation" });
    }
  });

  app.post("/api/sms/inbox/:threadKey/read", async (req, res): Promise<any> => {
    try {
      const userId = req.dbUser?.id;
      if (!userId) {
        res.status(401).json({ error: "Sign in required" });
        return;
      }
      const conv = await pool.query(`SELECT id FROM sms_conversations WHERE thread_key = $1`, [threadKeyFor(req.params.threadKey)]);
      if (!conv.rows[0]) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      await markRead(conv.rows[0].id, userId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Failed to mark read" });
    }
  });

  app.patch("/api/sms/inbox/:threadKey", async (req, res): Promise<any> => {
    try {
      const { status, assignedUserId } = req.body ?? {};
      if (status !== undefined && status !== "open" && status !== "done") {
        res.status(400).json({ error: "status must be open or done" });
        return;
      }
      if (assignedUserId !== undefined && assignedUserId !== null) {
        const ok = await pool.query(
          `SELECT 1 FROM staff_access_profiles WHERE user_id = $1 AND approval_status = 'approved'`,
          [String(assignedUserId)],
        );
        if (!ok.rows.length) {
          res.status(400).json({ error: "Assignee must be approved staff" });
          return;
        }
      }
      const result = await pool.query(
        `UPDATE sms_conversations SET
           status = COALESCE($2, status),
           closed_at = CASE WHEN $2 = 'done' THEN NOW() WHEN $2 = 'open' THEN NULL ELSE closed_at END,
           closed_by_user_id = CASE WHEN $2 = 'done' THEN $5 WHEN $2 = 'open' THEN NULL ELSE closed_by_user_id END,
           assigned_user_id = CASE WHEN $3::boolean THEN $4 ELSE assigned_user_id END,
           assigned_at = CASE WHEN $3::boolean THEN NOW() ELSE assigned_at END,
           updated_at = NOW()
         WHERE thread_key = $1
         RETURNING id, status, assigned_user_id`,
        [threadKeyFor(req.params.threadKey), status ?? null, assignedUserId !== undefined, assignedUserId ?? null, req.dbUser?.id ?? null],
      );
      if (!result.rows[0]) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      res.json({ conversationId: result.rows[0].id, status: result.rows[0].status, assignedUserId: result.rows[0].assigned_user_id });
    } catch (error: any) {
      console.error("PATCH /api/sms/inbox/:threadKey failed:", error);
      res.status(500).json({ error: error?.message || "Failed to update conversation" });
    }
  });

  // Team-only note: stored on the conversation, never texted to the customer.
  app.post("/api/sms/inbox/:threadKey/notes", async (req, res): Promise<any> => {
    try {
      const body = String(req.body?.body ?? "").trim();
      if (!body) {
        res.status(400).json({ error: "Note text is required" });
        return;
      }
      if (body.length > NOTE_MAX_LENGTH) {
        res.status(400).json({ error: "Note is too long" });
        return;
      }
      const conv = await pool.query(`SELECT id FROM sms_conversations WHERE thread_key = $1`, [threadKeyFor(req.params.threadKey)]);
      if (!conv.rows[0]) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      const who = actor(req);
      const result = await pool.query(
        `INSERT INTO sms_conversation_notes (conversation_id, author_user_id, author_name, body)
         VALUES ($1, $2, $3, $4) RETURNING id, author_name, body, created_at`,
        [conv.rows[0].id, who.userId, who.name, body],
      );
      res.status(201).json(result.rows[0]);
    } catch (error: any) {
      console.error("POST /api/sms/inbox/:threadKey/notes failed:", error);
      res.status(500).json({ error: error?.message || "Failed to save note" });
    }
  });
}

export { actor as inboxActor };
