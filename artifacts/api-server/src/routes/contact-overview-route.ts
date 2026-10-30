import type { Express } from "express";
import { pool } from "../db";
import { storage } from "../storage";
import { getStaffAssignmentScope } from "../staff-access";
import { isAdminUser } from "../security";
import { logger } from "../lib/logger";
import { getClientAvatarSummary } from "../customer-photos";
import {
  overviewContact,
  overviewJob,
  overviewInvoice,
  overviewAppointment,
} from "../client-overview";

export type ContactOverviewRouteOptions = {
  canSeeClient: (scope: Awaited<ReturnType<typeof getStaffAssignmentScope>>, clientId: number | null | undefined) => boolean;
  canSeeContact: (scope: Awaited<ReturnType<typeof getStaffAssignmentScope>>, contactId: number | null | undefined) => boolean;
};

export function registerContactOverviewRoute(app: Express, options: ContactOverviewRouteOptions): void {
  app.get("/api/clients/:id/overview", async (req, res): Promise<void> => {
    try {
      const clientId = Number(req.params.id);
      if (!Number.isSafeInteger(clientId) || clientId < 1) {
        res.status(400).json({ error: "Invalid client id" });
        return;
      }
      const client = await storage.getClient(clientId);
      const scope = await getStaffAssignmentScope(req);
      if (!client || !options.canSeeClient(scope, clientId)) {
        res.status(404).json({ error: "Client not found" });
        return;
      }
      const [contacts, devices, alerts, tickets, jobs, appointments] = await Promise.all([
        storage.getCrmContacts(), storage.getDevices(), storage.getActiveAlerts(), storage.getTickets(),
        storage.getCrmJobs(), storage.getAppointments(),
      ]);
      const relatedContacts = contacts.filter((contact) =>
        contact.clientId === clientId && options.canSeeContact(scope, contact.id)
      );
      const contactIds = new Set(relatedContacts.map((contact) => contact.id));
      const canonicalPhone = (value: string | null | undefined) => {
        const raw = String(value ?? "").trim();
        const digits = raw.replace(/\D/g, "");
        if (digits.length === 10) return `1${digits}`;
        if (digits.length >= 8 && digits.length <= 15 && (raw.startsWith("+") || (digits.length === 11 && digits.startsWith("1")))) return digits;
        return null;
      };
      const globalPhoneOwners = new Map<string, Set<number>>();
      const globalEmailOwners = new Map<string, Set<number>>();
      for (const contact of contacts) {
        for (const phone of [contact.mobilePhone, contact.officePhone]) {
          const normalized = canonicalPhone(phone);
          if (!normalized) continue;
          const owners = globalPhoneOwners.get(normalized) ?? new Set<number>();
          owners.add(contact.id);
          globalPhoneOwners.set(normalized, owners);
        }
        const email = contact.email?.trim().toLowerCase();
        if (email) {
          const owners = globalEmailOwners.get(email) ?? new Set<number>();
          owners.add(contact.id);
          globalEmailOwners.set(email, owners);
        }
      }
      const phoneToContactId = new Map<string, number>();
      const intakeEmails: string[] = [];
      for (const [phone, owners] of globalPhoneOwners) {
        if (owners.size !== 1) continue;
        const [ownerId] = owners;
        if (contactIds.has(ownerId)) phoneToContactId.set(phone, ownerId);
      }
      for (const [email, owners] of globalEmailOwners) {
        if (owners.size !== 1) continue;
        const [ownerId] = owners;
        if (contactIds.has(ownerId)) intakeEmails.push(email);
      }
      const phoneDigits = [...phoneToContactId.keys()];
      const relatedJobs = jobs.filter((job) => job.contactId != null && contactIds.has(job.contactId));
      const [invoiceResult] = await Promise.all([
        pool.query("SELECT id, invoice_number, contact_id, client_id, job_id, status, currency, total_cents, due_date, sent_at, paid_at, created_at FROM invoices WHERE client_id=$1 OR (client_id IS NULL AND contact_id = ANY($2::int[])) ORDER BY created_at DESC", [clientId, [...contactIds]]),
      ]);
      const relatedAppointments = appointments.filter((appointment) => appointment.contactId != null && contactIds.has(appointment.contactId));
      const contactIdList = [...contactIds];
      const [leadResult, dealResult, intakeResult] = contactIdList.length
        ? await Promise.all([
            pool.query(
              `SELECT id, contact_id, service_type, device_type, brand_model, operating_system,
                      status, source, campaign, estimated_value, intake_record_id, created_at
               FROM crm_leads WHERE contact_id = ANY($1::int[]) ORDER BY created_at DESC`,
              [contactIdList],
            ),
            pool.query(
              `SELECT id, title, stage, estimated_mrr, one_time_fee, primary_contact_id, lead_id, created_at
               FROM crm_deals WHERE primary_contact_id = ANY($1::int[]) ORDER BY created_at DESC`,
              [contactIdList],
            ),
            pool.query(
              `SELECT r.id, r.service_type, r.device_type, r.device_brand_model, r.status,
                      r.source, r.how_did_you_hear, r.created_at
               FROM csd_intake_records r
               WHERE EXISTS (
                       SELECT 1 FROM intake_submissions s
                       WHERE s.intake_record_id = r.id AND s.contact_id = ANY($1::int[])
                     )
                  OR LOWER(TRIM(r.email_address)) = ANY($2::text[])
                  OR CASE
                       WHEN LENGTH(regexp_replace(r.phone_number, '[^0-9]', '', 'g')) = 10
                         THEN '1' || regexp_replace(r.phone_number, '[^0-9]', '', 'g')
                       ELSE regexp_replace(r.phone_number, '[^0-9]', '', 'g')
                     END = ANY($3::text[])
               ORDER BY r.created_at DESC`,
              [contactIdList, intakeEmails, phoneDigits],
            ),
          ])
        : [{ rows: [] as any[] }, { rows: [] as any[] }, { rows: [] as any[] }];
      const relatedLeads = leadResult.rows.map((row) => ({
        id: Number(row.id), contactId: row.contact_id == null ? null : Number(row.contact_id),
        serviceType: row.service_type, deviceType: row.device_type, brandModel: row.brand_model,
        operatingSystem: row.operating_system, status: row.status, source: row.source, campaign: row.campaign,
        estimatedValue: row.estimated_value == null ? null : Number(row.estimated_value),
        intakeRecordId: row.intake_record_id == null ? null : Number(row.intake_record_id), createdAt: row.created_at,
      }));
      const relatedDeals = dealResult.rows.map((row) => ({
        id: Number(row.id), title: row.title, stage: row.stage, estimatedMrr: row.estimated_mrr,
        oneTimeFee: row.one_time_fee, primaryContactId: row.primary_contact_id == null ? null : Number(row.primary_contact_id),
        leadId: row.lead_id == null ? null : Number(row.lead_id), createdAt: row.created_at,
      }));
      const relatedIntakes = intakeResult.rows.map((row) => ({
        id: Number(row.id), serviceType: row.service_type, deviceType: row.device_type,
        deviceBrandModel: row.device_brand_model, status: row.status, source: row.source,
        howDidYouHear: row.how_did_you_hear, createdAt: row.created_at,
      }));
      const compactDevices = devices.filter((device) => device.clientId === clientId).map((device) => ({ id: device.id, name: device.name, type: device.type, status: device.status, lastSeen: device.lastSeen }));
      const compactAlerts = alerts.filter((alert) => alert.clientId === clientId || (alert.deviceId != null && compactDevices.some((device) => device.id === alert.deviceId))).map((alert) => ({ id: alert.id, title: alert.title, severity: alert.severity, status: alert.status, deviceId: alert.deviceId, createdAt: alert.createdAt }));
      const compactTickets = tickets.filter((ticket) => ticket.clientId === clientId).map((ticket) => ({ id: ticket.id, ticketNumber: ticket.ticketNumber, subject: ticket.subject, priority: ticket.priority, status: ticket.status, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt }));
      const jobIds = relatedJobs.map((job) => job.id);
      const canViewCommunications = isAdminUser(req);
      const noRows = { rows: [] as any[] };
      const [callResult, smsResult, interactionResult, serviceLogResult] = await Promise.all([
        canViewCommunications ? pool.query(`SELECT id, call_sid, from_number, to_number, status, direction, duration_seconds, had_voicemail, contact_id, created_at FROM call_log WHERE contact_id = ANY($1::int[]) OR CASE WHEN LENGTH(regexp_replace(from_number, '[^0-9]', '', 'g')) = 10 THEN '1' || regexp_replace(from_number, '[^0-9]', '', 'g') ELSE regexp_replace(from_number, '[^0-9]', '', 'g') END = ANY($2::text[]) OR CASE WHEN LENGTH(regexp_replace(to_number, '[^0-9]', '', 'g')) = 10 THEN '1' || regexp_replace(to_number, '[^0-9]', '', 'g') ELSE regexp_replace(to_number, '[^0-9]', '', 'g') END = ANY($2::text[]) ORDER BY created_at DESC LIMIT 200`, [[...contactIds], phoneDigits]) : noRows,
        canViewCommunications ? pool.query(`SELECT id, message_sid, from_number, to_number, body, direction, status, created_at FROM sms_messages WHERE CASE WHEN LENGTH(regexp_replace(from_number, '[^0-9]', '', 'g')) = 10 THEN '1' || regexp_replace(from_number, '[^0-9]', '', 'g') ELSE regexp_replace(from_number, '[^0-9]', '', 'g') END = ANY($1::text[]) OR CASE WHEN LENGTH(regexp_replace(to_number, '[^0-9]', '', 'g')) = 10 THEN '1' || regexp_replace(to_number, '[^0-9]', '', 'g') ELSE regexp_replace(to_number, '[^0-9]', '', 'g') END = ANY($1::text[]) ORDER BY created_at DESC LIMIT 200`, [phoneDigits]) : noRows,
        pool.query(`SELECT id, contact_id, job_id, type, summary, details, performed_by, created_at FROM crm_interactions WHERE contact_id = ANY($1::int[]) OR job_id = ANY($2::int[]) ORDER BY created_at DESC LIMIT 200`, [[...contactIds], jobIds]),
        pool.query(`SELECT id, contact_id, job_id, client_name, device_model, hardware_action, hardware_result, security_action, security_result, optimization_action, optimization_result, technician_notes, performed_by, created_at, updated_at FROM service_logs WHERE contact_id = ANY($1::int[]) OR job_id = ANY($2::int[]) ORDER BY created_at DESC LIMIT 200`, [[...contactIds], jobIds]),
      ]);
      const matchedContactId = (row: any) => {
        if (row.contact_id != null && contactIds.has(Number(row.contact_id))) return Number(row.contact_id);
        for (const phone of [row.from_number, row.to_number]) {
          const normalized = canonicalPhone(phone);
          const id = normalized ? phoneToContactId.get(normalized) : null;
          if (id != null) return id;
        }
        return null;
      };
      const calls = callResult.rows.map((row) => ({ id: Number(row.id), callSid: row.call_sid, fromNumber: row.from_number, toNumber: row.to_number, direction: row.direction, status: row.status, durationSeconds: row.duration_seconds, hadVoicemail: row.had_voicemail, contactId: matchedContactId(row), createdAt: row.created_at }));
      const messages = smsResult.rows.map((row) => ({ id: Number(row.id), messageSid: row.message_sid, fromNumber: row.from_number, toNumber: row.to_number, body: row.body, direction: row.direction, status: row.status, contactId: matchedContactId(row), createdAt: row.created_at }));
      const interactions = interactionResult.rows.map((row) => ({ id: Number(row.id), contactId: row.contact_id == null ? null : Number(row.contact_id), jobId: row.job_id == null ? null : Number(row.job_id), type: row.type, summary: row.summary, details: row.details, performedBy: row.performed_by, createdAt: row.created_at }));
      const serviceLogs = serviceLogResult.rows.map((row) => ({ id: Number(row.id), contactId: row.contact_id == null ? null : Number(row.contact_id), jobId: row.job_id == null ? null : Number(row.job_id), clientName: row.client_name, deviceModel: row.device_model, hardwareAction: row.hardware_action, hardwareResult: row.hardware_result, securityAction: row.security_action, securityResult: row.security_result, optimizationAction: row.optimization_action, optimizationResult: row.optimization_result, technicianNotes: row.technician_notes, performedBy: row.performed_by, createdAt: row.created_at, updatedAt: row.updated_at }));
      const timeline = [
        ...calls.map((call) => ({ id: `call-${call.id}`, kind: "call", occurredAt: call.createdAt, contactId: call.contactId, title: `${call.direction === "outbound" ? "Outbound" : "Inbound"} call`, summary: call.durationSeconds ? `${call.durationSeconds} seconds` : (call.hadVoicemail ? "Voicemail received" : null), status: call.status, sourceId: call.id, href: "/admin/call-tracking" })),
        ...messages.map((message) => ({ id: `sms-${message.id}`, kind: "sms", occurredAt: message.createdAt, contactId: message.contactId, title: `${message.direction === "outbound" ? "Outbound" : "Inbound"} SMS`, summary: message.body, status: message.status, sourceId: message.id, href: "/messages" })),
        ...interactions.map((item) => ({ id: `interaction-${item.id}`, kind: "interaction", occurredAt: item.createdAt, contactId: item.contactId, title: item.type.replace(/_/g, " "), summary: item.summary || item.details, status: null, sourceId: item.id, href: "/crm/contacts" })),
        ...serviceLogs.map((log) => ({ id: `service-log-${log.id}`, kind: "service_log", occurredAt: log.createdAt, contactId: log.contactId, title: `Service log: ${log.deviceModel}`, summary: log.technicianNotes || log.hardwareAction || log.securityAction || log.optimizationAction, status: null, sourceId: log.id, href: "/service-logs" })),
        ...relatedJobs.map((job) => ({ id: `job-${job.id}`, kind: "job", occurredAt: job.createdAt, contactId: job.contactId, title: job.jobNumber || job.serviceType, summary: job.description ?? null, status: job.status, sourceId: job.id, href: "/crm/jobs" })),
        ...compactTickets.map((ticket) => ({ id: `ticket-${ticket.id}`, kind: "ticket", occurredAt: ticket.createdAt, contactId: null, title: ticket.subject, summary: ticket.ticketNumber ?? null, status: ticket.status, sourceId: ticket.id, href: "/tickets" })),
        ...relatedAppointments.map((appointment) => ({ id: `appointment-${appointment.id}`, kind: "appointment", occurredAt: appointment.startsAt || appointment.createdAt, contactId: appointment.contactId, title: `Appointment ${appointment.reference}`, summary: appointment.customerNotes ?? null, status: appointment.status, sourceId: appointment.id, href: "/scheduling" })),
        ...invoiceResult.rows.map((invoice) => ({ id: `invoice-${invoice.id}`, kind: "invoice", occurredAt: invoice.created_at, contactId: invoice.contact_id == null ? null : Number(invoice.contact_id), title: `Invoice ${invoice.invoice_number}`, summary: `${invoice.currency} ${(Number(invoice.total_cents) / 100).toFixed(2)}`, status: invoice.status, sourceId: Number(invoice.id), href: `/invoices/${invoice.id}` })),
        ...relatedIntakes.map((intake) => ({ id: `intake-${intake.id}`, kind: "intake", occurredAt: intake.createdAt, contactId: null, title: `Intake: ${intake.serviceType}`, summary: intake.deviceBrandModel || intake.deviceType, status: intake.status, sourceId: intake.id, href: "/crm/leads" })),
      ].filter((event) => event.occurredAt != null).sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()).slice(0, 100);
      const now = Date.now();
      const outstandingActions = [
        ...compactAlerts.map((alert) => ({ id: `alert-${alert.id}`, kind: "alert", title: alert.title, summary: null, priority: alert.severity, dueAt: null, status: alert.status, href: "/dashboard" })),
        ...tickets.filter((ticket) => ticket.clientId === clientId && !["closed", "resolved"].includes(ticket.status.toLowerCase())).map((ticket) => ({ id: `ticket-${ticket.id}`, kind: "ticket", title: ticket.subject, summary: ticket.description ?? ticket.ticketNumber ?? null, priority: ticket.priority, dueAt: ticket.dueAt ?? ticket.slaDueAt ?? null, status: ticket.status, href: "/tickets" })),
        ...relatedJobs.filter((job) => !["completed", "cancelled"].includes(job.status.toLowerCase())).map((job) => ({ id: `job-${job.id}`, kind: "job", title: job.jobNumber, summary: job.serviceType, priority: job.priority ?? "normal", dueAt: job.scheduledDateTime ?? null, status: job.status, href: "/crm/jobs" })),
        ...relatedAppointments.filter((appointment) => ["pending", "confirmed", "in_progress"].includes(appointment.status) && new Date(appointment.startsAt).getTime() >= now).map((appointment) => ({ id: `appointment-${appointment.id}`, kind: "appointment", title: `Appointment ${appointment.reference}`, summary: appointment.customerNotes ?? null, priority: "normal", dueAt: appointment.startsAt, status: appointment.status, href: "/scheduling" })),
        ...invoiceResult.rows.filter((invoice) => !["paid", "void"].includes(String(invoice.status).toLowerCase())).map((invoice) => ({ id: `invoice-${invoice.id}`, kind: "invoice", title: `Invoice ${invoice.invoice_number}`, summary: `${invoice.currency} ${(Number(invoice.total_cents) / 100).toFixed(2)}`, priority: invoice.due_date && new Date(invoice.due_date).getTime() < now ? "high" : "normal", dueAt: invoice.due_date, status: invoice.status, href: `/invoices/${invoice.id}` })),
      ];
      const avatar = await getClientAvatarSummary(clientId);
      res.json({
        client: { id: client.id, name: client.name, contactEmail: client.contactEmail, contactPhone: client.contactPhone, address: client.address, city: client.city, state: client.state, zipCode: client.zipCode, createdAt: client.createdAt, avatar },
        contacts: relatedContacts.map(overviewContact), devices: compactDevices, activeAlerts: compactAlerts, tickets: compactTickets,
        jobs: relatedJobs.map((job) => overviewJob(job, clientId)), invoices: invoiceResult.rows.map(overviewInvoice),
        appointments: relatedAppointments.map((appointment) => overviewAppointment(appointment, clientId)),
        leads: relatedLeads, deals: relatedDeals, intakes: relatedIntakes, timeline,
        communications: { calls, messages, interactions, serviceLogs, summary: { calls: calls.length, messages: messages.length, interactions: interactions.length, serviceLogs: serviceLogs.length } },
        outstandingActions,
        counts: { contacts: relatedContacts.length, devices: compactDevices.length, activeAlerts: compactAlerts.length, tickets: compactTickets.length, openTickets: compactTickets.filter((ticket) => !["closed", "resolved"].includes(ticket.status.toLowerCase())).length, jobs: relatedJobs.length, invoices: invoiceResult.rowCount ?? invoiceResult.rows.length, appointments: relatedAppointments.length, leads: relatedLeads.length, deals: relatedDeals.length, intakes: relatedIntakes.length },
      });
    } catch (error) {
      logger.error({ error }, "Client overview failed");
      res.status(500).json({ error: "Failed to fetch client overview" });
    }
  });
}