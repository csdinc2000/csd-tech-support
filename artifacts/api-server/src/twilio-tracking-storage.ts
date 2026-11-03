import { db } from "./db";
import {
  trackingNumbers,
  callFlows,
  smsMessages,
  smsForwardDeliveries,
  callLog,
  crmContacts,
  clients,
  tickets,
  ticketActivity,
  type InsertCrmContact,
  type InsertTicket,
  type TrackingNumber,
  type InsertTrackingNumber,
  type CallFlow,
  type InsertCallFlow,
  type SmsMessage,
  type InsertSmsMessage,
} from "@workspace/db";
import { eq, desc, sql, and, or } from "drizzle-orm";
import { assertValidContactPhones } from "./phone-validation";
import { toValidE164 } from "./phone-validation";
import { matchUniqueCallContact, type CallContactCandidate } from "./call-contact-match";
import { z } from "zod/v4";
import { APPROVED_RECIPIENT, ensureStaffDispatchTables, enqueueStaffEventNotification } from "./staff-dispatch";

export const callTicketIntakeSchema = z.object({
  customerName: z.string().trim().min(1).max(120),
  contactPhone: z.string().trim().refine(value => !!toValidE164(value), "A valid callback phone number is required"),
  company: z.string().trim().max(200).default(""),
  issueSummary: z.string().trim().min(1).max(4000),
  serviceDeliveryType: z.enum(["in-shop", "on-site", "remote"]),
  smsConsent: z.boolean(),
});
export const CALL_INTAKE_SMS_DISCLOSURE = "Do you agree to receive automated text messages from Computer Systems Depot Inc. at this mobile number regarding your service request, including repair/ticket status updates and reminders? Message and data rates may apply. You can reply STOP to unsubscribe at any time.";

