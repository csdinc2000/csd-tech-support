import { db } from "./db";
import {
  trackingNumbers,
  callFlows,
  smsMessages,
  callLog,
  type TrackingNumber,
  type InsertTrackingNumber,
  type CallFlow,
  type InsertCallFlow,
  type SmsMessage,
  type InsertSmsMessage,
} from "@shared/schema";
import { eq, desc, sql, and, or } from "drizzle-orm";

// ── Tracking numbers ────────────────────────────────────────────────────────
export async function listTrackingNumbers(): Promise<TrackingNumber[]> {
  return db.select().from(trackingNumbers).orderBy(desc(trackingNumbers.createdAt));
}

export async function getTrackingNumber(id: number): Promise<TrackingNumber | undefined> {
  const r = await db.select().from(trackingNumbers).where(eq(trackingNumbers.id, id)).limit(1);
  return r[0];
}

export async function getTrackingNumberByPhone(phone: string): Promise<TrackingNumber | undefined> {
  const r = await db.select().from(trackingNumbers).where(eq(trackingNumbers.phoneNumber, phone)).limit(1);
  return r[0];
}

export async function createTrackingNumber(t: InsertTrackingNumber): Promise<TrackingNumber> {
  const [row] = await db.insert(trackingNumbers).values(t).returning();
  return row;
}

export async function updateTrackingNumber(id: number, patch: Partial<InsertTrackingNumber>): Promise<TrackingNumber | undefined> {
  const [row] = await db.update(trackingNumbers).set({ ...patch, updatedAt: new Date() }).where(eq(trackingNumbers.id, id)).returning();
  return row;
}

export async function deleteTrackingNumber(id: number): Promise<boolean> {
  const r = await db.delete(trackingNumbers).where(eq(trackingNumbers.id, id)).returning();
  return r.length > 0;
}

// ── Call flows ──────────────────────────────────────────────────────────────
export async function listCallFlows(): Promise<CallFlow[]> {
  return db.select().from(callFlows).orderBy(desc(callFlows.createdAt));
}

export async function getCallFlow(id: number): Promise<CallFlow | undefined> {
  const r = await db.select().from(callFlows).where(eq(callFlows.id, id)).limit(1);
  return r[0];
}

export async function createCallFlow(f: InsertCallFlow): Promise<CallFlow> {
  const [row] = await db.insert(callFlows).values(f).returning();
  return row;
}

export async function updateCallFlow(id: number, patch: Partial<InsertCallFlow>): Promise<CallFlow | undefined> {
  const [row] = await db.update(callFlows).set({ ...patch, updatedAt: new Date() }).where(eq(callFlows.id, id)).returning();
  return row;
}

export async function deleteCallFlow(id: number): Promise<boolean> {
  const r = await db.delete(callFlows).where(eq(callFlows.id, id)).returning();
  return r.length > 0;
}

