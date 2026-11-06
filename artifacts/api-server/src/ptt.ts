import type { Express, Request } from "express";
import type { Server } from "http";
import { createHmac, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { getAuth } from "@clerk/express";
import { canAccessFeature } from "./staff-access";
import twilio from "twilio";
import { requireAuth } from "./middlewares/clerkAuth";
import { isAdminUser, isOwnerIdentity } from "./security";
import { logger } from "./lib/logger";
import { pool } from "./db";
import {
  getRoipGatewayStatus,
  onRoipMedia,
  onRoipStatus,
  registerRoipRoutes,
  ROIP_CHANNEL_ID,
  ROIP_GATEWAY_HOLDER,
  ROIP_PROTOCOL,
  isNonSilentPcmuFrame,
  isRoipTransportReady,
  ROIP_CODEC,
  ROIP_SAMPLE_RATE,
  sendBrowserAudioToRoip,
  setupRoipServer,
} from "./roip";

export const PTT_CHANNELS = [
  {
    id: "dispatch",
    name: "Dispatch",
    description: "Primary service desk and field coordination",
  },
  {
    id: "field",
    name: "Field Technicians",
    description: "Technician-to-technician coordination",
  },
  {
    id: "priority",
    name: "Priority Response",
    description: "Urgent incidents and escalation traffic",
  },
] as const;

/** Private call created by a PTT ring: `direct:<ptt_pages.group_id>`, joinable only by the people on that ring. */
type DirectChannelId = `direct:${string}`;
type ChannelId = (typeof PTT_CHANNELS)[number]["id"] | DirectChannelId;
const DIRECT_CHANNEL_PATTERN = /^direct:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** How long after a ring its private call can still be joined. */
const DIRECT_CHANNEL_TTL_HOURS = 12;

export type PttUser = {
  id: string;
  name: string;
  email?: string;
};

type PttClient = {
  id: string;
  ws: WebSocket;
  user: PttUser;
  channelId?: ChannelId;
  isAlive: boolean;
  closed: boolean;
  canDispatchRadio: boolean;
  lastRoipFrameAt: number | null;
  rtcTelemetry: Map<string, PttRtcTelemetry>;
};

type PttToken = {
  user: PttUser;
  expiresAt: number;
  canDispatchRadio: boolean;
  owner: boolean;
  ownerRevision: string | null;
};

type PttMessage = {
  type?: unknown;
  channelId?: unknown;
  to?: unknown;
  payload?: unknown;
  remoteId?: unknown;
  connectionState?: unknown;
  iceConnectionState?: unknown;
  path?: unknown;
  candidateType?: unknown;
  failureReason?: unknown;
};

export type PttIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
  credentialType?: "password";
};

export type PttNetworkConfig = {
  iceServers: PttIceServer[];
  relayConfigured: boolean;
  turnCredentialExpiresAt: string | null;
};

type PttRtcTelemetry = {
  connectionState: "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed" | "unknown";
  iceConnectionState: "new" | "checking" | "connected" | "completed" | "disconnected" | "failed" | "closed" | "unknown";
  path: "relay" | "direct" | "unknown";
  candidateType: "host" | "srflx" | "prflx" | "relay" | "unknown";
  failureReason?: string;
};

const SESSION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TURN_CREDENTIAL_TTL_SECONDS = 10 * 60;
const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302"];
const pttTokens = new Map<string, PttToken>();
const pttClients = new Map<string, PttClient>();
const pttClientsByUser = new Map<string, PttClient>();
const channelFloors = new Map<ChannelId, string>();
/** Grant time of each channel's current floor holder, keyed like `channelFloors`. */
const channelFloorGrantedAt = new Map<ChannelId, number>();
const GATEWAY_HANGOVER_MS = 350;
const DEFAULT_MAX_TRANSMIT_MS = 60_000;
/** Low enough that integration tests can expire a floor without fake timers. */
const MIN_MAX_TRANSMIT_MS = 250;
const MAX_MAX_TRANSMIT_MS = 10 * 60 * 1000;
let gatewayLastVoiceAt: number | null = null;
let warnedTurnConfiguration = false;
let cachedTwilioNetwork:
  | { config: PttNetworkConfig; refreshAt: number }
  | null = null;
let twilioNetworkRequest: Promise<PttNetworkConfig | null> | null = null;

export function createPttSessionToken(
  user: PttUser,
  canDispatchRadio = false,
  now = Date.now(),
  owner = false,
  ownerRevision: string | null = null,
): string {
  const token = randomUUID();
  pttTokens.set(token, {
    user,
    expiresAt: now + SESSION_TTL_MS,
    canDispatchRadio,
    owner,
    ownerRevision,
  });
  return token;
}

