import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import twilio from "twilio";
import type { InsertCallLog } from "@workspace/db";
import { rateLimit } from "../security";
import { getStaffAccessForUserId, getStaffAssignmentScopeForUserId, type StaffAssignmentScope } from "../staff-access";
import { getOutboundCallOutcome, createOutboundCallOutcome, updateOutboundCallOutcome, type OutboundCallOutcome } from "../outbound-call-outcomes";
import { authorizeOutboundCallTarget, type OutboundCallContact } from "../outbound-call-authorization";
import { canonicalPublicAppBaseUrl } from "../shared/roip-config";
import { toValidE164 } from "../phone-validation";
import { logger } from "../lib/logger";
import { resolveVoiceTokenConfig, type VoiceTokenConfig } from "../voice-credentials";

const VoiceResponse = twilio.twiml.VoiceResponse;
const voiceStartLimiter = rateLimit({
  windowMs: 60_000,
  max: 6,
  key: (req) => req.dbUser?.id ?? req.ip ?? "unknown",
  message: "Too many call attempts. Wait a minute before trying again.",
});

export type BrowserCallGrant = {
  callId: string;
  userId: string;
  to: string;
  contactId: number | null;
  expiresAt: number;
};

export type BrowserVoiceRouteOptions = {
  getFromNumber(): Promise<string | undefined>;
  getContacts(): Promise<OutboundCallContact[]>;
  canSeeContact(scope: StaffAssignmentScope, contactId: number | null | undefined): boolean;
  canEditContact(scope: StaffAssignmentScope, contactId: number | null | undefined): boolean;
  getScopeForUserId?(userId: string): Promise<StaffAssignmentScope>;
  getActorUserId?(req: Request): string | null;
  isApprovedStaffForUserId?(userId: string): Promise<boolean>;
  publicBaseUrl?(): string | null;
  recordCall(entry: InsertCallLog): Promise<unknown>;
  createOutcome?(input: Parameters<typeof createOutboundCallOutcome>[0]): Promise<void>;
  updateOutcome?(
    callId: string,
    patch: Parameters<typeof updateOutboundCallOutcome>[1],
  ): Promise<void>;
  getOutcome?(callId: string): Promise<OutboundCallOutcome | null>;
  env?: NodeJS.ProcessEnv;
  /**
   * Token-signing credentials. Defaults to env vars only when `env` is passed
   * (tests); otherwise env vars, then the Replit Twilio connector and an
   * auto-created TwiML App (voice-credentials.ts).
   */
  resolveVoiceConfig?(outgoingVoiceUrl: string | null): Promise<VoiceTokenConfig | null>;
};

function publicBaseUrl(env: NodeJS.ProcessEnv): string | null {
  const configured = canonicalPublicAppBaseUrl(env.APP_BASE_URL);
  if (configured.ok) return configured.origin;
  if (env.NODE_ENV === "production") return null;
  const host = env.PUBLIC_BASE_URL || env.REPLIT_DEV_DOMAIN;
  if (!host) return null;
  return host.startsWith("http") ? host.replace(/\/+$/, "") : `https://${host}`;
}

export function createBrowserCallGrant(payload: BrowserCallGrant, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyBrowserCallGrant(
  value: unknown,
  secret: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): BrowserCallGrant | null {
  if (typeof value !== "string" || !secret) return null;
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<BrowserCallGrant>;
    if (
      typeof parsed.callId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(parsed.callId) ||
      typeof parsed.userId !== "string" ||
      !parsed.userId ||
      typeof parsed.to !== "string" ||
      !toValidE164(parsed.to) ||
      (parsed.contactId !== null && !Number.isSafeInteger(parsed.contactId)) ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt <= nowSeconds ||
      parsed.expiresAt > nowSeconds + 180
    ) return null;
    return parsed as BrowserCallGrant;
  } catch {
    return null;
  }
}

function envVoiceConfig(env: NodeJS.ProcessEnv): VoiceTokenConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const apiKeySid = env.TWILIO_API_KEY_SID?.trim();
  const apiKeySecret = env.TWILIO_API_KEY_SECRET?.trim();
  if (!accountSid || !apiKeySid || !apiKeySecret) return null;
  return { accountSid, apiKeySid, apiKeySecret, twimlAppSid: env.TWILIO_TWIML_APP_SID?.trim() || null };
}