// ── SMS messages ────────────────────────────────────────────────────────────
// Normalize a phone number to its 10-digit US form (or trailing digits) so we
// can match "+19545551234", "19545551234", "9545551234", and "(954) 555-1234"
// as the same counterparty.
function normalizeDigits(s: string): string {
  const d = (s || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d;
}

export async function listSmsMessages(opts?: { limit?: number; counterparty?: string }): Promise<SmsMessage[]> {
  const limit = opts?.limit ?? 200;
  if (opts?.counterparty) {
    const norm = normalizeDigits(opts.counterparty);
    if (!norm) return [];
    const result: any = await db.execute(sql`
      SELECT * FROM sms_messages
      WHERE regexp_replace(from_number, '\\D', '', 'g') LIKE '%' || ${norm}
         OR regexp_replace(to_number,   '\\D', '', 'g') LIKE '%' || ${norm}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);
    const rows = result?.rows ?? result ?? [];
    return rows.map((r: any) => ({
      id: r.id,
      messageSid: r.message_sid,
      fromNumber: r.from_number,
      toNumber: r.to_number,
      body: r.body,
      direction: r.direction,
      status: r.status,
      errorCode: r.error_code,
      trackingNumberId: r.tracking_number_id,
      createdAt: r.created_at,
    })) as SmsMessage[];
  }
  return db.select().from(smsMessages).orderBy(desc(smsMessages.createdAt)).limit(limit);
}

export async function createSmsMessage(m: InsertSmsMessage): Promise<SmsMessage> {
  const [row] = await db.insert(smsMessages).values(m).returning();
  return row;
}

export async function updateSmsMessageStatus(
  messageSid: string,
  status: string,
  errorCode: string | null,
): Promise<void> {
  if (!messageSid) return;
  // Persist the carrier error code (e.g. 30034 = unregistered A2P sender) so the
  // Messages UI can explain *why* a text failed instead of just showing "failed".
  await db
    .update(smsMessages)
    .set({ status, ...(errorCode ? { errorCode } : {}) })
    .where(eq(smsMessages.messageSid, messageSid));
}

export async function deleteSmsMessage(id: number): Promise<boolean> {
  const result: any = await db.delete(smsMessages).where(eq(smsMessages.id, id)).returning({ id: smsMessages.id });
  const rows = result?.rows ?? result ?? [];
  return rows.length > 0;
}

export async function deleteSmsConversation(counterparty: string): Promise<number> {
  const norm = normalizeDigits(counterparty);
  if (!norm) return 0;
  const result: any = await db.execute(sql`
    DELETE FROM sms_messages
    WHERE regexp_replace(from_number, '\\D', '', 'g') LIKE '%' || ${norm}
       OR regexp_replace(to_number,   '\\D', '', 'g') LIKE '%' || ${norm}
    RETURNING id
  `);
  const rows = result?.rows ?? result ?? [];
  return rows.length;
}

// SMS conversations: latest message per (counterparty, tracking number)
export async function listSmsConversations(): Promise<Array<{
  counterparty: string;
  trackingNumber: string;
  lastMessage: string;
  lastDirection: string;
  lastAt: string;
  count: number;
}>> {
  // Group by the normalized digits of the counterparty so that the same
  // customer with different formatting collapses into a single thread.
  const result: any = await db.execute(sql`
    WITH base AS (
      SELECT
        CASE WHEN direction = 'inbound' THEN from_number ELSE to_number END AS counterparty,
        CASE WHEN direction = 'inbound' THEN to_number   ELSE from_number END AS tracking_number,
        regexp_replace(
          CASE WHEN direction = 'inbound' THEN from_number ELSE to_number END,
          '\\D', '', 'g'
        ) AS counterparty_digits,
        body, direction, created_at
      FROM sms_messages
    ),
    norm AS (
      SELECT
        CASE WHEN length(counterparty_digits) = 11 AND left(counterparty_digits, 1) = '1'
             THEN substring(counterparty_digits FROM 2)
             ELSE counterparty_digits
        END AS thread_key,
        counterparty, tracking_number, body, direction, created_at
      FROM base
    ),
    conv AS (
      SELECT
        thread_key, counterparty, tracking_number, body, direction, created_at,
        ROW_NUMBER() OVER (PARTITION BY thread_key ORDER BY created_at DESC) AS rn,
        COUNT(*) OVER (PARTITION BY thread_key) AS count
      FROM norm
    )
    SELECT counterparty, tracking_number, body AS last_message,
           direction AS last_direction, created_at AS last_at, count
    FROM conv WHERE rn = 1 ORDER BY last_at DESC LIMIT 200
  `);
  const rows = result?.rows ?? result ?? [];
  return rows.map((r: any) => ({
    counterparty: r.counterparty,
    trackingNumber: r.tracking_number,
    lastMessage: r.last_message,
    lastDirection: r.last_direction,
    lastAt: r.last_at,
    count: Number(r.count ?? 0),
  }));
}

// ── Analytics ───────────────────────────────────────────────────────────────
export async function getAnalyticsByTrackingNumber(): Promise<Array<{
  trackingNumberId: number | null;
  phoneNumber: string | null;
  campaignName: string | null;
  sourceChannel: string | null;
  totalCalls: number;
  uniqueCallers: number;
  voicemails: number;
  avgDuration: number;
}>> {
  const result: any = await db.execute(sql`
    SELECT
      cl.tracking_number_id,
      tn.phone_number,
      tn.campaign_name,
      tn.source_channel,
      COUNT(*)::int AS total_calls,
      COUNT(DISTINCT cl.from_number)::int AS unique_callers,
      COUNT(*) FILTER (WHERE cl.had_voicemail)::int AS voicemails,
      COALESCE(AVG(cl.duration_seconds), 0)::int AS avg_duration
    FROM call_log cl
    LEFT JOIN tracking_numbers tn ON tn.id = cl.tracking_number_id
    GROUP BY cl.tracking_number_id, tn.phone_number, tn.campaign_name, tn.source_channel
    ORDER BY total_calls DESC
  `);
  const rows = result?.rows ?? result ?? [];
  return rows.map((r: any) => ({
    trackingNumberId: r.tracking_number_id,
    phoneNumber: r.phone_number,
    campaignName: r.campaign_name,
    sourceChannel: r.source_channel,
    totalCalls: Number(r.total_calls ?? 0),
    uniqueCallers: Number(r.unique_callers ?? 0),
    voicemails: Number(r.voicemails ?? 0),
    avgDuration: Number(r.avg_duration ?? 0),
  }));
}

export async function getAnalyticsBySourceChannel(): Promise<Array<{
  sourceChannel: string;
  totalCalls: number;
  uniqueCallers: number;
}>> {
  const result: any = await db.execute(sql`
    SELECT
      COALESCE(cl.source_channel, tn.source_channel, 'Unattributed') AS source_channel,
      COUNT(*)::int AS total_calls,
      COUNT(DISTINCT cl.from_number)::int AS unique_callers
    FROM call_log cl
    LEFT JOIN tracking_numbers tn ON tn.id = cl.tracking_number_id
    GROUP BY 1 ORDER BY total_calls DESC
  `);
  const rows = result?.rows ?? result ?? [];
  return rows.map((r: any) => ({
    sourceChannel: r.source_channel,
    totalCalls: Number(r.total_calls ?? 0),
    uniqueCallers: Number(r.unique_callers ?? 0),
  }));
}

export async function getCallsByDay(days: number = 30): Promise<Array<{ day: string; count: number }>> {
  const result: any = await db.execute(sql`
    SELECT DATE_TRUNC('day', created_at)::date::text AS day, COUNT(*)::int AS count
    FROM call_log
    WHERE created_at > NOW() - (${days} || ' days')::interval
    GROUP BY 1 ORDER BY 1 ASC
  `);
  const rows = result?.rows ?? result ?? [];
  return rows.map((r: any) => ({ day: r.day, count: Number(r.count ?? 0) }));
}
