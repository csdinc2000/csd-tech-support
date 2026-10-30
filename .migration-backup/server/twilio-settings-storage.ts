import { db } from "./db";
import { twilioSettings, voicemails, callLog, type TwilioSettings, type UpdateTwilioSettings, type Voicemail, type InsertVoicemail, type CallLog, type InsertCallLog } from "@shared/schema";
import { eq, desc, sql } from "drizzle-orm";

let cached: TwilioSettings | null = null;
let cachedAt = 0;
const TTL = 5_000;

export async function getTwilioSettings(): Promise<TwilioSettings> {
  if (cached && Date.now() - cachedAt < TTL) return cached;
  const rows = await db.select().from(twilioSettings).where(eq(twilioSettings.id, 1)).limit(1);
  if (rows.length === 0) {
    // Insert defaults via DB defaults — pass empty insert.
    const [row] = await db.insert(twilioSettings).values({ id: 1 } as any).returning();
    cached = row;
    cachedAt = Date.now();
    return row;
  }
  cached = rows[0];
  cachedAt = Date.now();
  return rows[0];
}

export async function updateTwilioSettings(patch: UpdateTwilioSettings): Promise<TwilioSettings> {
  await getTwilioSettings(); // ensure row exists
  const [row] = await db
    .update(twilioSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(twilioSettings.id, 1))
    .returning();
  cached = row;
  cachedAt = Date.now();
  return row;
}

export function invalidateTwilioSettingsCache() {
  cached = null;
  cachedAt = 0;
}

export async function listVoicemails(opts?: { unreadOnly?: boolean; limit?: number }): Promise<Voicemail[]> {
  const limit = opts?.limit ?? 100;
  if (opts?.unreadOnly) {
    return db.select().from(voicemails).where(eq(voicemails.listened, false)).orderBy(desc(voicemails.createdAt)).limit(limit);
  }
  return db.select().from(voicemails).orderBy(desc(voicemails.createdAt)).limit(limit);
}

export async function getVoicemail(id: number): Promise<Voicemail | undefined> {
  const rows = await db.select().from(voicemails).where(eq(voicemails.id, id)).limit(1);
  return rows[0];
}

export async function getVoicemailByCallSid(callSid: string): Promise<Voicemail | undefined> {
  const rows = await db.select().from(voicemails).where(eq(voicemails.callSid, callSid)).limit(1);
  return rows[0];
}

export async function createVoicemail(v: InsertVoicemail): Promise<Voicemail> {
  const [row] = await db.insert(voicemails).values(v).returning();
  return row;
}

export async function updateVoicemail(id: number, patch: Partial<InsertVoicemail> & { listened?: boolean }): Promise<Voicemail | undefined> {
  const [row] = await db.update(voicemails).set(patch).where(eq(voicemails.id, id)).returning();
  return row;
}

export async function updateVoicemailByCallSid(callSid: string, patch: Partial<InsertVoicemail>): Promise<Voicemail | undefined> {
  const [row] = await db.update(voicemails).set(patch).where(eq(voicemails.callSid, callSid)).returning();
  return row;
}

export async function deleteVoicemail(id: number): Promise<boolean> {
  const result = await db.delete(voicemails).where(eq(voicemails.id, id)).returning();
  return result.length > 0;
}

// ── Call log ────────────────────────────────────────────────────────────────
export async function listCallLog(opts?: { limit?: number }): Promise<CallLog[]> {
  const limit = opts?.limit ?? 200;
  return db.select().from(callLog).orderBy(desc(callLog.createdAt)).limit(limit);
}

export async function getCallLogStats(): Promise<{
  total: number;
  unique: number;
  last24h: number;
  voicemails: number;
}> {
  const result: any = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(DISTINCT from_number)::int AS unique,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last24h,
      COUNT(*) FILTER (WHERE had_voicemail)::int AS voicemails
    FROM call_log
  `);
  const row = (result?.rows ?? result)?.[0] ?? {};
  return {
    total: Number(row?.total ?? 0),
    unique: Number(row?.unique ?? 0),
    last24h: Number(row?.last24h ?? 0),
    voicemails: Number(row?.voicemails ?? 0),
  };
}

// Insert-or-update by callSid. Twilio fires multiple webhooks per call
// (incoming → status updates), so we upsert to keep one row per call.
export async function upsertCallLog(entry: InsertCallLog): Promise<CallLog> {
  const [row] = await db
    .insert(callLog)
    .values(entry)
    .onConflictDoUpdate({
      target: callLog.callSid,
      set: {
        status: entry.status ?? sql`call_log.status`,
        durationSeconds: entry.durationSeconds ?? sql`call_log.duration_seconds`,
        hadVoicemail: entry.hadVoicemail ?? sql`call_log.had_voicemail`,
        fromCity: entry.fromCity ?? sql`call_log.from_city`,
        fromState: entry.fromState ?? sql`call_log.from_state`,
        fromCountry: entry.fromCountry ?? sql`call_log.from_country`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

export async function markCallVoicemail(callSid: string): Promise<void> {
  await db.update(callLog).set({ hadVoicemail: true, updatedAt: new Date() }).where(eq(callLog.callSid, callSid));
}

export async function deleteCallLog(id: number): Promise<boolean> {
  const result = await db.delete(callLog).where(eq(callLog.id, id)).returning();
  return result.length > 0;
}
