import { getAppState, setAppState } from "./app-state";
import { getTwilioClient, getTwilioCredentials } from "./twilio";
import { logger } from "./lib/logger";

// Credentials for Twilio browser calling (Voice SDK access tokens).
//
// Explicit env vars win (TWILIO_API_KEY_SID / _SECRET / TWILIO_TWIML_APP_SID).
// Otherwise an API key (SK…) from the Replit Twilio connector is used, or, when
// the account is configured with an auth token only, a dedicated "CSD Platform
// browser calling" API key is created once and kept in app_state (Twilio shows
// a key's secret only at creation; revoke it in the Twilio console to rotate).
// The TwiML App that routes calls placed from the browser is likewise created
// on first use, so browser calling works without manual setup.

export type VoiceTokenConfig = {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  /** Needed for calls placed from the browser; answering doesn't use it. */
  twimlAppSid: string | null;
};

const APP_STATE_KEY = "twilio-browser-twiml-app";
const KEY_STATE_KEY = "twilio-browser-api-key";
const APP_FRIENDLY_NAME = "CSD Platform browser calling";

type StoredApp = { sid: string; voiceUrl: string };

async function ensureTwimlApp(voiceUrl: string): Promise<string> {
  const stored = await getAppState<StoredApp>(APP_STATE_KEY);
  const client = await getTwilioClient();
  if (stored?.sid) {
    if (stored.voiceUrl === voiceUrl) return stored.sid;
    try {
      await client.applications(stored.sid).update({ voiceUrl, voiceMethod: "POST" });
      await setAppState(APP_STATE_KEY, { sid: stored.sid, voiceUrl });
      return stored.sid;
    } catch (error) {
      logger.warn({ err: error }, "Saved TwiML App could not be updated; creating a new one");
    }
  }
  const app = await client.applications.create({ friendlyName: APP_FRIENDLY_NAME, voiceUrl, voiceMethod: "POST" });
  await setAppState(APP_STATE_KEY, { sid: app.sid, voiceUrl });
  logger.info({ sid: app.sid }, "Created TwiML App for browser calling");
  return app.sid;
}

type StoredKey = { sid: string; secret: string; accountSid: string };

async function ensureApiKey(accountSid: string): Promise<StoredKey> {
  const stored = await getAppState<StoredKey>(KEY_STATE_KEY);
  if (stored?.sid && stored.secret && stored.accountSid === accountSid) return stored;
  const client = await getTwilioClient();
  const key = await client.newKeys.create({ friendlyName: "CSD Platform browser calling" });
  const created = { sid: key.sid, secret: key.secret, accountSid };
  await setAppState(KEY_STATE_KEY, created);
  logger.info({ sid: key.sid }, "Created Twilio API key for browser calling");
  return created;
}

/**
 * Resolve what's needed to sign browser-calling tokens. `outgoingVoiceUrl` is
 * where calls placed from the browser are sent (…/webhooks/voice/browser-connect);
 * pass null when only answering calls.
 */
export async function resolveVoiceTokenConfig(
  outgoingVoiceUrl: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VoiceTokenConfig | null> {
  let accountSid = env.TWILIO_ACCOUNT_SID?.trim() || "";
  let apiKeySid = env.TWILIO_API_KEY_SID?.trim() || "";
  let apiKeySecret = env.TWILIO_API_KEY_SECRET?.trim() || "";
  if (!apiKeySid || !apiKeySecret || !accountSid.startsWith("AC")) {
    try {
      const credentials = await getTwilioCredentials();
      if (!accountSid.startsWith("AC")) accountSid = credentials.accountSid;
      // Only a real API key (SK…) can sign access tokens.
      if (String(credentials.apiKey).startsWith("SK")) {
        apiKeySid = credentials.apiKey;
        apiKeySecret = credentials.apiKeySecret;
      }
    } catch (error) {
      logger.warn({ err: error }, "Twilio connector credentials unavailable for browser calling");
    }
  }
  if ((!apiKeySid || !apiKeySecret) && accountSid.startsWith("AC")) {
    try {
      const key = await ensureApiKey(accountSid);
      apiKeySid = key.sid;
      apiKeySecret = key.secret;
    } catch (error) {
      logger.warn({ err: error }, "Twilio API key for browser calling could not be prepared");
    }
  }
  if (!accountSid.startsWith("AC") || !apiKeySid || !apiKeySecret) return null;

  let twimlAppSid = env.TWILIO_TWIML_APP_SID?.trim() || null;
  if (!twimlAppSid && outgoingVoiceUrl) {
    try {
      twimlAppSid = await ensureTwimlApp(outgoingVoiceUrl);
    } catch (error) {
      logger.warn({ err: error }, "TwiML App for browser calling could not be prepared");
    }
  }
  return { accountSid, apiKeySid, apiKeySecret, twimlAppSid };
}
