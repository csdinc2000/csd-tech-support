import { db } from "./db";
import { twilioSettings, voicemails, callLog, type TwilioSettings, type UpdateTwilioSettings, type Voicemail, type InsertVoicemail, type CallLog, type InsertCallLog } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { ensureStaffDispatchTables } from "./staff-dispatch";

let cached: TwilioSettings | null = null;
let cachedAt = 0;
const TTL = 5_000;
let callOrderConfiguration: Promise<void> | null = null;

/** Apply the owner's requested order once per database, including after Publish.
 * The existing audit ledger prevents later Phone Settings edits being reset.
 */
async function configureRequestedCallOrderOnce(): Promise<void> {
  await ensureStaffDispatchTables();
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('owner_requested_call_order'))`);
    const applied = await tx.execute(sql`
      SELECT id FROM staff_dispatch_audit
      WHERE actor_identity='owner_requested_call_order' AND action='phone.forwarding.configured' AND outcome='accepted'
      LIMIT 1
    `);
    if (applied.rows.length) return;
    const [before] = await tx.select().from(twilioSettings).where(eq(twilioSettings.id, 1)).for("update");
    if (!before) throw new Error("Phone Settings must exist before configuring call order");
    const patch = {
      forwardToNumber: "+19546706084", backupForwardNumber: "+19546706124", backupForwardNumber2: "+19542533135",
      callForwardingEnabled: true, voicemailEnabled: true,
    };
    await tx.update(twilioSettings).set({ ...patch, updatedAt: new Date() }).where(eq(twilioSettings.id, 1));
    await tx.execute(sql`
      INSERT INTO staff_dispatch_audit(actor_type,actor_identity,action,outcome,before_summary,after_summary)
      VALUES('system','owner_requested_call_order','phone.forwarding.configured','accepted',
        ${JSON.stringify({
          forwardToNumber: before.forwardToNumber, backupForwardNumber: before.backupForwardNumber,
          backupForwardNumber2: before.backupForwardNumber2, callForwardingEnabled: before.callForwardingEnabled,
          voicemailEnabled: before.voicemailEnabled,
        })}::jsonb, ${JSON.stringify(patch)}::jsonb)
    `);
  });
}

export async function getTwilioSettings(): Promise<TwilioSettings> {
  if (cached && Date.now() - cachedAt < TTL) return cached;
  const rows = await db.select().from(twilioSettings).where(eq(twilioSettings.id, 1)).limit(1);
  if (rows.length === 0) {
    // Insert defaults via DB defaults — pass empty insert.
    await db.insert(twilioSettings).values({ id: 1 } as any).onConflictDoNothing({ target: twilioSettings.id });
    // Continue through the same one-time configuration as existing databases.
  }
  if (!callOrderConfiguration) {
    callOrderConfiguration = configureRequestedCallOrderOnce().catch(error => {
      callOrderConfiguration = null;
      throw error;
    });
  }
  await callOrderConfiguration;
  const configured = await db.select().from(twilioSettings).where(eq(twilioSettings.id, 1)).limit(1);
  cached = configured[0];
  cachedAt = Date.now();
  return configured[0];
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

export type CallForwardingOutcomeInput = {
  parentCallSid: string;
  childCallSid: string;
  attemptKey: "primary" | "backup1" | "backup2" | "tracking" | "staff";
  destinationNumber: string;
  providerStatus: "completed" | "no-answer" | "busy" | "failed" | "canceled" | "in-progress" | "ringing" | "queued" | "initiated" | "unknown";
  humanAccepted: boolean;
};

export async function upsertCallForwardingOutcome(input: CallForwardingOutcomeInput): Promise<void> {
  await db.execute(sql`
    INSERT INTO call_forwarding_outcomes (
      parent_call_sid, child_call_sid, attempt_key, destination_number,
      provider_status, human_accepted, provider_updated_at, updated_at
    )
    VALUES (
      ${input.parentCallSid}, ${input.childCallSid}, ${input.attemptKey},
      ${input.destinationNumber}, ${input.providerStatus}, ${input.humanAccepted},
      NOW(), NOW()
    )
    ON CONFLICT (child_call_sid) DO UPDATE SET
      parent_call_sid = EXCLUDED.parent_call_sid,
      attempt_key = EXCLUDED.attempt_key,
      destination_number = EXCLUDED.destination_number,
      provider_status = EXCLUDED.provider_status,
      human_accepted = call_forwarding_outcomes.human_accepted OR EXCLUDED.human_accepted,
      provider_updated_at = NOW(),
      updated_at = NOW()
  `);
}

export async function listCallForwardingOutcomes(parentCallSid: string) {
  const result = await db.execute(sql`
    SELECT child_call_sid, attempt_key, destination_number, provider_status, human_accepted,
      provider_updated_at
    FROM call_forwarding_outcomes
    WHERE parent_call_sid = ${parentCallSid}
    ORDER BY created_at ASC
  `);
  return (result.rows ?? []).map((row: any) => ({
    childCallSid: String(row.child_call_sid),
    attemptKey: String(row.attempt_key),
    destinationNumber: String(row.destination_number),
    providerStatus: String(row.provider_status),
    humanAccepted: Boolean(row.human_accepted),
    providerUpdatedAt: row.provider_updated_at,
  }));
}

export async function deleteCallLog(id: number): Promise<boolean> {
  const result = await db.delete(callLog).where(eq(callLog.id, id)).returning();
  return result.length > 0;
}
