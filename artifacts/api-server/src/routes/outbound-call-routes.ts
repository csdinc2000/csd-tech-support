// Click-to-call: Twilio rings a staff phone first, the staff member presses 1,
// then Twilio dials the customer from the business line and bridges the two.
// Staff confirm with a keypress so a staff voicemail can never place the call.
import type { Express, Request, Response } from "express";
import twilio from "twilio";
import { storage } from "../storage";
import { getStaffAccess, getStaffAssignmentScope, type StaffAssignmentScope } from "../staff-access";
import { canonicalPublicAppBaseUrl } from "../shared/roip-config";
import { toE164, toValidE164 } from "../phone-validation";
import { configuredForwardTargets } from "../voice-routing";
import type { InsertCallLog } from "@workspace/db";

const { VoiceResponse } = twilio.twiml;

export type OutboundCallRouteOptions = {
  isTwilioConfigured(): boolean | Promise<boolean>;
  getFromNumber(): Promise<string | undefined>;
  /** Staff phones Twilio may ring first; the first entry is the default. */
  getAgentPhones(): Promise<string[]>;
  createCall(input: {
    to: string;
    from: string;
    twiml: string;
    statusCallback: string;
  }): Promise<{ sid: string; status?: string }>;
  recordCall(entry: InsertCallLog): Promise<unknown>;
  canSeeContact(scope: StaffAssignmentScope, contactId: number | null | undefined): boolean;
  canEditContact(scope: StaffAssignmentScope, contactId: number | null | undefined): boolean;
  publicBaseUrl?(): string | null;
  getContacts?(): Promise<Array<{ id: number; fullName?: string | null; company?: string | null; mobilePhone?: string | null; officePhone?: string | null }>>;
  getScope?(req: Request): Promise<StaffAssignmentScope>;
  isApprovedStaff?(req: Request): Promise<boolean>;
};

function defaultPublicBaseUrl(): string | null {
  const configured = canonicalPublicAppBaseUrl(process.env.APP_BASE_URL);
  if (configured.ok) return configured.origin;
  const host = process.env.PUBLIC_BASE_URL || process.env.REPLIT_DEV_DOMAIN;
  if (!host) return null;
  return host.startsWith("http") ? host.replace(/\/+$/, "") : `https://${host}`;
}

export function agentLegTwiml(base: string, customer: string, label: string): string {
  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    numDigits: 1,
    timeout: 10,
    method: "POST",
    action: `${base}/webhooks/voice/outbound-connect?to=${encodeURIComponent(customer)}`,
  });
  gather.say({ voice: "alice" }, `CSD outbound call to ${label}. Press 1 to connect.`);
  twiml.hangup();
  return twiml.toString();
}

