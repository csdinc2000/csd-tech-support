// Twilio client wired through Replit's connector (blueprint: twilio).
// Credentials are fetched fresh on every call — never cache the client.
import twilio from "twilio";

let cachedSettings: any | null = null;
let cachedAt = 0;
// Connector tokens can rotate; refresh from the proxy every 5 minutes.
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getCredentials() {
  if (cachedSettings && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedSettings;
  }

  // Production path (Fly.io / any non-Replit host): if the plain Twilio env
  // vars are present we use them directly and skip the Replit connector entirely.
  // The Twilio SDK accepts (accountSid, authToken) just as happily as (apiKey,
  // apiKeySecret), so we set apiKey/apiKeySecret to the same auth-token values
  // to keep the downstream `twilio(apiKey, apiKeySecret, { accountSid })` call
  // working unchanged.
  if (
    process.env.TWILIO_ACCOUNT_SID?.startsWith("AC") &&
    process.env.TWILIO_AUTH_TOKEN
  ) {
    const settings = {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      apiKey: process.env.TWILIO_ACCOUNT_SID,
      apiKeySecret: process.env.TWILIO_AUTH_TOKEN,
      phoneNumber: process.env.TWILIO_PHONE_NUMBER,
    };
    cachedSettings = settings;
    cachedAt = Date.now();
    return settings;
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!xReplitToken) {
    throw new Error("X-Replit-Token not found for repl/depl");
  }

  const data = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=twilio`,
    { headers: { Accept: "application/json", "X-Replit-Token": xReplitToken } },
  ).then((r) => r.json());

  const item = data?.items?.[0];
  if (!item || !item.settings?.account_sid || !item.settings?.api_key || !item.settings?.api_key_secret) {
    throw new Error("Twilio not connected");
  }

  // The Replit Twilio connector UI mislabels its first field, so users sometimes
  // paste a Phone Number SID (PN…) where the Account SID (AC…) is required.
  // Prefer the env-var override when present; otherwise use what the connector returned.
  const accountSidFromConnector = item.settings.account_sid as string;
  const accountSid = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_ACCOUNT_SID.startsWith("AC")
    ? process.env.TWILIO_ACCOUNT_SID
    : accountSidFromConnector;

  const settings = {
    accountSid,
    apiKey: item.settings.api_key as string,
    apiKeySecret: item.settings.api_key_secret as string,
    phoneNumber: (item.settings.phone_number as string | undefined) ?? process.env.TWILIO_PHONE_NUMBER,
  };
  cachedSettings = settings;
  cachedAt = Date.now();
  return settings;
}

export async function getTwilioClient() {
  const { accountSid, apiKey, apiKeySecret } = await getCredentials();
  return twilio(apiKey, apiKeySecret, { accountSid });
}

export async function getTwilioFromPhoneNumber(): Promise<string | undefined> {
  const { phoneNumber } = await getCredentials();
  return phoneNumber;
}

// Resolve the Twilio SID (PN...) for the configured From phone number.
// Needed for A2P Messaging Service phoneNumbers.create — Twilio requires the
// number's SID, not its E.164 string. Returns null when no number is
// configured, when the lookup fails, or when no exact match is found.
export async function getTwilioFromPhoneNumberSid(): Promise<string | null> {
  const from = await getTwilioFromPhoneNumber();
  if (!from) return null;
  try {
    const client = await getTwilioClient();
    const list = await client.incomingPhoneNumbers.list({ phoneNumber: from, limit: 1 });
    return list[0]?.sid ?? null;
  } catch {
    return null;
  }
}

// List the account's SMS-capable phone numbers so the A2P wizard can let
// the owner pick which to attach when more than one number exists.
export async function listTwilioSmsNumbers(): Promise<
  { sid: string; phoneNumber: string; friendlyName?: string }[]
> {
  try {
    const client = await getTwilioClient();
    const list = await client.incomingPhoneNumbers.list({ limit: 100 });
    return list
      .filter((n: any) => n.capabilities?.sms !== false)
      .map((n: any) => ({
        sid: n.sid,
        phoneNumber: n.phoneNumber,
        friendlyName: n.friendlyName,
      }));
  } catch {
    return [];
  }
}

// Best-effort check that the connector is wired and credentials resolve.
export async function isTwilioConfigured(): Promise<boolean> {
  try {
    const c = await getCredentials();
    return Boolean(c.accountSid && c.apiKey && c.apiKeySecret);
  } catch {
    return false;
  }
}

// A2P 10DLC: carriers only honor an approved campaign on traffic sent through
// the Messaging Service that owns it — sending from the raw number bypasses the
// campaign and gets rejected with error 30034. We resolve the service SID once
// and cache it (same 5-min TTL as credentials) so every sendSms() can route
// through it. Returns null when no service is configured/approved, in which
// case sendSms() falls back to the raw From number (legacy behavior).
let cachedMessagingServiceSid: string | null = null;
let cachedMessagingServiceSidAt = 0;

export async function getA2PMessagingServiceSid(): Promise<string | null> {
  // Explicit override always wins and skips the Twilio API lookup.
  const override = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  if (override?.startsWith("MG")) return override;

  if (cachedMessagingServiceSid && Date.now() - cachedMessagingServiceSidAt < CACHE_TTL_MS) {
    return cachedMessagingServiceSid;
  }

  try {
    // Reuse the status lookup so we route through a service with an approved
    // campaign. Dynamic import avoids a load-time cycle (a2p-status imports us).
    const { getA2PStatus } = await import("./a2p-status");
    const status = await getA2PStatus();
    const approved = status.campaigns.find((c) =>
      /verified|approved/i.test(c.campaignStatus || ""),
    );
    // Prefer an approved campaign's service; otherwise fall back to any campaign
    // we found (better to route through the registered service than the raw number).
    const sid = approved?.messagingServiceSid || status.campaigns[0]?.messagingServiceSid || null;
    if (sid) {
      cachedMessagingServiceSid = sid;
      cachedMessagingServiceSidAt = Date.now();
    }
    return sid;
  } catch (e: any) {
    console.warn("[twilio] A2P messaging-service lookup failed:", e?.message || e);
    return null;
  }
}

// Normalize a US phone number to E.164 (+1XXXXXXXXXX) so Twilio accepts it.
export function toE164(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (input.trim().startsWith("+")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "+" + digits;
}

export async function sendSms(to: string, body: string): Promise<{ sid: string; to: string; from: string }> {
  const client = await getTwilioClient();
  const from = await getTwilioFromPhoneNumber();
  if (!from) throw new Error("Twilio: no from-phone-number configured on the connection");
  // Ask Twilio to ping us back as the message progresses queued -> sent -> delivered/failed.
  const publicHost = process.env.PUBLIC_BASE_URL || process.env.REPLIT_DEV_DOMAIN;
  const statusCallback = publicHost
    ? `${publicHost.startsWith("http") ? publicHost : `https://${publicHost}`}/webhooks/sms/status`
    : undefined;
  // Route through the A2P Messaging Service when one is configured/approved so
  // carriers accept the message; otherwise fall back to the raw From number.
  // When a messagingServiceSid is supplied, Twilio picks the sender from the
  // service's number pool, so `from` must be omitted.
  const messagingServiceSid = await getA2PMessagingServiceSid();
  const msg = await client.messages.create({
    to: toE164(to),
    body,
    ...(messagingServiceSid ? { messagingServiceSid } : { from }),
    ...(statusCallback ? { statusCallback } : {}),
  });

  // Best-effort persistence so outbound texts show up in the Messages UI
  try {
    const { createSmsMessage } = await import("./twilio-tracking-storage");
    await createSmsMessage({
      messageSid: msg.sid,
      fromNumber: msg.from || from,
      toNumber: msg.to || toE164(to),
      body,
      direction: "outbound",
      status: msg.status || "queued",
    });
  } catch (e: any) {
    console.warn("[sms] outbound persistence failed:", e?.message || e);
  }

  return { sid: msg.sid, to: msg.to, from: msg.from };
}

export async function placeCall(to: string, twimlOrUrl: string): Promise<{ sid: string }> {
  const client = await getTwilioClient();
  const from = await getTwilioFromPhoneNumber();
  if (!from) throw new Error("Twilio: no from-phone-number configured on the connection");
  // If the caller passes <Response>...</Response> we feed it as inline TwiML; otherwise treat as URL.
  const isTwiml = twimlOrUrl.trim().startsWith("<");
  const call = await client.calls.create(
    isTwiml
      ? { to: toE164(to), from, twiml: twimlOrUrl }
      : { to: toE164(to), from, url: twimlOrUrl },
  );
  return { sid: call.sid };
}
