import type { Express, Request } from "express";
import { z } from "zod/v4";
import { pool } from "./db";
import { logger } from "./lib/logger";
import { queueSpeedToLeadEscalation } from "./slack";
import { getSmsConsentEligibility } from "./staff-dispatch";
import { isTwilioConfigured, sendSms, toValidE164 } from "./twilio";
import {
  AUTOMATED_PERFORMERS,
  DEFAULT_AUTO_TEXT_TEMPLATE,
  FIRST_CONTACT_INTERACTION_TYPES,
  firstNameOf,
  isWithinBusinessHours,
  leadQualifiesForSpeedToLead,
  localDayHour,
  parseBusinessDays,
  renderAutoText,
  shouldEscalate,
  summarizeSpeedToLead,
  validateAutoTextTemplate,
} from "./sales-agents-core";

/**
 * Speed to Lead automation.
 *
 * A background worker (every 20 s) watches new inbound CRM leads:
 *  1. Opens a first-contact clock for every qualifying lead.
 *  2. Sends ONE instant acknowledgement text from the business line, only when
 *     the owner switched auto-text on AND the customer gave service SMS consent
 *     (same rule as every other customer text). Never during quiet hours.
 *  3. Detects the first human contact (call, text, email, appointment, status
 *     change) and stops the clock.
 *  4. Escalates to Slack and optional staff phones once a lead waits past the
 *     target without a human contact.
 *
 * Off by default. Settings changes are owner-only (security.ts).
 */

const TICK_MS = 20_000;
const AUTO_TEXT_MAX_AGE_HOURS = 16;
const QUIET_START_HOUR = 21; // no automated customer texts 9pm-8am local
const QUIET_END_HOUR = 8;

export type SpeedToLeadSettings = {
  enabled: boolean;
  enabledAt: Date | null;
  autoTextEnabled: boolean;
  autoTextTemplate: string;
  targetMinutes: number;
  escalateSlack: boolean;
  escalationPhones: string[];
  businessHoursOnly: boolean;
  businessStartHour: number;
  businessEndHour: number;
  businessDays: number[];
  timezone: string;
  excludedSources: string[];
  updatedAt: Date | null;
};

const settingsInput = z.object({
  enabled: z.boolean(),
  autoTextEnabled: z.boolean(),
  autoTextTemplate: z.string().trim().min(1).max(600),
  targetMinutes: z.number().int().min(1).max(240),
  escalateSlack: z.boolean(),
  escalationPhones: z.array(z.string().trim().min(7).max(30)).max(5),
  businessHoursOnly: z.boolean(),
  businessStartHour: z.number().int().min(0).max(23),
  businessEndHour: z.number().int().min(1).max(24),
  businessDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  timezone: z.string().trim().min(3).max(64),
  excludedSources: z.array(z.string().trim().min(1).max(60)).max(20),
}).strict();

function rowToSettings(row: any): SpeedToLeadSettings {
  return {
    enabled: row.enabled,
    enabledAt: row.enabled_at ? new Date(row.enabled_at) : null,
    autoTextEnabled: row.auto_text_enabled,
    autoTextTemplate: row.auto_text_template,
    targetMinutes: row.target_minutes,
    escalateSlack: row.escalate_slack,
    escalationPhones: String(row.escalation_phones || "").split(",").map((p: string) => p.trim()).filter(Boolean),
    businessHoursOnly: row.business_hours_only,
    businessStartHour: row.business_start_hour,
    businessEndHour: row.business_end_hour,
    businessDays: parseBusinessDays(row.business_days),
    timezone: row.timezone,
    excludedSources: String(row.excluded_sources || "").split(",").map((s: string) => s.trim()).filter(Boolean),
    updatedAt: row.updated_at ? new Date(row.updated_at) : null,
  };
}

