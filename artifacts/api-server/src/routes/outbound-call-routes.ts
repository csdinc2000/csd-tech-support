// Click-to-call: Twilio rings a staff phone first, the staff member presses 1,
// then Twilio dials the customer from the business line and bridges the two.
// Staff confirm with a keypress so a staff voicemail can never place the call.
import type { Express, Request, Response } from "express";
import twilio from "twilio";
import { randomUUID } from "node:crypto";
import {
  getStaffAccess,
  getStaffAccessForUserId,
  getStaffAssignmentScope,
  getStaffAssignmentScopeForUserId,
  type StaffAssignmentScope,
} from "../staff-access";
import { canonicalPublicAppBaseUrl } from "../shared/roip-config";
import { toValidE164 } from "../phone-validation";
import { configuredForwardTargets } from "../voice-routing";
import type { InsertCallLog } from "@workspace/db";
import { authorizeOutboundCallTarget } from "../outbound-call-authorization";
import {
  createOutboundCallOutcome,
  getOutboundCallOutcome,
  updateOutboundCallOutcome,
  type OutboundCallOutcome,
} from "../outbound-call-outcomes";
import { logger } from "../lib/logger";
import { rateLimit } from "../security";

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
  getActorUserId?(req: Request): string | null;
  getScopeForUserId?(userId: string): Promise<StaffAssignmentScope>;
  isApprovedStaffForUserId?(userId: string): Promise<boolean>;
  createOutcome?(input: Parameters<typeof createOutboundCallOutcome>[0]): Promise<void>;
  updateOutcome?(
    callId: string,
    patch: Parameters<typeof updateOutboundCallOutcome>[1],
  ): Promise<void>;
  getOutcome?(callId: string): Promise<OutboundCallOutcome | null>;
};

function defaultPublicBaseUrl(): string | null {
  const configured = canonicalPublicAppBaseUrl(process.env.APP_BASE_URL);
  if (configured.ok) return configured.origin;
  if (process.env.NODE_ENV === "production") return null;
  const host = process.env.PUBLIC_BASE_URL || process.env.REPLIT_DEV_DOMAIN;
  if (!host) return null;
  return host.startsWith("http") ? host.replace(/\/+$/, "") : `https://${host}`;
}

function callbackUrl(base: string, path: string, callId: string): string {
  const url = new URL(`${base}${path}`);
  url.searchParams.set("callId", callId);
  return url.toString();
}