function splitConfiguredUrls(value: string | undefined) {
  return (value || "")
    .split(/[,\s]+/)
    .map((url) => url.trim())
    .filter(Boolean);
}

function configuredTurnUrls(env: NodeJS.ProcessEnv) {
  return splitConfiguredUrls(
    env.PTT_TURN_URLS ?? env.TURN_URLS ?? env.PTT_TURN_URL ?? env.TURN_URL,
  );
}

function configuredStunUrls(env: NodeJS.ProcessEnv) {
  const urls = splitConfiguredUrls(env.PTT_STUN_URLS ?? env.STUN_URLS);
  return urls.length > 0 ? urls : DEFAULT_STUN_URLS;
}

function turnCredentialTtlSeconds(env: NodeJS.ProcessEnv) {
  const configured = Number.parseInt(
    env.PTT_TURN_CREDENTIAL_TTL_SECONDS ?? env.TURN_CREDENTIAL_TTL_SECONDS ?? "",
    10,
  );
  if (!Number.isFinite(configured)) return DEFAULT_TURN_CREDENTIAL_TTL_SECONDS;
  return Math.min(Math.max(configured, 60), 60 * 60);
}

export function maxTransmitMs(env: NodeJS.ProcessEnv = process.env) {
  const configured = Number.parseInt(env.PTT_MAX_TRANSMIT_MS ?? env.MAX_TRANSMIT_MS ?? "", 10);
  if (!Number.isFinite(configured)) return DEFAULT_MAX_TRANSMIT_MS;
  return Math.min(Math.max(configured, MIN_MAX_TRANSMIT_MS), MAX_MAX_TRANSMIT_MS);
}

/**
 * Build browser-safe ICE server entries. TURN credentials use the standard
 * coturn REST API format: an expiring timestamp-prefixed username and an
 * HMAC-SHA1 password derived from a server-only shared secret.
 */
export function getPttNetworkConfig(now = Date.now(), env: NodeJS.ProcessEnv = process.env): PttNetworkConfig {
  const turnUrls = configuredTurnUrls(env);
  const sharedSecret = (
    env.PTT_TURN_SHARED_SECRET ??
    env.TURN_SHARED_SECRET ??
    ""
  ).trim();
  const iceServers: PttIceServer[] = [{ urls: configuredStunUrls(env) }];

  if (turnUrls.length > 0 && sharedSecret) {
    const ttlSeconds = turnCredentialTtlSeconds(env);
    const expiresAtSeconds = Math.floor(now / 1000) + ttlSeconds;
    const username = `${expiresAtSeconds}:${randomUUID()}`;
    const credential = createHmac("sha1", sharedSecret).update(username).digest("base64");
    iceServers.push({
      urls: turnUrls,
      username,
      credential,
      credentialType: "password",
    });
    return {
      iceServers,
      relayConfigured: true,
      turnCredentialExpiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    };
  }

  if (turnUrls.length > 0 && !warnedTurnConfiguration) {
    warnedTurnConfiguration = true;
    logger.warn("PTT TURN URLs are configured without a shared secret; relay candidates are disabled.");
  }

  return {
    iceServers,
    relayConfigured: false,
    turnCredentialExpiresAt: null,
  };
}

type TwilioIceServer = {
  url?: string;
  urls?: string;
  username?: string;
  credential?: string;
};

export function normalizeTwilioIceServers(servers: TwilioIceServer[]): PttIceServer[] {
  return servers.flatMap((server) => {
    const urls = server.urls || server.url;
    if (!urls) return [];
    const normalized: PttIceServer = { urls };
    if (server.username && server.credential) {
      normalized.username = server.username;
      normalized.credential = server.credential;
      normalized.credentialType = "password";
    }
    return [normalized];
  });
}

