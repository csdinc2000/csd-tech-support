import type { Express, Request, Response } from "express";
import twilio from "twilio";
import { z } from "zod/v4";
import { pool } from "./db";
import { getStaffAccessForUserId } from "./staff-access";
import { resolveVoiceTokenConfig, type VoiceTokenConfig } from "./voice-credentials";
import { logger } from "./lib/logger";

// ---------------------------------------------------------------------------
// App phone: answer business-line calls in the browser.
//
// Staff with the communications feature can switch on "Ring me in the app".
// While the app is open, their browser registers with Twilio (Voice SDK) and
// incoming calls ring it alongside the forwarded phones (twilio-forwarding.ts
// adds a <Client> leg per person). First to answer gets the call.
//
// Routes (communications feature, /api/twilio prefix in security.ts):
//   GET  /api/twilio/app-phone         this user's setting + whether it can work
//   PUT  /api/twilio/app-phone         { ringInApp }
//   POST /api/twilio/app-phone/token   Voice SDK token that can receive calls
// ---------------------------------------------------------------------------

/** Twilio client identities are limited; staff ids are well under this. */
const MAX_IDENTITY_LENGTH = 120;
/** Upper bound on browsers rung per call, to keep the TwiML small. */
const MAX_APP_RINGS = 10;
const TOKEN_TTL_SECONDS = 60 * 60;

export async function getRingInApp(userId: string): Promise<boolean> {
  const result = await pool.query<{ ring_in_app: boolean }>(
    "SELECT ring_in_app FROM staff_voice_preferences WHERE user_id = $1",
    [userId],
  );
  return result.rows[0]?.ring_in_app === true;
}

/**
 * Staff whose browsers should ring for an incoming call: switched on, still
 * approved with communications. Twilio skips identities that aren't online.
 */
export async function loadAppRingIdentities(): Promise<string[]> {
  const result = await pool.query<{ user_id: string }>(
    "SELECT user_id FROM staff_voice_preferences WHERE ring_in_app ORDER BY updated_at DESC LIMIT $1",
    [MAX_APP_RINGS * 2],
  );
  const identities: string[] = [];
  for (const { user_id: userId } of result.rows) {
    if (identities.length >= MAX_APP_RINGS || userId.length > MAX_IDENTITY_LENGTH) continue;
    const access = await getStaffAccessForUserId(userId);
    if (access.approvalStatus === "approved" && access.features.communications) identities.push(userId);
  }
  return identities;
}

const preferenceSchema = z.object({ ringInApp: z.boolean() }).strict();

export type AppPhoneRouteOptions = {
  resolveVoiceConfig?: (outgoingVoiceUrl: string | null) => Promise<VoiceTokenConfig | null>;
};

export function registerAppPhoneRoutes(app: Express, options: AppPhoneRouteOptions = {}): void {
  const resolveVoiceConfig = options.resolveVoiceConfig ?? ((url: string | null) => resolveVoiceTokenConfig(url));
  const userIdOf = (req: Request, res: Response): string | null => {
    const id = req.dbUser?.id;
    if (!id) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    return id;
  };

  app.get("/api/twilio/app-phone", async (req, res) => {
    const userId = userIdOf(req, res);
    if (!userId) return;
    try {
      res.json({ ringInApp: await getRingInApp(userId) });
    } catch (error) {
      logger.error({ err: error }, "App phone setting could not be loaded");
      res.status(500).json({ error: "Could not load your phone setting" });
    }
  });

  app.put("/api/twilio/app-phone", async (req, res) => {
    const userId = userIdOf(req, res);
    if (!userId) return;
    const parsed = preferenceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "ringInApp must be true or false" });
      return;
    }
    if (userId.length > MAX_IDENTITY_LENGTH) {
      res.status(400).json({ error: "This staff account can't receive calls in the app." });
      return;
    }
    try {
      await pool.query(
        `INSERT INTO staff_voice_preferences (user_id, ring_in_app, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE SET ring_in_app = EXCLUDED.ring_in_app, updated_at = NOW()`,
        [userId, parsed.data.ringInApp],
      );
      res.json({ ringInApp: parsed.data.ringInApp });
    } catch (error) {
      logger.error({ err: error }, "App phone setting could not be saved");
      res.status(500).json({ error: "Could not save your phone setting" });
    }
  });

  app.post("/api/twilio/app-phone/token", async (req, res) => {
    const userId = userIdOf(req, res);
    if (!userId) return;
    try {
      if (!(await getRingInApp(userId))) {
        res.status(409).json({ error: "Turn on “Ring me in the app” first." });
        return;
      }
      const config = await resolveVoiceConfig(null);
      if (!config) {
        res.status(503).json({ error: "Browser calling isn't set up for this Twilio account yet." });
        return;
      }
      const AccessToken = twilio.jwt.AccessToken;
      const token = new AccessToken(config.accountSid, config.apiKeySid, config.apiKeySecret, {
        identity: userId,
        ttl: TOKEN_TTL_SECONDS,
      });
      token.addGrant(new AccessToken.VoiceGrant({ incomingAllow: true }));
      res.json({ token: token.toJwt(), identity: userId, expiresInSeconds: TOKEN_TTL_SECONDS });
    } catch (error) {
      logger.error({ err: error }, "App phone token could not be created");
      res.status(500).json({ error: "Could not connect the app phone. Try again." });
    }
  });
}