export function agentLegTwiml(base: string, customer: string, label: string, callId: string): string {
  const twiml = new VoiceResponse();
  const action = new URL(`${base}/webhooks/voice/outbound-connect`);
  action.searchParams.set("to", customer);
  action.searchParams.set("callId", callId);
  const gather = twiml.gather({
    numDigits: 1,
    timeout: 10,
    method: "POST",
    action: action.toString(),
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
    getContacts = async () => {
      const { storage } = await import("../storage");
      return storage.getCrmContacts();
    },
    getScope = getStaffAssignmentScope,
    isApprovedStaff = async (req) => (await getStaffAccess(req)).approvalStatus === "approved",
    getActorUserId = (req) => req.dbUser?.id ?? null,
    getScopeForUserId = getStaffAssignmentScopeForUserId,
    isApprovedStaffForUserId = async (userId) =>
      (await getStaffAccessForUserId(userId)).approvalStatus === "approved",
    createOutcome = createOutboundCallOutcome,
    updateOutcome = updateOutboundCallOutcome,
    getOutcome = getOutboundCallOutcome,
  } = options;
  const callbackCallLimiter = rateLimit({
    windowMs: 60_000,
    max: 6,
    key: (req) => req.dbUser?.id ?? req.ip ?? "unknown",
    message: "Too many call attempts. Wait a minute before trying again.",
  });

  app.post("/api/twilio/calls/outbound", callbackCallLimiter, async (req: Request, res: Response): Promise<any> => {
    let callId: string | null = null;
    try {
      const { to, contactId: rawContactId, agentPhone } = req.body ?? {};
      if (!to) {
        res.status(400).json({ error: "to is required" });
        return;
      }
      const userId = getActorUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const scope = await getScope(req);
      const authorization = await authorizeOutboundCallTarget({
        to,
        contactId: rawContactId,
        isApproved: await isApprovedStaff(req),
        scope,
        getContacts,
        canSeeContact,
        canEditContact,
      });
      if (!authorization.ok) {
        res.status(authorization.status).json({ error: authorization.error });
        return;
      }
      const customer = authorization.customerNumber;
      const contactId = authorization.contactId;

      if (!(await isTwilioConfigured())) {
        res.status(400).json({ error: "Twilio is not configured" });
        return;
      }
      const from = await getFromNumber();
      if (!from) {
        res.status(400).json({ error: "No business phone number is configured in Phone Settings" });
        return;
      }
      const base = publicBaseUrl();
      if (!base) {
        res.status(500).json({ error: "Public app URL is not configured for Twilio callbacks" });
        return;
      }

      // The staff leg may only ring a configured forwarding phone, so this
      // endpoint can't be used to connect two arbitrary outside numbers.
      const agentPhones = await getAgentPhones();
      if (agentPhones.length === 0) {
        res.status(400).json({ error: "No staff forwarding phone is configured in Phone Settings" });
        return;
      }
      const agent = agentPhone ? toValidE164(String(agentPhone)) : agentPhones[0];
      if (!agent || !agentPhones.includes(agent)) {
        res.status(400).json({ error: "agentPhone must be one of the configured forwarding phones" });
        return;
      }
      if (agent === customer) {
        res.status(400).json({ error: "Cannot call the staff phone itself" });
        return;
      }

      const contact = authorization.contact;
      const label = contact?.fullName || contact?.company || customer.replace(/\D/g, "").split("").join(" ");
      callId = randomUUID();
      await createOutcome({
        callId,
        userId,
        contactId,
        customerNumber: customer,
        mode: "callback",
        status: "preparing",
      });
      const call = await createCall({
        to: agent,
        from,
        twiml: agentLegTwiml(base, customer, label, callId),
        statusCallback: callbackUrl(base, "/webhooks/voice/callback-status", callId),
      });
      await updateOutcome(callId, { status: "staff-ringing", parentCallSid: call.sid });

      // Keep the initiation in call history, but use the separate outcome row
      // for whether a customer leg actually rang or connected.
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

      res.json({ success: true, sid: call.sid, callId, to: customer, agentPhone: agent, contactId });
    } catch (e: any) {
      if (callId) await updateOutcome(callId, { status: "failed" }).catch(() => undefined);
      logger.error({ code: e?.code, status: e?.status }, "Outbound callback call could not be started");
      res.status(500).json({ success: false, error: "Call could not be started. Check Twilio call settings or try again." });
      return;
    }
  });

  // Reached only through the Twilio signature boundary on /webhooks. The
  // signed URL, stored call outcome, and current assignment are all checked
  // before dialing the customer.
  app.post("/webhooks/voice/outbound-connect", async (req: Request, res: Response) => {
    const twiml = new VoiceResponse();
    const callId = String(req.query?.callId ?? "");
    const requestedTo = toValidE164(String(req.query?.to || ""));
    if (!/^[0-9a-f-]{36}$/i.test(callId)) {
      twiml.hangup();
      res.type("text/xml").send(twiml.toString());
      return;
    }
    try {
      const outcome = await getOutcome(callId);
      const from = await getFromNumber();
      const base = publicBaseUrl();
      if (
        !outcome ||
        outcome.mode !== "callback" ||
        !requestedTo ||
        requestedTo !== outcome.customerNumber ||
        !from ||
        !base ||
        !["staff-ringing", "staff-connected"].includes(outcome.status)
      ) {
        twiml.hangup();
        res.type("text/xml").send(twiml.toString());
        return;
      }
      if (req.body?.Digits !== "1") {
        await updateOutcome(callId, { status: "not-connected" });
        twiml.hangup();
        res.type("text/xml").send(twiml.toString());
        return;
      }

      const [approved, scope] = await Promise.all([
        isApprovedStaffForUserId(outcome.userId),
        getScopeForUserId(outcome.userId),
      ]);
      const authorization = await authorizeOutboundCallTarget({
        to: requestedTo,
        contactId: outcome.contactId,
        isApproved: approved,
        scope,
        getContacts,
        canSeeContact,
        canEditContact,
      });
      if (!authorization.ok) {
        await updateOutcome(callId, { status: "failed" });
        twiml.hangup();
        res.type("text/xml").send(twiml.toString());
        return;
      }

      await updateOutcome(callId, { status: "customer-dialing" });
      const dial = twiml.dial({
        callerId: from,
        timeout: 30,
        action: callbackUrl(base, "/webhooks/voice/outbound-result", callId),
        method: "POST",
      });
      dial.number({
        statusCallback: callbackUrl(base, "/webhooks/voice/outbound-status", callId),
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        statusCallbackMethod: "POST",
      }, authorization.customerNumber);
      res.type("text/xml").send(twiml.toString());
      return;
    } catch (error: any) {
      logger.warn({ code: error?.code }, "Callback call could not connect to the customer");
      await updateOutcome(callId, { status: "failed" }).catch(() => undefined);
      twiml.hangup();
      res.type("text/xml").send(twiml.toString());
      return;
    }
  });

  app.post("/webhooks/voice/callback-status", async (req: Request, res: Response) => {
    res.sendStatus(204);
    const callId = String(req.query.callId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(callId)) return;
    try {
      const outcome = await getOutcome(callId);
      if (!outcome || outcome.mode !== "callback") return;
      const callSid = String(req.body?.CallSid ?? "");
      if (outcome.parentCallSid && outcome.parentCallSid !== callSid) return;
      const status = String(req.body?.CallStatus ?? "").toLowerCase();
      const nextStatus: OutboundCallOutcome["status"] =
        status === "ringing" ? "staff-ringing" :
        status === "in-progress" || status === "answered" ? "staff-connected" :
        status === "no-answer" ? "staff-no-answer" :
        status === "busy" ? "staff-busy" :
        status === "failed" ? "failed" :
        status === "canceled" || status === "cancelled" ? "cancelled" :
        status === "completed" && !outcome.childCallSid ? "not-connected" :
        outcome.status;
      await updateOutcome(callId, { status: nextStatus, parentCallSid: callSid || undefined });
    } catch (error: any) {
      logger.warn({ code: error?.code }, "Callback call status could not be recorded");
    }
  });

  app.post("/webhooks/voice/outbound-status", async (req: Request, res: Response) => {
    res.sendStatus(204);
    const callId = String(req.query.callId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(callId)) return;
    try {
      const outcome = await getOutcome(callId);
      const childSid = String(req.body?.CallSid ?? "");
      const parentSid = String(req.body?.ParentCallSid ?? "");
      if (!outcome || outcome.mode !== "callback" || !childSid) return;
      if (outcome.parentCallSid && parentSid && outcome.parentCallSid !== parentSid) return;
      const providerStatus = String(req.body?.CallStatus ?? "").toLowerCase();
      const status: OutboundCallOutcome["status"] =
        providerStatus === "ringing" ? "customer-ringing" :
        providerStatus === "answered" || providerStatus === "in-progress" ? "customer-connected" :
        providerStatus === "completed" ? "completed" :
        providerStatus === "no-answer" ? "no-answer" :
        providerStatus === "busy" ? "busy" :
        providerStatus === "canceled" || providerStatus === "cancelled" ? "cancelled" :
        providerStatus === "failed" ? "failed" : "customer-dialing";
      const durationSeconds = Math.max(0, Number.parseInt(String(req.body?.CallDuration ?? "0"), 10) || 0);
      await updateOutcome(callId, { status, childCallSid: childSid, durationSeconds });
    } catch (error: any) {
      logger.warn({ code: error?.code }, "Customer-leg callback status could not be recorded");
    }
  });

  app.post("/webhooks/voice/outbound-result", async (req: Request, res: Response) => {
    const twiml = new VoiceResponse();
    const callId = String(req.query.callId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(callId)) {
      twiml.hangup();
      res.type("text/xml").send(twiml.toString());
      return;
    }
    try {
      const outcome = await getOutcome(callId);
      const parentSid = String(req.body?.CallSid ?? "");
      if (!outcome || outcome.mode !== "callback" || (outcome.parentCallSid && outcome.parentCallSid !== parentSid)) {
        twiml.hangup();
        res.type("text/xml").send(twiml.toString());
        return;
      }
      const childCallSid = String(req.body?.DialCallSid ?? "") || null;
      const providerStatus = String(req.body?.DialCallStatus ?? "").toLowerCase();
      const status: OutboundCallOutcome["status"] =
        providerStatus === "completed" ? "completed" :
        providerStatus === "no-answer" ? "no-answer" :
        providerStatus === "busy" ? "busy" :
        providerStatus === "canceled" || providerStatus === "cancelled" ? "cancelled" :
        providerStatus === "failed" ? "failed" : "not-connected";
      const durationSeconds = Math.max(0, Number.parseInt(String(req.body?.DialCallDuration ?? "0"), 10) || 0);
      await updateOutcome(callId, { status, childCallSid, durationSeconds });
      if (childCallSid) {
        await recordCall({
          callSid: childCallSid,
          fromNumber: (await getFromNumber()) || "Unknown",
          toNumber: outcome.customerNumber,
          status: providerStatus || status,
          direction: "outbound",
          durationSeconds,
          hadVoicemail: false,
          contactId: outcome.contactId,
        });
      }
    } catch (error: any) {
      logger.warn({ code: error?.code }, "Customer call outcome could not be recorded");
    }
    twiml.hangup();
    res.type("text/xml").send(twiml.toString());
    return;
  });
}

export async function defaultAgentPhones(
  getSettings: () => Promise<Parameters<typeof configuredForwardTargets>[0]>,
): Promise<string[]> {
  return configuredForwardTargets(await getSettings()).map((target) => target.number);
}