async function getPttSessionNetworkConfig(
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<PttNetworkConfig> {
  const configured = getPttNetworkConfig(now, env);
  if (configured.relayConfigured) return configured;

  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid || !authToken) return configured;
  if (cachedTwilioNetwork && cachedTwilioNetwork.refreshAt > now) return cachedTwilioNetwork.config;
  if (twilioNetworkRequest) return (await twilioNetworkRequest) ?? configured;

  twilioNetworkRequest = (async () => {
    try {
      const requestedTtlSeconds = 60 * 60;
      const token = await twilio(accountSid, authToken).tokens.create({ ttl: requestedTtlSeconds });
      const iceServers = normalizeTwilioIceServers(token.iceServers);
      const relayConfigured = iceServers.some((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some((url) => url.startsWith("turn:") || url.startsWith("turns:"));
      });
      if (!relayConfigured) {
        logger.warn("Twilio Network Traversal token did not include a TURN server.");
        return null;
      }
      const ttlSeconds = Math.max(60, Number.parseInt(token.ttl, 10) || requestedTtlSeconds);
      const config: PttNetworkConfig = {
        iceServers,
        relayConfigured: true,
        turnCredentialExpiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
      };
      cachedTwilioNetwork = {
        config,
        refreshAt: now + Math.max(60, ttlSeconds - 5 * 60) * 1000,
      };
      return config;
    } catch (error) {
      logger.warn({ error }, "Unable to obtain Twilio Network Traversal credentials; using direct ICE only.");
      return null;
    } finally {
      twilioNetworkRequest = null;
    }
  })();

  return (await twilioNetworkRequest) ?? configured;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : fallback;
}

const CONNECTION_STATES = ["new", "connecting", "connected", "disconnected", "failed", "closed", "unknown"] as const;
const ICE_CONNECTION_STATES = ["new", "checking", "connected", "completed", "disconnected", "failed", "closed", "unknown"] as const;
const CANDIDATE_TYPES = ["host", "srflx", "prflx", "relay", "unknown"] as const;
const RTC_PATHS = ["relay", "direct", "unknown"] as const;

function telemetryOutcome(telemetry: PttRtcTelemetry): "connected" | "failed" | null {
  if (telemetry.connectionState === "failed" || telemetry.iceConnectionState === "failed") return "failed";
  if (
    telemetry.connectionState === "connected" &&
    (telemetry.iceConnectionState === "connected" || telemetry.iceConnectionState === "completed") &&
    telemetry.path !== "unknown"
  ) return "connected";
  return null;
}

function storeRtcTelemetry(channelId: ChannelId, telemetry: PttRtcTelemetry) {
  const outcome = telemetryOutcome(telemetry);
  if (!outcome) return;
  void pool.query(
    `INSERT INTO ptt_rtc_telemetry (channel_id, outcome, path, failure_reason)
     VALUES ($1, $2, $3, $4)`,
    [isDirectChannelId(channelId) ? "private" : channelId, outcome, telemetry.path, outcome === "failed" ? telemetry.failureReason ?? "Unspecified connection failure" : null],
  ).catch((error) => logger.warn({ error }, "Unable to persist PTT RTC telemetry"));
}

function recordRtcTelemetry(client: PttClient, message: PttMessage) {
  const remoteId = typeof message.remoteId === "string" ? message.remoteId.trim() : "";
  const remote = remoteId ? pttClients.get(remoteId) : undefined;
  if (!remoteId || remoteId === client.id || remote?.channelId !== client.channelId) return;

  const telemetry: PttRtcTelemetry = {
    connectionState: enumValue(message.connectionState, CONNECTION_STATES, "unknown"),
    iceConnectionState: enumValue(message.iceConnectionState, ICE_CONNECTION_STATES, "unknown"),
    path: enumValue(message.path, RTC_PATHS, "unknown"),
    candidateType: enumValue(message.candidateType, CANDIDATE_TYPES, "unknown"),
  };
  if (typeof message.failureReason === "string" && message.failureReason.trim()) {
    telemetry.failureReason = message.failureReason.trim().slice(0, 240);
  }

  const previous = client.rtcTelemetry.get(remoteId);
  if (previous && JSON.stringify(previous) === JSON.stringify(telemetry)) return;
  client.rtcTelemetry.set(remoteId, telemetry);
  if (client.channelId && telemetryOutcome(previous ?? {
    connectionState: "unknown",
    iceConnectionState: "unknown",
    path: "unknown",
    candidateType: "unknown",
  }) !== telemetryOutcome(telemetry)) {
    storeRtcTelemetry(client.channelId, telemetry);
  }
  logger.info({
    pttClientId: client.id,
    remoteId,
    channelId: client.channelId,
    connectionState: telemetry.connectionState,
    iceConnectionState: telemetry.iceConnectionState,
    path: telemetry.path,
    candidateType: telemetry.candidateType,
    failureReason: telemetry.failureReason,
  }, "PTT WebRTC telemetry");
}

export function canUseDispatchRadio(canDispatchRadio: boolean, channelId: ChannelId | undefined): boolean {
  return canDispatchRadio && channelId === ROIP_CHANNEL_ID;
}

