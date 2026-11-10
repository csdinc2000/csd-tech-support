import type { Express } from "express";
import { storage } from "../storage";
import {
  getStaffAccess,
  getStaffAssignmentScope,
  type StaffAssignmentScope,
} from "../staff-access";
import {
  getSmsConsentEligibility as getDefaultSmsConsentEligibility,
  type SmsMessageClass,
} from "../staff-dispatch";
import { getTwilioSettings } from "../twilio-settings-storage";
import { isQuietHours } from "../speed-to-lead";
import { enqueueSmsForwardBroadcast, parseSmsForwardTargets } from "../sms-forward-outbox";
import { toE164 as normalizeE164, toValidE164 } from "../twilio";
import { inboxActor, recordSentBy, sendTeamReply } from "../shared-inbox";

type SmsResult = {
  sid: string;
  from?: string | null;
  to?: string;
  status?: string;
  [key: string]: unknown;
};

export type ContactSmsRouteOptions = {
  sendSms(to: string, body: string): Promise<SmsResult>;
  isTwilioConfigured(): boolean | Promise<boolean>;
  canSeeContact(scope: StaffAssignmentScope, contactId: number | null | undefined): boolean;
  canEditContact(scope: StaffAssignmentScope, contactId: number | null | undefined): boolean;
  getSmsConsentEligibility?(
    phone: string,
    contactId: number,
    messageClass: SmsMessageClass,
  ): Promise<{ eligible: boolean; reason: string | null }>;
};

async function mirrorStaffSmsToForwardingPhones(input: {
  messageSid: string;
  customerNumber: string;
  businessNumber: string;
  body: string;
}): Promise<void> {
  const settings = await getTwilioSettings();
  if (!settings.smsForwardEnabled) return;

  const customerNumber = normalizeE164(input.customerNumber);
  const businessNumber = normalizeE164(input.businessNumber || settings.twilioPhoneNumber);
  const targets = parseSmsForwardTargets(
    settings.smsForwardNumbers,
    settings.smsForwardToNumber,
  ).filter((target) => target !== customerNumber && target !== businessNumber);

  if (!input.messageSid || targets.length === 0) return;

  await enqueueSmsForwardBroadcast({
    inboundMessageSid: input.messageSid,
    sourceNumber: customerNumber,
    businessNumber,
    body: `CSD reply to ${customerNumber}: ${input.body}`,
    targets,
  });
}