function configurationMissing(env: NodeJS.ProcessEnv, base: string | null, voice: VoiceTokenConfig | null): string[] {
  // Credentials resolved from the connector count as present.
  const required = [
    ["TWILIO_ACCOUNT_SID", voice?.accountSid ?? env.TWILIO_ACCOUNT_SID],
    ["TWILIO_API_KEY_SID", voice?.apiKeySid],
    ["TWILIO_API_KEY_SECRET", voice?.apiKeySecret],
    ["TWILIO_TWIML_APP_SID", voice?.twimlAppSid ?? undefined],
    ["TWILIO_AUTH_TOKEN", env.TWILIO_AUTH_TOKEN],
    ["SESSION_SECRET", env.SESSION_SECRET],
  ] as const;
  return [
    ...required.filter(([, value]) => !value?.trim()).map(([key]) => key),
    ...(!base ? ["APP_BASE_URL"] : []),
  ];
}

function callbackUrl(base: string, path: string, callId: string): string {
  const url = new URL(`${base}${path}`);
  url.searchParams.set("callId", callId);
  return url.toString();
}

function callStatusFromProvider(status: unknown): OutboundCallOutcome["status"] {
  switch (String(status ?? "").toLowerCase()) {
    case "queued":
    case "initiated":
      return "customer-dialing";
    case "ringing":
      return "customer-ringing";
    case "answered":
    case "in-progress":
      return "customer-connected";
    case "completed":
      return "completed";
    case "no-answer":
      return "no-answer";
    case "busy":
      return "busy";
    case "canceled":
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

function dialStatusFromProvider(status: unknown): OutboundCallOutcome["status"] {
  switch (String(status ?? "").toLowerCase()) {
    case "completed":
      return "completed";
    case "no-answer":
      return "no-answer";
    case "busy":
      return "busy";
    case "canceled":
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      return "not-connected";
  }
}

function safeInteger(value: unknown, fallback = 0): number {
  const result = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(result) && result >= 0 ? result : fallback;
}

function sendTwiML(res: Response, response: InstanceType<typeof VoiceResponse>): void {
  res.type("text/xml").send(response.toString());
}

export function registerBrowserVoiceRoutes(app: Express, options: BrowserVoiceRouteOptions): void {
  const {
    getFromNumber,
    getContacts,
    canSeeContact,
    canEditContact,
    getScopeForUserId = getStaffAssignmentScopeForUserId,
    getActorUserId = (req) => req.dbUser?.id ?? null,
    isApprovedStaffForUserId = async (userId) =>
      (await getStaffAccessForUserId(userId)).approvalStatus === "approved",
    publicBaseUrl: getPublicBaseUrl = () => publicBaseUrl(options.env ?? process.env),
    recordCall,
    createOutcome = createOutboundCallOutcome,
    updateOutcome = updateOutboundCallOutcome,
    getOutcome = getOutboundCallOutcome,
    env = process.env,
  } = options;
  const resolveVoiceConfig = options.resolveVoiceConfig ?? (options.env
    ? async (): Promise<VoiceTokenConfig | null> => envVoiceConfig(env)
    : (url: string | null) => resolveVoiceTokenConfig(url, env));

  async function authorizeUserTarget(userId: string, to: unknown, contactId?: unknown) {
    const [approved, scope] = await Promise.all([
      isApprovedStaffForUserId(userId),
      getScopeForUserId(userId),
    ]);
    return authorizeOutboundCallTarget({
      to,
      contactId,
      isApproved: approved,
      scope,
      getContacts,
      canSeeContact,
      canEditContact,
    });
  }

  app.post("/api/twilio/calls/browser-token", voiceStartLimiter, async (req: Request, res: Response) => {
    const userId = getActorUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    try {
      const authorization = await authorizeOutboundCallTarget({
        to: req.body?.to,
        contactId: req.body?.contactId,
        isApproved: await isApprovedStaffForUserId(userId),
        scope: await getScopeForUserId(userId),
        getContacts,
        canSeeContact,
        canEditContact,
      });
      if (!authorization.ok) {
        res.status(authorization.status).json({ error: authorization.error });
        return;
      }

      const base = getPublicBaseUrl();
      const voiceConfig = base ? await resolveVoiceConfig(`${base}/webhooks/voice/browser-connect`) : null;
      const missing = configurationMissing(env, base, voiceConfig);
      if (missing.length || !voiceConfig?.twimlAppSid) {
        res.status(503).json({
          error: "Browser calling is not configured yet.",
          missing,
          voiceWebhookUrl: base ? `${base}/webhooks/voice/browser-connect` : null,
        });
        return;
      }
      if (userId.length > 120) {
        res.status(400).json({ error: "The staff identity is too long for browser calling." });
        return;
      }
      const fromNumber = await getFromNumber();
      if (!fromNumber) {
        res.status(503).json({ error: "No business phone number is configured in Phone Settings." });
        return;
      }

      const callId = randomUUID();
      await createOutcome({
        callId,
        userId,
        contactId: authorization.contactId,
        customerNumber: authorization.customerNumber,
        mode: "browser",
        status: "preparing",
      });
      const AccessToken = twilio.jwt.AccessToken;
      const token = new AccessToken(
        voiceConfig.accountSid,
        voiceConfig.apiKeySid,
        voiceConfig.apiKeySecret,
        { identity: userId, ttl: 300 },
      );
      token.addGrant(new AccessToken.VoiceGrant({
        outgoingApplicationSid: voiceConfig.twimlAppSid,
      }));
      const callGrant = createBrowserCallGrant({
        callId,
        userId,
        to: authorization.customerNumber,
        contactId: authorization.contactId,
        expiresAt: Math.floor(Date.now() / 1000) + 90,
      }, env.SESSION_SECRET!);
      res.json({
        token: token.toJwt(),
        callGrant,
        callId,
        identity: userId,
        expiresInSeconds: 300,
      });
      return;
    } catch (error: any) {
      logger.error({ code: error?.code, status: error?.status }, "Browser call token could not be created");
      res.status(500).json({ error: "Could not prepare a browser call. Try again or use the saved-phone option." });
      return;
    }
  });

  app.get("/api/twilio/calls/outbound/:callId/status", async (req: Request, res: Response) => {
    const userId = getActorUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const callId = String(req.params.callId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(callId)) {
      res.status(400).json({ error: "Invalid call id" });
      return;
    }
    try {
      const outcome = await getOutcome(callId);
      if (!outcome || outcome.userId !== userId) {
        res.status(404).json({ error: "Call not found" });
        return;
      }
      if (outcome.contactId != null) {
        const scope = await getScopeForUserId(userId);
        if (
          !canSeeContact(scope, outcome.contactId) ||
          !canEditContact(scope, outcome.contactId)
        ) {
          res.status(404).json({ error: "Call not found" });
          return;
        }
      } else if (!(await isApprovedStaffForUserId(userId))) {
        res.status(403).json({ error: "Approved staff access required" });
        return;
      }
      if (
        outcome.status === "preparing" &&
        Date.now() - new Date(outcome.updatedAt).getTime() > 120_000
      ) {
        await updateOutcome(outcome.callId, { status: "failed" });
        res.json({ callId: outcome.callId, mode: outcome.mode, status: "failed", durationSeconds: 0 });
        return;
      }
      res.json({
        callId: outcome.callId,
        mode: outcome.mode,
        status: outcome.status,
        durationSeconds: outcome.durationSeconds,
        updatedAt: outcome.updatedAt,
      });
      return;
    } catch {
      res.status(500).json({ error: "Could not load call status" });
      return;
    }
  });

  app.post("/api/twilio/calls/outbound/:callId/fail", async (req: Request, res: Response) => {
    const userId = getActorUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const callId = String(req.params.callId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(callId)) {
      res.status(400).json({ error: "Invalid call id" });
      return;
    }
    try {
      const outcome = await getOutcome(callId);
      if (!outcome || outcome.userId !== userId) {
        res.status(404).json({ error: "Call not found" });
        return;
      }
      if (!(await isApprovedStaffForUserId(userId))) {
        res.status(403).json({ error: "Approved staff access required" });
        return;
      }
      if (outcome.contactId != null) {
        const scope = await getScopeForUserId(userId);
        if (!canSeeContact(scope, outcome.contactId) || !canEditContact(scope, outcome.contactId)) {
          res.status(404).json({ error: "Call not found" });
          return;
        }
      }
      if (outcome.mode === "browser" && outcome.status === "preparing") {
        await updateOutcome(callId, { status: "failed" });
      }
      res.json({ success: true });
      return;
    } catch {
      res.status(500).json({ error: "Could not update call status" });
      return;
    }
  });

  app.post("/webhooks/voice/browser-connect", async (req: Request, res: Response) => {
    const grant = verifyBrowserCallGrant(req.body?.CallGrant, env.SESSION_SECRET);
    const twiml = new VoiceResponse();
    if (!grant || String(req.body?.From ?? "") !== `client:${grant.userId}`) {
      twiml.reject({ reason: "rejected" });
      return sendTwiML(res.status(403), twiml);
    }
    try {
      const outcome = await getOutcome(grant.callId);
      const requestedTo = toValidE164(String(req.body?.To ?? ""));
      if (
        !outcome ||
        outcome.mode !== "browser" ||
        outcome.userId !== grant.userId ||
        outcome.customerNumber !== grant.to ||
        outcome.contactId !== grant.contactId ||
        requestedTo !== grant.to ||
        (
          outcome.status !== "preparing" &&
          outcome.parentCallSid !== String(req.body?.CallSid ?? "")
        )
      ) {
        twiml.reject({ reason: "rejected" });
        return sendTwiML(res.status(403), twiml);
      }
      const authorization = await authorizeUserTarget(grant.userId, requestedTo, grant.contactId);
      if (!authorization.ok) {
        await updateOutcome(grant.callId, { status: "failed" });
        twiml.reject({ reason: "rejected" });
        return sendTwiML(res.status(403), twiml);
      }
      const fromNumber = await getFromNumber();
      const base = getPublicBaseUrl();
      if (!fromNumber || !base) {
        await updateOutcome(grant.callId, { status: "failed" });
        twiml.reject({ reason: "rejected" });
        return sendTwiML(res.status(503), twiml);
      }

      await updateOutcome(grant.callId, {
        status: "customer-dialing",
        parentCallSid: String(req.body?.CallSid ?? "") || null,
      });
      const dial = twiml.dial({
        callerId: fromNumber,
        timeout: 30,
        action: callbackUrl(base, "/webhooks/voice/browser-result", grant.callId),
        method: "POST",
      });
      dial.number({
        statusCallback: callbackUrl(base, "/webhooks/voice/browser-status", grant.callId),
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        statusCallbackMethod: "POST",
      }, authorization.customerNumber);
      return sendTwiML(res, twiml);
    } catch (error: any) {
      logger.error({ code: error?.code }, "Browser call webhook could not be prepared");
      await updateOutcome(grant.callId, { status: "failed" }).catch(() => undefined);
      twiml.reject({ reason: "rejected" });
      return sendTwiML(res.status(500), twiml);
    }
  });

  app.post("/webhooks/voice/browser-status", async (req: Request, res: Response) => {
    res.sendStatus(204);
    const callId = String(req.query.callId ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(callId)) return;
    try {
      const outcome = await getOutcome(callId);
      const callSid = String(req.body?.CallSid ?? "");
      const parentSid = String(req.body?.ParentCallSid ?? "");
      if (!outcome || outcome.mode !== "browser" || !callSid) return;
      if (outcome.parentCallSid && parentSid && outcome.parentCallSid !== parentSid) return;
      const status = callStatusFromProvider(req.body?.CallStatus);
      const durationSeconds = safeInteger(req.body?.CallDuration, outcome.durationSeconds);
      await updateOutcome(callId, { status, childCallSid: callSid, durationSeconds });
      await recordCall({
        callSid,
        fromNumber: (await getFromNumber()) || "Unknown",
        toNumber: outcome.customerNumber,
        status: String(req.body?.CallStatus ?? status),
        direction: "outbound",
        durationSeconds,
        hadVoicemail: false,
        contactId: outcome.contactId,
      });
    } catch (error: any) {
      logger.warn({ code: error?.code }, "Browser call status could not be recorded");
    }
  });

  app.post("/webhooks/voice/browser-result", async (req: Request, res: Response) => {
    const twiml = new VoiceResponse();
    try {
      const callId = String(req.query.callId ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(callId)) {
        twiml.hangup();
        return sendTwiML(res, twiml);
      }
      const outcome = await getOutcome(callId);
      const callSid = String(req.body?.CallSid ?? "");
      if (!outcome || outcome.mode !== "browser" || (outcome.parentCallSid && outcome.parentCallSid !== callSid)) {
        twiml.hangup();
        return sendTwiML(res, twiml);
      }
      const childCallSid = String(req.body?.DialCallSid ?? "") || null;
      const durationSeconds = safeInteger(req.body?.DialCallDuration, outcome.durationSeconds);
      const status = dialStatusFromProvider(req.body?.DialCallStatus);
      await updateOutcome(callId, {
        status,
        childCallSid,
        durationSeconds,
      });
      if (childCallSid) {
        await recordCall({
          callSid: childCallSid,
          fromNumber: (await getFromNumber()) || "Unknown",
          toNumber: outcome.customerNumber,
          status: String(req.body?.DialCallStatus ?? status),
          direction: "outbound",
          durationSeconds,
          hadVoicemail: false,
          contactId: outcome.contactId,
        });
      }
    } catch (error: any) {
      logger.warn({ code: error?.code }, "Browser call result could not be recorded");
    }
    twiml.hangup();
    return sendTwiML(res, twiml);
  });
}