export function shouldForwardBrowserAudioToRoip(input: {
  canDispatchRadio: boolean;
  channelId: ChannelId | undefined;
  holdsFloor: boolean;
  transportReady: boolean;
}): boolean {
  return canUseDispatchRadio(input.canDispatchRadio, input.channelId) &&
    input.holdsFloor &&
    input.transportReady;
}

/** One of the shared talk groups (Dispatch, Field, Priority). */
export function isPttChannelId(value: unknown): value is ChannelId {
  return channelExists(value);
}

export function isDirectChannelId(value: unknown): value is DirectChannelId {
  return typeof value === "string" && DIRECT_CHANNEL_PATTERN.test(value);
}

export function directChannelIdForGroup(groupId: string): DirectChannelId {
  return `direct:${groupId}`;
}

function knownChannel(value: unknown): value is ChannelId {
  return channelExists(value) || isDirectChannelId(value);
}

/** Only the caller and the people they rang may join a private call. */
export async function canJoinDirectChannel(userId: string, channelId: DirectChannelId): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM ptt_pages
     WHERE group_id = $1::uuid AND (caller_user_id = $2 OR target_user_id = $2)
       AND created_at > NOW() - ($3 * INTERVAL '1 hour')
     LIMIT 1`,
    [channelId.slice("direct:".length), userId, DIRECT_CHANNEL_TTL_HOURS],
  );
  return result.rows.length > 0;
}

/** The talk group each connected PTT user is monitoring (undefined = connected, no channel yet). */
export function connectedPttUserChannels(): Map<string, ChannelId | undefined> {
  const channels = new Map<string, ChannelId | undefined>();
  for (const client of pttClientsByUser.values()) {
    if (!client.closed) channels.set(client.user.id, client.channelId);
  }
  return channels;
}

function channelExists(value: unknown): value is ChannelId {
  return PTT_CHANNELS.some((channel) => channel.id === value);
}

function sendJson(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= 256 * 1024) {
    ws.send(JSON.stringify(payload));
  }
}

function clientsInChannel(channelId: ChannelId) {
  return Array.from(pttClients.values()).filter((client) => client.channelId === channelId);
}

function broadcastChannel(channelId: ChannelId, payload: unknown, exceptId?: string) {
  for (const client of clientsInChannel(channelId)) {
    if (client.id !== exceptId) sendJson(client.ws, payload);
  }
}

function publicUser(client: PttClient) {
  return {
    id: client.id,
    name: client.user.name,
    email: client.user.email,
    isTalking: channelFloors.get(client.channelId!) === client.id,
  };
}

function channelState(channelId: ChannelId) {
  return {
    channelId,
    users: clientsInChannel(channelId).map(publicUser),
    floorHolder: channelFloors.get(channelId) ?? null,
  };
}

/**
 * The radio gateway is bounded by GATEWAY_HANGOVER_MS, never by the operator
 * transmit limit, so it deliberately gets no deadline entry.
 *
 * `renewing` is true when the current holder re-requests a floor it already
 * owns. That must not restart the clock, or a client re-pressing on a timer
 * would hold the channel forever and the limit would be cosmetic. A future
 * dispatcher override should be an explicit exemption keyed off
 * `canDispatchRadio`, not a reopening of this path.
 */
function grantFloor(channelId: ChannelId, holderId: string, now: number, renewing: boolean) {
  channelFloors.set(channelId, holderId);
  if (holderId === ROIP_GATEWAY_HOLDER) channelFloorGrantedAt.delete(channelId);
  else if (!renewing || !channelFloorGrantedAt.has(channelId)) channelFloorGrantedAt.set(channelId, now);
}

function clearFloor(channelId: ChannelId) {
  channelFloors.delete(channelId);
  channelFloorGrantedAt.delete(channelId);
}

export function shouldForceReleaseFloor(input: {
  holderId: string | undefined;
  grantedAt: number | null;
  now: number;
  maxTransmitMs: number;
}) {
  if (!input.holderId || input.holderId === ROIP_GATEWAY_HOLDER) return false;
  if (input.grantedAt === null) return false;
  return input.now - input.grantedAt >= input.maxTransmitMs;
}

function leaveChannel(client: PttClient) {
  const channelId = client.channelId;
  if (!channelId) return;

  if (channelFloors.get(channelId) === client.id) {
    clearFloor(channelId);
    broadcastChannel(channelId, {
      type: "floor",
      action: "released",
      clientId: client.id,
      userName: client.user.name,
    });
  }

  client.channelId = undefined;
  client.rtcTelemetry.clear();
  broadcastChannel(channelId, {
    type: "user-left",
    clientId: client.id,
  });
}

function enterChannel(client: PttClient, nextChannel: ChannelId) {
  if (client.channelId === nextChannel) {
    sendJson(client.ws, {
      type: "channel-state",
      ...channelState(nextChannel),
      gateway: nextChannel === ROIP_CHANNEL_ID ? getRoipGatewayStatus() : undefined,
    });
    return;
  }
  leaveChannel(client);
  client.channelId = nextChannel;
  sendJson(client.ws, {
    type: "channel-state",
    ...channelState(nextChannel),
    gateway: nextChannel === ROIP_CHANNEL_ID ? getRoipGatewayStatus() : undefined,
  });
  broadcastChannel(nextChannel, {
    type: "user-joined",
    user: publicUser(client),
  }, client.id);
}

function removeClient(client: PttClient) {
  if (pttClients.get(client.id) !== client) return;
  leaveChannel(client);
  pttClients.delete(client.id);
  if (pttClientsByUser.get(client.user.id) === client) {
    pttClientsByUser.delete(client.user.id);
  }
}

function getSessionUser(req: Request): PttUser {
  const auth = getAuth(req);
  const claims = auth.sessionClaims;
  const claim = (key: string): string | undefined => {
    const value = claims?.[key];
    return typeof value === "string" ? value : undefined;
  };
  const email = claim("email");
  const name = [claim("firstName"), claim("lastName")].filter(Boolean).join(" ").trim();
  return {
    id: String(req.dbUser?.id || claim("userId") || "operator"),
    name: name || email || "Operator",
    email,
  };
}

export function registerPttRoutes(app: Express) {
  registerRoipRoutes(app);
  app.get("/api/ptt/telemetry", requireAuth, async (req, res) => {
    if (!isAdminUser(req)) {
      res.status(403).json({ error: "Owner access required" });
      return;
    }

    const hoursRaw = Number.parseInt(String(req.query.hours ?? "24"), 10);
    const hours = [24, 168, 720].includes(hoursRaw) ? hoursRaw : 24;
    const channelId = typeof req.query.channelId === "string" && channelExists(req.query.channelId)
      ? req.query.channelId
      : null;
    const bucket = hours <= 24 ? "hour" : "day";

    try {
      const params: unknown[] = [hours];
      const channelClause = channelId ? `AND channel_id = $2` : "";
      if (channelId) params.push(channelId);
      const [summary, trend, reasons, activeIncident] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE outcome = 'connected')::int AS connected,
             COUNT(*) FILTER (WHERE outcome = 'connected' AND path = 'relay')::int AS relay,
             COUNT(*) FILTER (WHERE outcome = 'failed')::int AS failed
           FROM ptt_rtc_telemetry
           WHERE recorded_at >= NOW() - ($1 * INTERVAL '1 hour') ${channelClause}`,
          params,
        ),
        pool.query(
          `SELECT date_trunc('${bucket}', recorded_at) AS bucket,
             COUNT(*) FILTER (WHERE outcome = 'connected')::int AS connected,
             COUNT(*) FILTER (WHERE outcome = 'connected' AND path = 'relay')::int AS relay,
             COUNT(*) FILTER (WHERE outcome = 'failed')::int AS failed
           FROM ptt_rtc_telemetry
           WHERE recorded_at >= NOW() - ($1 * INTERVAL '1 hour') ${channelClause}
           GROUP BY 1 ORDER BY 1`,
          params,
        ),
        pool.query(
          `SELECT failure_reason AS reason, COUNT(*)::int AS count
           FROM ptt_rtc_telemetry
           WHERE recorded_at >= NOW() - ($1 * INTERVAL '1 hour')
             AND outcome = 'failed' ${channelClause}
           GROUP BY failure_reason ORDER BY count DESC, failure_reason LIMIT 5`,
          params,
        ),
        pool.query(
          `SELECT EXISTS (
             SELECT 1 FROM ptt_rtc_telemetry
             WHERE recorded_at >= NOW() - INTERVAL '15 minutes'
               AND outcome = 'failed' ${channelId ? "AND channel_id = $1" : ""}
           ) AS active`,
          channelId ? [channelId] : [],
        ),
      ]);
      const totals = summary.rows[0] ?? { connected: 0, relay: 0, failed: 0 };
      res.json({
        filters: { hours, channelId, bucket },
        summary: {
          connected: totals.connected,
          relay: totals.relay,
          failed: totals.failed,
          relayRate: totals.connected > 0 ? Math.round((totals.relay / totals.connected) * 100) : 0,
        },
        trend: trend.rows.map((row) => ({ ...row, bucket: new Date(row.bucket).toISOString() })),
        failureReasons: reasons.rows,
        incidentActive: activeIncident.rows[0]?.active === true,
      });
      return;
    } catch (error) {
      req.log?.error({ error }, "Unable to summarize PTT telemetry");
      res.status(500).json({ error: "Unable to load PTT relay health" });
      return;
    }
  });
  app.get("/api/ptt/session", requireAuth, async (req, res) => {
    if (!(await canAccessFeature(req, "communications"))) {
      res.status(403).json({ error: "Approved communications access required" });
      return;
    }
    const network = await getPttSessionNetworkConfig();
    // Network configuration can take time to fetch; do not issue a token based
    // on approval captured before an owner-status change.
    if (!(await canAccessFeature(req, "communications"))) {
      res.status(403).json({ error: "Approved communications access required" });
      return;
    }
    const user = getSessionUser(req);
    const owner = isOwnerIdentity(req);
    const ownerAccess = owner ? await currentOwnerAccess(user.email) : null;
    if (ownerAccess && !ownerAccess.approved) {
      res.status(403).json({ error: "Approved communications access required" });
      return;
    }
    const token = createPttSessionToken(user, isAdminUser(req), Date.now(), owner, ownerAccess?.revision);

    res.json({
      token,
      expiresInSeconds: SESSION_TTL_MS / 1000,
      maxTransmitMs: maxTransmitMs(),
      channels: PTT_CHANNELS,
      network,
      iceServers: network.iceServers,
      roip: {
        ...getRoipGatewayStatus(),
        websocketPath: "/ws/roip",
        protocol: ROIP_PROTOCOL,
      },
    });
  });
}