export function nextCallIntakeTechnician<T extends { user_id: number }>(available: T[], previousUserId: number): T | undefined {
  const ordered = [...available].sort((a, b) => a.user_id - b.user_id);
  return ordered.find(tech => tech.user_id > previousUserId) ?? ordered[0];
}

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
  proxyDeliveryId?: number,
  proxyDeliveryKind?: "sms-forward" | "staff-client",
): Promise<void> {
  if (!messageSid) return;
  // Persist the carrier error code (e.g. 30034 = unregistered A2P sender) so the
  // Messages UI can explain *why* a text failed instead of just showing "failed".
  await db
    .update(smsMessages)
    .set({ status, ...(errorCode ? { errorCode } : {}) })
    .where(eq(smsMessages.messageSid, messageSid));
  await db
    .update(smsForwardDeliveries)
    .set({
      status,
      providerMessageSid: messageSid,
      ...(errorCode ? { lastError: `Twilio error ${errorCode}` } : {}),
      updatedAt: new Date(),
    })
    .where(
      or(
        eq(smsForwardDeliveries.providerMessageSid, messageSid),
        ...(proxyDeliveryId && proxyDeliveryKind === "sms-forward"
          ? [eq(smsForwardDeliveries.id, proxyDeliveryId)]
          : []),
      ),
    );
  const proxyStatus = status === "delivered"
    ? "delivered"
    : ["failed", "undelivered"].includes(status)
      ? "failed"
      : "pending";
  await db.execute(sql`
    UPDATE staff_dispatch_client_messages
    SET status=CASE
          WHEN status IN ('delivered', 'failed') THEN status
          WHEN ${proxyStatus} IN ('delivered', 'failed') THEN ${proxyStatus}
          ELSE 'pending'
        END,
        provider_message_sid=COALESCE(provider_message_sid, ${messageSid}),
        error=CASE
          WHEN ${proxyStatus} = 'failed'
            THEN COALESCE(${errorCode}, 'Twilio reported delivery failure')
          WHEN status = 'failed' THEN error
          ELSE NULL
        END,
        updated_at=NOW()
    WHERE provider_message_sid=${messageSid}
       OR (${proxyDeliveryKind === "staff-client" ? proxyDeliveryId ?? null : null}::bigint IS NOT NULL
         AND id=${proxyDeliveryKind === "staff-client" ? proxyDeliveryId ?? null : null})
  `);
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

export async function getRecentCalls(limit: number = 100) {
  const result: any = await db.execute(sql`
    SELECT
      cl.id,
      cl.call_sid,
      cl.from_number,
      cl.to_number,
      cl.status,
      cl.direction,
      cl.duration_seconds,
      cl.had_voicemail,
      cl.created_at,
      COALESCE(cl.source_channel, tn.source_channel) AS source_channel,
      tn.campaign_name,
      tn.phone_number AS tracking_number,
      cl.contact_id AS stored_contact_id,
      linked_contact.id AS contact_id,
      linked_contact.full_name AS contact_name,
      linked_contact.company AS contact_company,
      linked_contact.client_id AS client_id,
      customer.name AS client_name,
      linked_ticket.id AS support_ticket_id,
      linked_ticket.ticket_number AS support_ticket_number
    FROM call_log cl
    LEFT JOIN tracking_numbers tn ON tn.id = cl.tracking_number_id
    LEFT JOIN crm_contacts linked_contact ON linked_contact.id = cl.contact_id
    LEFT JOIN clients customer ON customer.id = linked_contact.client_id
    LEFT JOIN tickets linked_ticket ON linked_ticket.id = cl.support_ticket_id
    ORDER BY cl.created_at DESC
    LIMIT ${limit}
  `);
  const rows = result?.rows ?? result ?? [];
  let fallbackContacts: CallContactCandidate[] = [];
  if (rows.some((row: any) => row.stored_contact_id == null)) {
    const contactResult: any = await db.execute(sql`
      SELECT
        cc.id,
        cc.full_name,
        cc.company,
        cc.client_id,
        cc.mobile_phone,
        cc.office_phone,
        customer.name AS client_name
      FROM crm_contacts cc
      LEFT JOIN clients customer ON customer.id = cc.client_id
      WHERE COALESCE(cc.tags, '') <> '__deleted_contact_placeholder__'
        AND (cc.mobile_phone IS NOT NULL OR cc.office_phone IS NOT NULL)
    `);
    fallbackContacts = (contactResult?.rows ?? contactResult ?? []).map((contact: any) => ({
      id: Number(contact.id),
      fullName: contact.full_name,
      company: contact.company,
      clientId: contact.client_id == null ? null : Number(contact.client_id),
      clientName: contact.client_name,
      mobilePhone: contact.mobile_phone,
      officePhone: contact.office_phone,
    }));
  }
  return rows.map((r: any) => {
    const callPhone = r.direction === "outbound" ? r.to_number : r.from_number;
    const fallbackContact = r.stored_contact_id == null
      ? matchUniqueCallContact(callPhone, fallbackContacts)
      : null;
    return {
      id: r.id,
      callSid: r.call_sid,
      fromNumber: r.from_number,
      toNumber: r.to_number,
      status: r.status,
      direction: r.direction,
      durationSeconds: Number(r.duration_seconds ?? 0),
      hadVoicemail: Boolean(r.had_voicemail),
      createdAt: r.created_at,
      sourceChannel: r.source_channel,
      campaignName: r.campaign_name,
      trackingNumber: r.tracking_number,
      contactId: r.contact_id ?? fallbackContact?.id ?? null,
      contactName: r.contact_name ?? fallbackContact?.fullName ?? null,
      contactCompany: r.contact_company ?? fallbackContact?.company ?? null,
      clientId: r.client_id ?? fallbackContact?.clientId ?? null,
      clientName: r.client_name ?? fallbackContact?.clientName ?? null,
      supportTicketId: r.support_ticket_id,
      supportTicketNumber: r.support_ticket_number,
    };
  });
}

export async function getCallForwardingReadContext(callId: number): Promise<{
  callSid: string;
  direction: string | null;
  clientId: number | null;
  contactId: number | null;
} | null> {
  const result: any = await db.execute(sql`
    SELECT cl.call_sid, cl.direction, c.client_id, c.id AS contact_id
    FROM call_log cl
    LEFT JOIN crm_contacts c ON c.id = cl.contact_id
    WHERE cl.id = ${callId}
    LIMIT 1
  `);
  const row = (result?.rows ?? result ?? [])[0];
  if (!row) return null;
  return {
    callSid: String(row.call_sid),
    direction: row.direction == null ? null : String(row.direction),
    clientId: row.client_id == null ? null : Number(row.client_id),
    contactId: row.contact_id == null ? null : Number(row.contact_id),
  };
}

export async function createAndAssociateCallTicket(
  callId: number,
  input: InsertTicket,
  intakeInput?: z.input<typeof callTicketIntakeSchema>,
  dependencies: { notifyStaffEvent?: typeof enqueueStaffEventNotification } = {},
) {
  const intake = intakeInput === undefined ? undefined : callTicketIntakeSchema.parse(intakeInput);
  if (intake) await ensureStaffDispatchTables();
  return db.transaction(async (tx) => {
    const [call] = await tx
      .select({ id: callLog.id, supportTicketId: callLog.supportTicketId })
      .from(callLog)
      .where(eq(callLog.id, callId))
      .limit(1)
      .for("update");
    if (!call) throw new Error("CALL_NOT_FOUND");

    if (call.supportTicketId) {
      const [ticket] = await tx
        .select()
        .from(tickets)
        .where(eq(tickets.id, call.supportTicketId))
        .limit(1);
      if (ticket) return { ticket, created: false, assignedTechName: null, effectiveSmsConsent: undefined };
    }

    let assignedTech: { user_id: number; display_name: string } | undefined;
    let effectiveSmsConsent: boolean | undefined;
    const intakeTimestamp = new Date().toISOString();
    if (intake) {
      // One transaction lock serializes selection and immutable assignment history.
      // Repeated requests for an already-linked call never advance the rotation.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('call_tracking_round_robin'))`);
      const available = await tx.execute<{ user_id: number; display_name: string }>(sql`
        SELECT r.linked_user_id AS user_id, r.display_name
        FROM staff_dispatch_recipients r
        WHERE r.enabled=TRUE AND r.on_duty=TRUE
          AND ${sql.raw(APPROVED_RECIPIENT)}
          AND (r.recipient_role='technician' OR EXISTS (
            SELECT 1 FROM staff_helpdesk_links hl JOIN staff_access_profiles p ON p.user_id=hl.auth_user_id
            WHERE hl.helpdesk_user_id=r.linked_user_id AND p.role='technician' AND p.approval_status='approved'
          ))
          AND (SELECT COUNT(*) FROM staff_helpdesk_links hl WHERE hl.helpdesk_user_id=r.linked_user_id)=1
          AND (SELECT COUNT(*) FROM tickets t WHERE t.assigned_to=r.linked_user_id
            AND t.priority='high' AND t.status IN ('open','in-progress')) < 5
        ORDER BY r.linked_user_id, r.id FOR UPDATE OF r
      `);
      // The existing dispatch audit survives ticket deletion, unlike activity.
      const previous = await tx.execute<{ after_summary: { assignedTo: number } }>(sql`
        SELECT after_summary FROM staff_dispatch_audit
        WHERE actor_type='system' AND action='ticket.round_robin' AND outcome='accepted'
        ORDER BY id DESC LIMIT 1
      `);
      const previousUserId = previous.rows[0]?.after_summary.assignedTo ?? 0;
      assignedTech = nextCallIntakeTechnician(available.rows, previousUserId);

      const phone = toValidE164(intake.contactPhone)!;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${phone}))`);
      const consent = await tx.execute<{ consented: boolean }>(sql`
        INSERT INTO staff_dispatch_sms_consent(phone,consented,updated_at)
        VALUES(${phone},${intake.smsConsent},NOW())
        ON CONFLICT(phone) DO UPDATE SET
          consented=staff_dispatch_sms_consent.consented AND EXCLUDED.consented, updated_at=NOW()
        RETURNING consented
      `);
      effectiveSmsConsent = consent.rows[0].consented;
    }

    const [ticket] = await tx.insert(tickets).values(intake ? {
      ...input,
      source: "phone", status: "open",
      requesterName: intake.customerName,
      requesterPhone: toValidE164(intake.contactPhone)!,
      assignedTo: assignedTech?.user_id ?? null,
      description: [
        input.description,
        `Call intake\nCustomer: ${intake.customerName}\nCallback phone: ${toValidE164(intake.contactPhone)}`,
        `Company/office: ${intake.company || "Not provided"}`,
        `Issue: ${intake.issueSummary}`,
        `Service delivery: ${{ "in-shop": "In-Shop", "on-site": "On-Site Mobile", remote: "Remote Support" }[intake.serviceDeliveryType]}`,
        `Assigned technician: ${assignedTech?.display_name ?? "Unassigned — no eligible technician"}`,
        `SMS consent recorded: ${intake.smsConsent ? "Yes" : "No"}; text updates ${effectiveSmsConsent ? "permitted" : "blocked"}`,
      ].filter(Boolean).join("\n"),
    } : input).returning();
    if (intake) {
      await tx.insert(ticketActivity).values({
        ticketId: ticket.id, actorType: "staff", actorName: "Call Tracking intake", action: "note",
        details: JSON.stringify({
          channel: "call_tracking_intake", callId, ...intake,
          smsConsentGranted: effectiveSmsConsent, smsConsentTimestamp: intakeTimestamp,
          smsConsentMethod: "staff_recorded_verbal", disclosure: CALL_INTAKE_SMS_DISCLOSURE,
        }),
      });
      if (assignedTech) {
        await tx.insert(ticketActivity).values({
          ticketId: ticket.id, actorType: "system", actorName: "Call Tracking intake", action: "assigned",
          details: JSON.stringify({ channel: "call_tracking_round_robin", assignedTo: assignedTech.user_id, assignedTechName: assignedTech.display_name }),
        });
        await tx.execute(sql`
          INSERT INTO staff_dispatch_audit(actor_type,actor_identity,action,outcome,ticket_id,after_summary)
          VALUES('system','call_tracking_intake','ticket.round_robin','accepted',${ticket.id},
            ${JSON.stringify({ assignedTo: assignedTech.user_id })}::jsonb)
        `);
      }
    }
    if (intake) {
      await (dependencies.notifyStaffEvent ?? enqueueStaffEventNotification)({
        kind: "intake", id: `call:${callId}`, ticketId: ticket.id,
      }, tx);
    }
    await (dependencies.notifyStaffEvent ?? enqueueStaffEventNotification)({ kind: "ticket", id: ticket.id }, tx);
    await tx
      .update(callLog)
      .set({ supportTicketId: ticket.id, updatedAt: new Date() })
      .where(eq(callLog.id, callId));
    return { ticket, created: true, assignedTechName: assignedTech?.display_name ?? null, effectiveSmsConsent };
  });
}
export async function createAndAssociateCallContact(
  callId: number,
  input: InsertCrmContact,
) {
  assertValidContactPhones(input);
  return db.transaction(async (tx) => {
    const [call] = await tx
      .select()
      .from(callLog)
      .where(eq(callLog.id, callId))
      .limit(1)
      .for("update");
    if (!call) throw new Error("CALL_NOT_FOUND");
    if (call.contactId) throw new Error("CALL_ALREADY_ASSOCIATED");

    if (input.clientId != null) {
      const [client] = await tx
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.id, input.clientId))
        .limit(1);
      if (!client) throw new Error("CLIENT_NOT_FOUND");
    }

    const [contact] = await tx.insert(crmContacts).values(input).returning();
    await tx
      .update(callLog)
      .set({ contactId: contact.id, updatedAt: new Date() })
      .where(eq(callLog.id, callId));
    return contact;
  });
}