export async function getSpeedToLeadSettings(): Promise<SpeedToLeadSettings> {
  await pool.query(
    `INSERT INTO speed_to_lead_settings (id, auto_text_template) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_AUTO_TEXT_TEMPLATE],
  );
  const { rows } = await pool.query("SELECT * FROM speed_to_lead_settings WHERE id = 1");
  return rowToSettings(rows[0]);
}

function hoursFor(settings: SpeedToLeadSettings) {
  return {
    businessHoursOnly: settings.businessHoursOnly,
    startHour: settings.businessStartHour,
    endHour: settings.businessEndHour,
    days: settings.businessDays,
    timezone: settings.timezone,
  };
}

export function isQuietHours(now: Date, timezone: string): boolean {
  const { hour } = localDayHour(now, timezone);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

// Canonical full-number comparison (never suffix matching), same as Aria tools.
const normalizedPhoneSql = (column: string) =>
  `CASE WHEN length(regexp_replace(${column}, '[^0-9]', '', 'g'))=10 THEN '1'||regexp_replace(${column}, '[^0-9]', '', 'g') ELSE regexp_replace(${column}, '[^0-9]', '', 'g') END`;

// ---------------------------------------------------------------------------
// Worker steps (exported for tests)
// ---------------------------------------------------------------------------

export async function openSpeedToLeadClocks(settings: SpeedToLeadSettings): Promise<number> {
  if (!settings.enabled || !settings.enabledAt) return 0;
  const candidates = await pool.query(
    `SELECT l.id, l.contact_id, l.source, l.created_at
       FROM crm_leads l
       LEFT JOIN speed_to_lead_events e ON e.lead_id = l.id
      WHERE e.lead_id IS NULL AND l.created_at >= $1 AND l.created_at > NOW() - INTERVAL '3 days'
      ORDER BY l.created_at LIMIT 200`,
    [settings.enabledAt],
  );
  let opened = 0;
  for (const lead of candidates.rows) {
    if (!leadQualifiesForSpeedToLead({ source: lead.source, createdAt: new Date(lead.created_at) }, settings)) continue;
    const inserted = await pool.query(
      `INSERT INTO speed_to_lead_events (lead_id, contact_id, lead_created_at, auto_text_status)
       VALUES ($1, $2, $3, $4) ON CONFLICT (lead_id) DO NOTHING`,
      [lead.id, lead.contact_id, lead.created_at, settings.autoTextEnabled ? "pending" : "skipped"],
    );
    if (!settings.autoTextEnabled && inserted.rowCount) {
      await pool.query("UPDATE speed_to_lead_events SET auto_text_detail='Auto-text is switched off' WHERE lead_id=$1", [lead.id]);
    }
    opened += inserted.rowCount ?? 0;
  }
  return opened;
}

type Sender = (to: string, body: string) => Promise<{ sid: string; status: string }>;

export async function sendPendingAutoTexts(
  settings: SpeedToLeadSettings,
  now = new Date(),
  send: Sender = sendSms,
): Promise<number> {
  if (!settings.enabled) return 0;
  if (isQuietHours(now, settings.timezone)) return 0; // stay pending until morning
  // Claim before network I/O so two processes (or a slow tick) never double-send.
  const claimed = await pool.query(
    `UPDATE speed_to_lead_events SET auto_text_status='sending'
      WHERE lead_id IN (
        SELECT lead_id FROM speed_to_lead_events WHERE auto_text_status='pending'
        ORDER BY lead_created_at LIMIT 10 FOR UPDATE SKIP LOCKED)
      RETURNING lead_id, contact_id, lead_created_at, first_contact_at`,
  );
  let sent = 0;
  for (const event of claimed.rows) {
    const finish = (status: "sent" | "skipped" | "failed", detail: string) => pool.query(
      `UPDATE speed_to_lead_events SET auto_text_status=$2, auto_text_detail=$3,
         auto_text_sent_at=CASE WHEN $2='sent' THEN NOW() ELSE auto_text_sent_at END
       WHERE lead_id=$1`,
      [event.lead_id, status, detail],
    );
    try {
      if (!settings.autoTextEnabled) { await finish("skipped", "Auto-text is switched off"); continue; }
      if (event.first_contact_at) { await finish("skipped", "A team member already reached out"); continue; }
      if (now.getTime() - new Date(event.lead_created_at).getTime() > AUTO_TEXT_MAX_AGE_HOURS * 3_600_000) {
        await finish("skipped", "Lead was too old by the time texting was allowed"); continue;
      }
      if (!event.contact_id) { await finish("skipped", "Lead has no contact"); continue; }
      const contact = (await pool.query(
        `SELECT c.full_name, c.company, c.mobile_phone, l.service_type
           FROM crm_contacts c JOIN crm_leads l ON l.contact_id = c.id
          WHERE c.id=$1 AND l.id=$2`, [event.contact_id, event.lead_id])).rows[0];
      const phone = contact?.mobile_phone ? toValidE164(contact.mobile_phone) : null;
      if (!phone) { await finish("skipped", "No valid mobile number"); continue; }
      const consent = await getSmsConsentEligibility(phone, event.contact_id, "service");
      if (!consent.eligible) { await finish("skipped", consent.reason || "No SMS consent"); continue; }
      if (send === sendSms && !(await isTwilioConfigured())) { await finish("failed", "Twilio is not configured"); continue; }
      const body = renderAutoText(settings.autoTextTemplate, {
        firstName: firstNameOf(contact.full_name), company: contact.company, service: contact.service_type,
      });
      const result = await send(phone, body);
      await finish("sent", `Submitted to Twilio (${result.status})`);
      sent++;
      await pool.query(
        `INSERT INTO crm_interactions (type, summary, contact_id, lead_id, details, performed_by)
         VALUES ('sms', 'Speed to Lead instant text', $1, $2, $3, 'speed_to_lead')`,
        [event.contact_id, event.lead_id, body],
      ).catch(() => undefined);
    } catch (error) {
      // Outcome unknown: never retry automatically.
      logger.warn({ leadId: event.lead_id, error: (error as Error).message }, "speed-to-lead: auto text failed");
      await finish("failed", "Text could not be submitted; it will not be retried automatically").catch(() => undefined);
    }
  }
  return sent;
}

/** Stops the clock for every open lead that a human has now contacted. */
export async function detectFirstContacts(): Promise<number> {
  const automated = [...AUTOMATED_PERFORMERS];
  const types = [...FIRST_CONTACT_INTERACTION_TYPES];
  const result = await pool.query(
    `WITH open_events AS (
       SELECT e.lead_id, e.contact_id, e.lead_created_at, l.status, l.updated_at, c.mobile_phone, c.office_phone
         FROM speed_to_lead_events e
         JOIN crm_leads l ON l.id = e.lead_id
         LEFT JOIN crm_contacts c ON c.id = e.contact_id
        WHERE e.first_contact_at IS NULL AND e.lead_created_at > NOW() - INTERVAL '14 days'
     ),
     touches AS (
       SELECT o.lead_id, t.at, t.who, t.kind
         FROM open_events o
         CROSS JOIN LATERAL (
           SELECT i.created_at AS at, COALESCE(i.performed_by, 'staff') AS who, i.type AS kind
             FROM crm_interactions i
            WHERE (i.lead_id = o.lead_id OR (o.contact_id IS NOT NULL AND i.contact_id = o.contact_id))
              AND i.type = ANY($1::text[])
              AND COALESCE(i.performed_by, '') <> ALL($2::text[])
              AND i.created_at >= o.lead_created_at
           UNION ALL
           SELECT s.created_at, COALESCE(s.sent_by_name, s.sent_by_user_id), 'sms'
             FROM sms_messages s
            WHERE s.direction = 'outbound' AND s.sent_by_user_id IS NOT NULL
              AND s.created_at >= o.lead_created_at
              AND ${normalizedPhoneSql("s.to_number")} IN (${normalizedPhoneSql("o.mobile_phone")}, ${normalizedPhoneSql("o.office_phone")})
           UNION ALL
           SELECT oc.created_at, oc.user_id, 'call_out'
             FROM outbound_call_outcomes oc
            WHERE o.contact_id IS NOT NULL AND oc.contact_id = o.contact_id AND oc.created_at >= o.lead_created_at
           UNION ALL
           SELECT o.updated_at, 'staff', 'status_change'
            WHERE o.status <> 'new' AND o.updated_at IS NOT NULL
         ) t
     ),
     firsts AS (
       SELECT DISTINCT ON (lead_id) lead_id, at, who, kind FROM touches ORDER BY lead_id, at
     )
     UPDATE speed_to_lead_events e
        SET first_contact_at = GREATEST(f.at, e.lead_created_at), first_contact_by = f.who, first_contact_kind = f.kind
       FROM firsts f
      WHERE e.lead_id = f.lead_id AND e.first_contact_at IS NULL`,
    [types, automated],
  );
  return result.rowCount ?? 0;
}

export async function escalateWaitingLeads(
  settings: SpeedToLeadSettings,
  now = new Date(),
  sendStaffSms: (to: string, body: string) => Promise<unknown> = sendSms,
): Promise<number> {
  if (!settings.enabled) return 0;
  if (!settings.escalateSlack && settings.escalationPhones.length === 0) return 0;
  if (!isWithinBusinessHours(now, hoursFor(settings))) return 0;
  const due = await pool.query(
    `SELECT e.lead_id, e.lead_created_at, e.first_contact_at, e.escalated_at
       FROM speed_to_lead_events e
      WHERE e.first_contact_at IS NULL AND e.escalated_at IS NULL
        AND e.lead_created_at > NOW() - INTERVAL '3 days'
      ORDER BY e.lead_created_at LIMIT 20`,
  );
  let escalated = 0;
  for (const row of due.rows) {
    const event = { leadCreatedAt: new Date(row.lead_created_at), firstContactAt: null, escalatedAt: null };
    if (!shouldEscalate(event, settings.targetMinutes, now)) continue;
    const claimed = await pool.query(
      `UPDATE speed_to_lead_events SET escalated_at = NOW()
        WHERE lead_id=$1 AND escalated_at IS NULL AND first_contact_at IS NULL RETURNING lead_id`, [row.lead_id]);
    if (!claimed.rowCount) continue;
    escalated++;
    const lead = (await pool.query(
      `SELECT l.service_type, c.full_name, c.mobile_phone, c.email
         FROM crm_leads l LEFT JOIN crm_contacts c ON c.id = l.contact_id WHERE l.id=$1`, [row.lead_id])).rows[0] ?? {};
    const waitingMinutes = Math.round((now.getTime() - event.leadCreatedAt.getTime()) / 60_000);
    const name = lead.full_name || `Lead #${row.lead_id}`;
    if (settings.escalateSlack) {
      await queueSpeedToLeadEscalation({
        leadId: row.lead_id, name, contact: lead.mobile_phone || lead.email || "No contact info",
        service: lead.service_type || "Unknown", waitingMinutes, targetMinutes: settings.targetMinutes,
      });
    }
    // Internal alert to staff phones only; no customer details beyond name/service.
    for (const phone of settings.escalationPhones) {
      const to = toValidE164(phone);
      if (!to) continue;
      await sendStaffSms(to, `CSD Speed to Lead: ${name} (${lead.service_type || "new lead"}) has waited ${waitingMinutes} min with no contact. Open Sales Agents > Speed to Lead.`)
        .catch((error) => logger.warn({ error: (error as Error).message }, "speed-to-lead: staff alert text failed"));
    }
  }
  return escalated;
}