export function registerContactSmsRoutes(
  app: Express,
  options: ContactSmsRouteOptions,
): void {
  const {
    sendSms,
    isTwilioConfigured,
    canSeeContact,
    canEditContact,
    getSmsConsentEligibility = getDefaultSmsConsentEligibility,
  } = options;

  app.post("/api/sms/send", async (req, res): Promise<any> => {
    try {
      const { to, body } = req.body ?? {};
      if (!to || !body) {
        res.status(400).json({ error: "to and body are required" });
        return;
      }

      const targetNumber = toValidE164(String(to));
      if (!targetNumber) {
        res.status(400).json({
          error: "Destination phone number must be a valid E.164 number",
        });
        return;
      }
      const contacts = await storage.getCrmContacts();
      const matchingContacts = contacts.filter((contact) =>
        [contact.mobilePhone, contact.officePhone]
          .filter((phone): phone is string => Boolean(phone?.trim()))
          .some((phone) => normalizeE164(phone) === targetNumber)
      );
      const scope = await getStaffAssignmentScope(req);
      if (matchingContacts.some((contact) => !canSeeContact(scope, contact.id))) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      if (matchingContacts.some((contact) => !canEditContact(scope, contact.id))) {
        res.status(403).json({ error: "Contact edit assignment required" });
        return;
      }
      if (matchingContacts.length === 0 && (await getStaffAccess(req)).approvalStatus !== "approved") {
        res.status(403).json({ error: "Approved staff access required" });
        return;
      }
      if (!(await isTwilioConfigured())) {
        res.status(400).json({ error: "Twilio is not configured" });
        return;
      }

      // One central number: every staff text goes out from the business line,
      // even if the customer once texted a tracking number. `from` is ignored.
      const result = await sendTeamReply({
        customerNumber: targetNumber,
        body: String(body),
        sentBy: inboxActor(req),
        sendSms,
      });
      res.json({ success: true, ...result });
    } catch (e: any) {
      console.error("POST /api/sms/send failed:", e);
      res.status(500).json({ success: false, error: e?.message || "Send failed" });
    }
  });

  app.get("/api/sms/bulk-recipients", async (req, res): Promise<any> => {
    try {
      const messageClass = String(req.query.messageClass || "service") as SmsMessageClass;
      if (!["service", "marketing"].includes(messageClass)) {
        res.status(400).json({ error: "messageClass must be service or marketing" });
        return;
      }
      const scope = await getStaffAssignmentScope(req);
      const contacts = (await storage.getCrmContacts()).filter((contact) => canSeeContact(scope, contact.id));
      const recipients = await Promise.all(contacts.map(async (contact) => {
        const mobilePhone = contact.mobilePhone?.trim() || null;
        if (!mobilePhone) {
          return {
            contactId: contact.id,
            name: contact.fullName || contact.company || `Contact ${contact.id}`,
            mobilePhone: null,
            eligible: false,
            reason: "No mobile number",
          };
        }
        if (!toValidE164(mobilePhone)) {
          return {
            contactId: contact.id,
            name: contact.fullName || contact.company || `Contact ${contact.id}`,
            mobilePhone,
            eligible: false,
            reason: "Invalid mobile number",
          };
        }
        const consent = await getSmsConsentEligibility(mobilePhone, contact.id, messageClass);
        return {
          contactId: contact.id,
          name: contact.fullName || contact.company || `Contact ${contact.id}`,
          mobilePhone,
          ...consent,
        };
      }));
      res.json(recipients);
    } catch (e: any) {
      console.error("GET /api/sms/bulk-recipients failed:", e);
      res.status(500).json({ error: e?.message || "Failed to load recipients" });
    }
  });

  app.post("/api/sms/bulk-send", async (req, res): Promise<any> => {
    try {
      const messageClass = String(req.body?.messageClass || "") as SmsMessageClass;
      const body = String(req.body?.body || "").trim();
      const rawIds = Array.isArray(req.body?.contactIds) ? req.body.contactIds : [];
      const contactIds = [...new Set<number>(rawIds.map(Number).filter((id: number): id is number => Number.isSafeInteger(id)))];
      if (!["service", "marketing"].includes(messageClass)) {
        res.status(400).json({ error: "messageClass must be service or marketing" });
        return;
      }
      if (!body) {
        res.status(400).json({ error: "Message body is required" });
        return;
      }
      if (body.length > 1600) {
        res.status(400).json({ error: "Message body is too long" });
        return;
      }
      // Marketing traffic carries TCPA obligations that service traffic does
      // not: visible opt-out wording, and nothing sent during quiet hours.
      // Service messages to consented customers are deliberately unaffected,
      // so an after-hours outage notice still goes out.
      if (messageClass === "marketing") {
        if (!/\bSTOP\b/i.test(body)) {
          res.status(400).json({
            error: "Marketing messages must include opt-out wording, for example: Reply STOP to opt out.",
          });
          return;
        }
        const quietSettings = await getTwilioSettings().catch(() => null);
        const timezone = quietSettings?.businessHoursTimezone || "America/New_York";
        if (isQuietHours(new Date(), timezone)) {
          res.status(409).json({
            error: "Marketing texts are blocked between 9pm and 8am local time.",
          });
          return;
        }
      }

      if (!contactIds.length) {
        res.status(400).json({ error: "Select at least one contact" });
        return;
      }
      if (contactIds.length > 100) {
        res.status(400).json({ error: "Bulk sends are limited to 100 contacts" });
        return;
      }
      if (!(await isTwilioConfigured())) {
        res.status(400).json({ error: "Twilio is not configured" });
        return;
      }

      const results: Array<Record<string, unknown>> = [];
      const deliveredPhones = new Set<string>();
      const scope = await getStaffAssignmentScope(req);
      for (const contactId of contactIds) {
        const contact = await storage.getCrmContact(contactId);
        if (!contact || !canSeeContact(scope, contactId)) {
          results.push({ contactId, status: "skipped", reason: "Contact not found" });
          continue;
        }
        if (!canEditContact(scope, contactId)) {
          results.push({ contactId, status: "skipped", reason: "Contact edit assignment required" });
          continue;
        }
        const mobilePhone = contact?.mobilePhone?.trim();
        if (!contact || !mobilePhone) {
          results.push({ contactId, status: "skipped", reason: "Contact has no mobile number" });
          continue;
        }
        const normalized = toValidE164(mobilePhone);
        if (!normalized) {
          results.push({
            contactId,
            status: "skipped",
            reason: "Contact has an invalid mobile number",
          });
          continue;
        }
        if (deliveredPhones.has(normalized)) {
          results.push({ contactId, status: "skipped", reason: "Duplicate mobile number" });
          continue;
        }
        const consent = await getSmsConsentEligibility(mobilePhone, contact.id, messageClass);
        if (!consent.eligible) {
          results.push({ contactId, status: "skipped", reason: consent.reason });
          continue;
        }
        try {
          const sent = await sendSms(normalized, body);
          deliveredPhones.add(normalized);
          await recordSentBy(sent.sid, inboxActor(req)).catch(() => {});
          await mirrorStaffSmsToForwardingPhones({
            messageSid: sent.sid,
            customerNumber: normalized,
            businessNumber: sent.from || "",
            body,
          }).catch((error) => console.error("[sms-mirror] failed to queue bulk text:", error));
          results.push({ contactId, status: "sent", sid: sent.sid });
        } catch (error: any) {
          results.push({ contactId, status: "failed", reason: error?.message || "Send failed" });
        }
      }
      res.json({
        success: true,
        sent: results.filter((result) => result.status === "sent").length,
        skipped: results.filter((result) => result.status === "skipped").length,
        failed: results.filter((result) => result.status === "failed").length,
        results,
      });
    } catch (e: any) {
      console.error("POST /api/sms/bulk-send failed:", e);
      res.status(500).json({ success: false, error: e?.message || "Bulk send failed" });
    }
  });
}