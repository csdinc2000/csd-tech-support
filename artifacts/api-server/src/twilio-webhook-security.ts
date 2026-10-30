import type { NextFunction, Request, Response } from "express";
import twilio from "twilio";
import { canonicalPublicAppBaseUrl } from "./shared/roip-config";

export function expectedTwilioWebhookUrl(
  req: Request,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = canonicalPublicAppBaseUrl(env.APP_BASE_URL);
  if (configured.ok) return `${configured.origin}${req.originalUrl}`;
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  return `${proto}://${req.get("host")}${req.originalUrl}`;
}

// Twilio signs every webhook with X-Twilio-Signature using the auth token.
// The local-only bypass is deliberately unavailable in production.
export async function verifyTwilioSignature(req: Request, res: Response): Promise<boolean> {
  if (process.env.NODE_ENV !== "production" && process.env.TWILIO_SKIP_SIGNATURE_VERIFY === "1") {
    return true;
  }
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    if (process.env.NODE_ENV === "production") {
      res.status(503).type("text/plain").send("Twilio webhook verification is not configured");
      return false;
    }
    console.warn("[twilio-webhooks] TWILIO_AUTH_TOKEN not set — signature NOT verified outside production");
    return true;
  }
  const signature = req.get("X-Twilio-Signature") || "";
  const ok = twilio.validateRequest(
    authToken,
    signature,
    expectedTwilioWebhookUrl(req),
    req.body || {},
  );
  if (!ok) {
    res.status(403).type("text/plain").send("Invalid Twilio signature");
    return false;
  }
  return true;
}

export async function twilioWebhookSignatureBoundary(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.method !== "POST") {
    next();
    return;
  }
  if (await verifyTwilioSignature(req, res)) next();
}