let running = false;
let timer: NodeJS.Timeout | null = null;

export async function runSpeedToLeadTick(now = new Date()): Promise<void> {
  if (running) return;
  running = true;
  try {
    const settings = await getSpeedToLeadSettings();
    if (!settings.enabled) return;
    await openSpeedToLeadClocks(settings);
    await detectFirstContacts();
    await sendPendingAutoTexts(settings, now);
    await escalateWaitingLeads(settings, now);
  } catch (error) {
    logger.warn({ error: (error as Error).message }, "speed-to-lead: tick failed");
  } finally {
    running = false;
  }
}

export function startSpeedToLeadWorker(): void {
  if (timer) return;
  timer = setInterval(() => void runSpeedToLeadTick(), TICK_MS);
  timer.unref?.();
}

// ---------------------------------------------------------------------------
// Queue / metrics (shared with the Executive Assistant and Aria)
// ---------------------------------------------------------------------------

export async function getSpeedToLeadQueue(limit = 50) {
  const settings = await getSpeedToLeadSettings();
  const { rows } = await pool.query(
    `SELECT e.*, l.service_type, l.source, l.status AS lead_status, c.full_name, c.company, c.mobile_phone, c.email
       FROM speed_to_lead_events e
       JOIN crm_leads l ON l.id = e.lead_id
       LEFT JOIN crm_contacts c ON c.id = e.contact_id
      WHERE e.lead_created_at > NOW() - INTERVAL '30 days'
      ORDER BY (e.first_contact_at IS NULL) DESC, e.lead_created_at DESC
      LIMIT $1`, [limit]);
  const now = Date.now();
  const leads = rows.map((r: any) => ({
    leadId: r.lead_id,
    contactId: r.contact_id,
    name: r.full_name || `Lead #${r.lead_id}`,
    company: r.company,
    phone: r.mobile_phone,
    email: r.email,
    serviceType: r.service_type,
    source: r.source,
    leadStatus: r.lead_status,
    leadCreatedAt: new Date(r.lead_created_at).toISOString(),
    waitingMinutes: r.first_contact_at ? null : Math.round((now - new Date(r.lead_created_at).getTime()) / 60_000),
    responseMinutes: r.first_contact_at
      ? Math.round(((new Date(r.first_contact_at).getTime() - new Date(r.lead_created_at).getTime()) / 60_000) * 10) / 10
      : null,
    overdue: !r.first_contact_at && now - new Date(r.lead_created_at).getTime() >= settings.targetMinutes * 60_000,
    autoTextStatus: r.auto_text_status,
    autoTextDetail: r.auto_text_detail,
    firstContactAt: r.first_contact_at ? new Date(r.first_contact_at).toISOString() : null,
    firstContactBy: r.first_contact_by,
    firstContactKind: r.first_contact_kind,
    escalatedAt: r.escalated_at ? new Date(r.escalated_at).toISOString() : null,
  }));
  const metrics = summarizeSpeedToLead(rows.map((r: any) => ({
    leadCreatedAt: new Date(r.lead_created_at),
    firstContactAt: r.first_contact_at ? new Date(r.first_contact_at) : null,
    autoTextStatus: r.auto_text_status,
    escalatedAt: r.escalated_at ? new Date(r.escalated_at) : null,
  })), settings.targetMinutes);
  return { settings, leads, metrics };
}