// A role/status change invalidates already-issued tokens and connected sockets,
// not just the next HTTP request for a session.
export function revokePttUserSessions(userId: string, ownerEmail?: string): void {
  const matches = (user: PttUser) => user.id === userId ||
    Boolean(ownerEmail && user.email?.trim().toLowerCase() === ownerEmail.trim().toLowerCase());
  for (const [token, entry] of pttTokens) {
    if (matches(entry.user)) pttTokens.delete(token);
  }
  for (const client of Array.from(pttClients.values()).filter((entry) => matches(entry.user))) {
    client.closed = true;
    removeClient(client);
    client.ws.close(1008, "Dispatch access changed");
  }
}

function takeToken(rawToken: string | null): PttToken | null {
  if (!rawToken) return null;
  const entry = pttTokens.get(rawToken);
  pttTokens.delete(rawToken);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry;
}

async function currentOwnerAccess(email: string | undefined): Promise<{ approved: boolean; revision: string | null }> {
  if (!email) return { approved: false, revision: null };
  const result = await pool.query(
    `SELECT p.approval_status, p.updated_at FROM auth_users u
     JOIN staff_access_profiles p ON p.user_id = u.id
     WHERE LOWER(u.email) = $1 AND EXISTS (
       SELECT 1 FROM staff_access_audit a
       WHERE a.target_user_id = u.id AND a.action = 'owner_status_updated'
     )
     ORDER BY CASE p.approval_status WHEN 'suspended' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END
     LIMIT 1`,
    [email.trim().toLowerCase()],
  );
  const row = result.rows[0];
  return {
    approved: !row || row.approval_status === "approved",
    revision: row ? new Date(row.updated_at).toISOString() : null,
  };
}