export function registerOutboundCallRoutes(app: Express, options: OutboundCallRouteOptions): void {
  const {
    isTwilioConfigured,
    getFromNumber,
    getAgentPhones,
    createCall,
    recordCall,
    canSeeContact,
    canEditContact,
    publicBaseUrl = defaultPublicBaseUrl,
    getContacts = () => storage.getCrmContacts(),
    getScope = getStaffAssignmentScope,
    isApprovedStaff = async (req) => (await getStaffAccess(req)).approvalStatus === "approved",
  } = options;

  app.post("/api/twilio/calls/outbound", async (req: Request, res: Response): Promise<any> => {
    try {
      const { to, contactId: rawContactId, agentPhone } = req.body ?? {};
      if (!to) return res.status(400).json({ error: "to is required" });
      const customer = toValidE164(String(to));
      if (!customer) {
        return res.status(400).json({ error: "Destination phone number must be a valid E.164 number" });
      }

      // Same access rule as staff SMS: every contact on this number must be
      // editable by the caller, and unknown numbers need approved staff.
      const contacts = await getContacts();
      const matching = contacts.filter((contact) =>
        [contact.mobilePhone, contact.officePhone]
          .filter((phone): phone is string => Boolean(phone?.trim()))
          .some((phone) => toE164(phone) === customer),
      );
      const scope = await getScope(req);
      if (matching.some((contact) => !canSeeContact(scope, contact.id))) {
        return res.status(404).json({ error: "Contact not found" });
      }
      if (matching.some((contact) => !canEditContact(scope, contact.id))) {
        return res.status(403).json({ error: "Contact edit assignment required" });
      }
      if (matching.length === 0 && !(await isApprovedStaff(req))) {
        return res.status(403).json({ error: "Approved staff access required" });
      }

      let contactId: number | null = null;
      if (rawContactId != null && rawContactId !== "") {
        contactId = Number(rawContactId);
        if (!matching.some((contact) => contact.id === contactId)) {
          return res.status(400).json({ error: "contactId does not match the destination number" });
        }
      } else if (matching.length === 1) {
        contactId = matching[0].id;
      }

      if (!(await isTwilioConfigured())) return res.status(400).json({ error: "Twilio is not configured" });
      const from = await getFromNumber();
      if (!from) return res.status(400).json({ error: "No business phone number is configured in Phone Settings" });
      const base = publicBaseUrl();
      if (!base) return res.status(500).json({ error: "Public app URL is not configured for Twilio callbacks" });

      // The staff leg may only ring a configured forwarding phone, so this
      // endpoint can't be used to connect two arbitrary outside numbers.
      const agentPhones = await getAgentPhones();
      if (agentPhones.length === 0) {
        return res.status(400).json({ error: "No staff forwarding phone is configured in Phone Settings" });
      }
      const agent = agentPhone ? toValidE164(String(agentPhone)) : agentPhones[0];
      if (!agent || !agentPhones.includes(agent)) {
        return res.status(400).json({ error: "agentPhone must be one of the configured forwarding phones" });
      }
      if (agent === customer) return res.status(400).json({ error: "Cannot call the staff phone itself" });

      const contact = matching.find((c) => c.id === contactId);
      const label = contact?.fullName || contact?.company || customer.replace(/\D/g, "").split("").join(" ");
      const call = await createCall({
        to: agent,
        from,
        twiml: agentLegTwiml(base, customer, label),
        statusCallback: `${base}/webhooks/voice/status`,
      });

      // Log against the customer, not the staff leg; later status callbacks
      // only update status and duration on this row.
      await recordCall({
        callSid: call.sid,
        fromNumber: from,
        toNumber: customer,
        status: call.status || "queued",
        direction: "outbound",
        durationSeconds: 0,
        hadVoicemail: false,
        contactId,
      }).catch((error) => console.error("[outbound-call] call log insert failed:", error));

      res.json({ success: true, sid: call.sid, to: customer, agentPhone: agent, contactId });
    } catch (e: any) {
      console.error("POST /api/twilio/calls/outbound failed:", e);
      res.status(500).json({ success: false, error: e?.message || "Call failed" });
    }
  });

  // Reached only through the Twilio signature boundary on /webhooks, and the
  // signed URL covers the `to` query parameter, so it can't be retargeted.
  app.post("/webhooks/voice/outbound-connect", async (req: Request, res: Response) => {
    const twiml = new VoiceResponse();
    const customer = toValidE164(String(req.query?.to || ""));
    const from = await getFromNumber().catch(() => undefined);
    if (req.body?.Digits === "1" && customer && from) {
      twiml.say({ voice: "alice" }, "Connecting.");
      twiml.dial({ callerId: from, timeout: 30 }).number(customer);
    } else {
      twiml.hangup();
    }
    res.type("text/xml").send(twiml.toString());
  });
}

export async function defaultAgentPhones(
  getSettings: () => Promise<Parameters<typeof configuredForwardTargets>[0]>,
): Promise<string[]> {
  return configuredForwardTargets(await getSettings()).map((target) => target.number);
}