function publicSettings(settings: SpeedToLeadSettings) {
  return {
    ...settings,
    enabledAt: settings.enabledAt?.toISOString() ?? null,
    updatedAt: settings.updatedAt?.toISOString() ?? null,
  };
}

function actorName(req: Request): string {
  const user: any = req.dbUser;
  return [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.email || "staff";
}

export function registerSpeedToLeadRoutes(app: Express): void {
  app.get("/api/crm/speed-to-lead", async (_req, res) => {
    try {
      const { settings, leads, metrics } = await getSpeedToLeadQueue();
      res.json({
        settings: publicSettings(settings),
        leads,
        metrics,
        twilioConfigured: await isTwilioConfigured(),
        preview: renderAutoText(settings.autoTextTemplate, { firstName: "Maria", service: "Computer Repair" }),
      });
    } catch (error) {
      logger.error({ error }, "speed-to-lead: load failed");
      res.status(500).json({ message: "Speed to Lead could not be loaded." });
    }
  });

  // Owner-only (security.ts): this decides whether customers get automatic texts.
  app.put("/api/crm/speed-to-lead/settings", async (req, res) => {
    const parsed = settingsInput.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ message: "Check the settings and try again." }); return; }
    const input = parsed.data;
    const templateError = validateAutoTextTemplate(input.autoTextTemplate);
    if (templateError) { res.status(400).json({ message: templateError }); return; }
    if (input.businessEndHour <= input.businessStartHour) { res.status(400).json({ message: "Business hours must end after they start." }); return; }
    try { new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }); } catch {
      res.status(400).json({ message: "Unknown time zone." }); return;
    }
    const phones = input.escalationPhones.map((p) => toValidE164(p));
    if (phones.some((p) => !p)) { res.status(400).json({ message: "One of the escalation phone numbers is not valid." }); return; }
    await getSpeedToLeadSettings();
    await pool.query(
      `UPDATE speed_to_lead_settings SET
         enabled=$1,
         -- The clock only covers leads created after the automation is switched on.
         enabled_at = CASE WHEN $1 AND NOT enabled THEN NOW() WHEN NOT $1 THEN NULL ELSE enabled_at END,
         auto_text_enabled=$2, auto_text_template=$3, target_minutes=$4, escalate_slack=$5,
         escalation_phones=$6, business_hours_only=$7, business_start_hour=$8, business_end_hour=$9,
         business_days=$10, timezone=$11, excluded_sources=$12, updated_by=$13, updated_at=NOW()
       WHERE id=1`,
      [input.enabled, input.autoTextEnabled, input.autoTextTemplate.trim(), input.targetMinutes, input.escalateSlack,
        phones.join(","), input.businessHoursOnly, input.businessStartHour, input.businessEndHour,
        [...new Set(input.businessDays)].sort().join(","), input.timezone,
        [...new Set(["lead_gen_agent", ...input.excludedSources])].join(","), req.dbUser?.id ?? null],
    );
    res.json({ settings: publicSettings(await getSpeedToLeadSettings()) });
  });

  // Record a contact that happened outside the app (e.g. from a personal phone).
  app.post("/api/crm/speed-to-lead/:leadId/contacted", async (req, res) => {
    const leadId = Number(req.params.leadId);
    if (!Number.isInteger(leadId) || leadId <= 0) { res.status(400).json({ message: "Invalid lead." }); return; }
    const who = actorName(req);
    const updated = await pool.query(
      `UPDATE speed_to_lead_events SET first_contact_at=NOW(), first_contact_by=$2, first_contact_kind='manual_contact'
        WHERE lead_id=$1 AND first_contact_at IS NULL RETURNING contact_id`, [leadId, who]);
    if (!updated.rowCount) { res.status(404).json({ message: "This lead is not waiting for a first contact." }); return; }
    await pool.query(
      `INSERT INTO crm_interactions (type, summary, contact_id, lead_id, details, performed_by)
       VALUES ('manual_contact', 'First contact recorded (Speed to Lead)', $1, $2, NULL, $3)`,
      [updated.rows[0].contact_id, leadId, who],
    ).catch(() => undefined);
    res.json({ ok: true });
  });
}