function parseMessage(raw: WebSocket.RawData) {
  if (raw.toString().length > 32_000) return null;
  try {
    const parsed = JSON.parse(raw.toString()) as PttMessage;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function setupPttServer(httpServer: Server) {
  // Read once per server so an integration test can set the env before setup.
  const transmitLimitMs = maxTransmitMs();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 48 * 1024 });
  const handlePttUpgrade = (request: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    if (requestUrl.pathname !== "/ws/ptt") return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  };
  httpServer.on("upgrade", handlePttUpgrade);
  const roipWss = setupRoipServer(httpServer);
  const removeRoipMediaListener = onRoipMedia((payload) => {
    const now = Date.now();
    const holder = channelFloors.get(ROIP_CHANNEL_ID);
    const voiced = isNonSilentPcmuFrame(payload);
    if (voiced) {
      if (holder && holder !== ROIP_GATEWAY_HOLDER) return;
      gatewayLastVoiceAt = now;
      if (!holder) {
        grantFloor(ROIP_CHANNEL_ID, ROIP_GATEWAY_HOLDER, now, false);
        broadcastChannel(ROIP_CHANNEL_ID, {
          type: "floor", action: "granted", clientId: ROIP_GATEWAY_HOLDER, userName: "Radio gateway",
        });
      }
    }
    if (channelFloors.get(ROIP_CHANNEL_ID) !== ROIP_GATEWAY_HOLDER) return;
    broadcastChannel(ROIP_CHANNEL_ID, {
      type: "roip-media",
      protocol: ROIP_PROTOCOL,
      channelId: ROIP_CHANNEL_ID,
      codec: ROIP_CODEC,
      sampleRate: ROIP_SAMPLE_RATE,
      payload,
    });
  });
  const removeRoipStatusListener = onRoipStatus((gateway) => {
    broadcastChannel(ROIP_CHANNEL_ID, {
      type: "gateway-status",
      protocol: ROIP_PROTOCOL,
      gateway,
    });
  });

  wss.on("connection", async (ws, request) => {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    const rawToken = requestUrl.searchParams.get("token");
    const pending = rawToken ? pttTokens.get(rawToken) : undefined;
    if (pending?.owner) {
      try {
        const access = await currentOwnerAccess(pending.user.email);
        if (!access.approved || access.revision !== pending.ownerRevision) {
          ws.close(1008, "Dispatch access changed");
          return;
        }
      } catch (error) {
        logger.error({ error }, "Unable to verify PTT owner approval");
        ws.close(1011, "PTT authorization unavailable");
        return;
      }
    }
    // Take only after the database check: a concurrent status change may have
    // removed this token while the check was in flight.
    const token = takeToken(rawToken);
    if (!token) {
      ws.close(1008, "PTT session expired");
      return;
    }

    const previousClient = pttClientsByUser.get(token.user.id);
    if (previousClient) {
      previousClient.closed = true;
      removeClient(previousClient);
      previousClient.ws.close(4000, "PTT session replaced");
    }

    const client: PttClient = {
      id: randomUUID(),
      ws,
      user: token.user,
      isAlive: true,
      closed: false,
      canDispatchRadio: token.canDispatchRadio,
      lastRoipFrameAt: null,
      rtcTelemetry: new Map(),
    };
    pttClients.set(client.id, client);
    pttClientsByUser.set(client.user.id, client);

    sendJson(ws, {
      type: "hello",
      clientId: client.id,
      operator: client.user,
      maxTransmitMs: transmitLimitMs,
      channels: PTT_CHANNELS,
    });

    ws.on("pong", () => {
      client.isAlive = true;
    });

    ws.on("message", (raw) => {
      if (
        client.closed ||
        pttClients.get(client.id) !== client ||
        pttClientsByUser.get(client.user.id) !== client
      ) {
        return;
      }
      const message = parseMessage(raw);
      if (!message || typeof message.type !== "string") {
        sendJson(ws, { type: "error", message: "Invalid PTT message." });
        return;
      }

      if (message.type === "join") {
        if (!knownChannel(message.channelId)) {
          sendJson(ws, { type: "error", message: "Unknown PTT channel." });
          return;
        }
        const nextChannel = message.channelId;
        if (isDirectChannelId(nextChannel) && client.channelId !== nextChannel) {
          void canJoinDirectChannel(client.user.id, nextChannel).then((allowed) => {
            if (client.closed || pttClients.get(client.id) !== client) return;
            if (!allowed) {
              sendJson(ws, { type: "error", message: "You are not part of this private call." });
              return;
            }
            enterChannel(client, nextChannel);
          }).catch((error) => {
            logger.error({ error }, "Unable to verify PTT private call membership");
            sendJson(ws, { type: "error", message: "Unable to join the private call." });
          });
          return;
        }
        enterChannel(client, nextChannel);
        return;
      }

      if (message.type === "floor-request") {
        const channelId = client.channelId;
        if (!channelId || message.channelId !== channelId) {
          sendJson(ws, { type: "error", message: "Join a channel before transmitting." });
          return;
        }
        const currentHolder = channelFloors.get(channelId);
        if (currentHolder && currentHolder !== client.id) {
          sendJson(ws, {
            type: "floor",
            action: "denied",
            clientId: currentHolder,
            requesterId: client.id,
            reason: "Channel is busy.",
          });
          return;
        }
        grantFloor(channelId, client.id, Date.now(), currentHolder === client.id);
        broadcastChannel(channelId, {
          type: "floor",
          action: "granted",
          clientId: client.id,
          userName: client.user.name,
        });
        return;
      }

      if (message.type === "floor-release") {
        const channelId = client.channelId;
        if (!channelId || message.channelId !== channelId) return;
        if (channelId && channelFloors.get(channelId) === client.id) {
          clearFloor(channelId);
          broadcastChannel(channelId, {
            type: "floor",
            action: "released",
            clientId: client.id,
            userName: client.user.name,
          });
        }
        return;
      }

      if (message.type === "signal") {
        if (!knownChannel(message.channelId) || message.channelId !== client.channelId) return;
        const targetId = typeof message.to === "string" ? message.to : "";
        const target = pttClients.get(targetId);
        if (
          target &&
          target.channelId &&
          target.channelId === message.channelId &&
          message.payload &&
          typeof message.payload === "object"
        ) {
          sendJson(target.ws, {
            type: "signal",
            from: client.id,
            channelId: message.channelId,
            payload: message.payload,
          });
        }
        return;
      }

      if (message.type === "rtc-telemetry") {
        recordRtcTelemetry(client, message);
        return;
      }

      if (message.type === "roip-media") {
        const channelId = client.channelId;
        const now = Date.now();
        const transportReady = isRoipTransportReady();
        const canForward = shouldForwardBrowserAudioToRoip({
          canDispatchRadio: client.canDispatchRadio,
          channelId,
          holdsFloor: Boolean(channelId && channelFloors.get(channelId) === client.id),
          transportReady,
        });
        if (!canForward) {
          if (canUseDispatchRadio(client.canDispatchRadio, channelId) && !transportReady) {
            sendJson(ws, { type: "gateway-warning", message: "Radio bridge offline. Browser PTT remains active." });
          }
          return;
        }
        if (client.lastRoipFrameAt !== null && now - client.lastRoipFrameAt < 10) return;
        if (!sendBrowserAudioToRoip(message.payload)) {
          sendJson(ws, { type: "gateway-warning", message: "Radio bridge could not accept audio. Browser PTT remains active." });
          return;
        }
        client.lastRoipFrameAt = now;
        return;
      }

      if (message.type === "ping") {
        sendJson(ws, { type: "pong" });
        return;
      }

      sendJson(ws, { type: "error", message: "Unsupported PTT message." });
    });

    ws.on("close", () => {
      client.closed = true;
      removeClient(client);
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of Array.from(pttClients.values())) {
      if (!client.isAlive) {
        client.closed = true;
        client.ws.terminate();
        continue;
      }
      client.isAlive = false;
      client.ws.ping();
    }
    const now = Date.now();
    for (const [token, entry] of Array.from(pttTokens.entries())) {
      if (entry.expiresAt < now) pttTokens.delete(token);
    }
  }, 30_000);
  const floorTimer = setInterval(() => {
    const now = Date.now();
    if (channelFloors.get(ROIP_CHANNEL_ID) === ROIP_GATEWAY_HOLDER &&
        gatewayLastVoiceAt !== null && now - gatewayLastVoiceAt > GATEWAY_HANGOVER_MS) {
      clearFloor(ROIP_CHANNEL_ID);
      gatewayLastVoiceAt = null;
      broadcastChannel(ROIP_CHANNEL_ID, {
        type: "floor", action: "released", clientId: ROIP_GATEWAY_HOLDER, userName: "Radio gateway",
      });
    }
    for (const [channelId, grantedAt] of Array.from(channelFloorGrantedAt.entries())) {
      const holderId = channelFloors.get(channelId);
      if (!holderId) {
        channelFloorGrantedAt.delete(channelId);
        continue;
      }
      if (!shouldForceReleaseFloor({ holderId, grantedAt, now, maxTransmitMs: transmitLimitMs })) continue;
      clearFloor(channelId);
      broadcastChannel(channelId, {
        type: "floor",
        action: "released",
        clientId: holderId,
        userName: pttClients.get(holderId)?.user.name,
        reason: "Maximum transmit time reached.",
        forced: true,
      });
      logger.info(
        { channelId, pttClientId: holderId, transmitLimitMs },
        "PTT floor force-released at the transmit limit",
      );
    }
  }, 100);

  wss.on("close", () => {
    httpServer.off("upgrade", handlePttUpgrade);
    clearInterval(heartbeat);
    clearInterval(floorTimer);
    removeRoipMediaListener();
    removeRoipStatusListener();
    roipWss.close();
  });
  return wss;
}