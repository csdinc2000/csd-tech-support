import { randomBytes } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import twilio from "twilio";
import { WebSocket, WebSocketServer } from "ws";
import { canonicalPublicAppBaseUrl } from "./shared/roip-config";

export const ROIP_CHANNEL_ID = "dispatch";
export const ROIP_PROTOCOL = "CSD-RoIP/1";
export const ROIP_GATEWAY_HOLDER = "roip-gateway";
export const ROIP_CODEC = "PCMU";
export const ROIP_SAMPLE_RATE = 8000;
const STREAM_TOKEN_TTL_MS = 60_000;
const LIVE_WINDOW_MS = 2_000;
export const PCMU_FRAME_BYTES = 160;
const MAX_SOCKET_BUFFERED_BYTES = 256 * 1024;

type TokenEntry = { expiresAt: number };
type StatusListener = (status: RoipGatewayStatus) => void;
type MediaListener = (payload: string) => void;

export type RoipGatewayStatus = {
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  ready: boolean;
  live: boolean;
  lastSeen: string | null;
  lastMediaAt: string | null;
  disconnectReason: string | null;
  vendor: string;
  model: string;
  codec: typeof ROIP_CODEC;
  sampleRate: typeof ROIP_SAMPLE_RATE;
  physicalChannel: string;
  channelMapping: {
    physicalChannel: string;
    channelId: typeof ROIP_CHANNEL_ID;
    talkGroup: string;
  };
  channelId: typeof ROIP_CHANNEL_ID;
  protocol: typeof ROIP_PROTOCOL;
  singleInstanceRequired: boolean;
};

export class SingleUseTokenStore {
  private readonly entries = new Map<string, TokenEntry>();
  constructor(private readonly ttlMs = STREAM_TOKEN_TTL_MS) {}

  issue(now = Date.now()): string {
    const token = randomBytes(32).toString("base64url");
    this.entries.set(token, { expiresAt: now + this.ttlMs });
    return token;
  }

  take(token: string | null | undefined, now = Date.now()): boolean {
    if (!token) return false;
    const entry = this.entries.get(token);
    this.entries.delete(token);
    return Boolean(entry && entry.expiresAt >= now);
  }

  sweep(now = Date.now()): void {
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt < now) this.entries.delete(token);
    }
  }
}

export function getRoipConfig(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.ROIP_ENABLED === "true" || env.ROIP_ENABLED === "1";
  const sipDomain = env.ROIP_SIP_DOMAIN?.trim() || "";
  const sipUsername = env.ROIP_SIP_USERNAME?.trim() || "";
  const sipPassword = env.ROIP_SIP_PASSWORD?.trim() || "";
  const parsedBaseUrl = canonicalPublicAppBaseUrl(env.APP_BASE_URL);
  const appBaseUrl = parsedBaseUrl.ok ? parsedBaseUrl.origin : "";
  const singleInstanceRequired = env.ROIP_SINGLE_INSTANCE !== "true";
  const vendor = env.ROIP_GATEWAY_VENDOR?.trim() || "Twilio";
  const model = env.ROIP_GATEWAY_MODEL?.trim() || "SIP Domain Media Stream bridge";
  const physicalChannel = env.ROIP_GATEWAY_PHYSICAL_CHANNEL?.trim() || "dispatch";
  const talkGroup = env.ROIP_GATEWAY_TALK_GROUP?.trim() || "Dispatch";
  return {
    enabled,
    sipDomain,
    sipUsername,
    credentialConfigured: Boolean(sipUsername && sipPassword),
    appBaseUrl,
    singleInstanceRequired,
    vendor,
    model,
    physicalChannel,
    talkGroup,
    configured:
      enabled &&
      !singleInstanceRequired &&
      parsedBaseUrl.ok &&
      Boolean(sipDomain && sipUsername && sipPassword && env.TWILIO_AUTH_TOKEN),
  };
}

const streamTokens = new SingleUseTokenStore();
let activeSocket: WebSocket | null = null;
let activeStreamSid: string | null = null;
let lastSeenAt: number | null = null;
let lastMediaAt: number | null = null;
let disconnectReason: string | null = null;
const statusListeners = new Set<StatusListener>();
const mediaListeners = new Set<MediaListener>();

export function getRoipGatewayStatus(now = Date.now()): RoipGatewayStatus {
  const config = getRoipConfig();
  return {
    configured: config.configured,
    enabled: config.enabled,
    connected: activeSocket?.readyState === WebSocket.OPEN,
    ready: activeSocket?.readyState === WebSocket.OPEN && activeStreamSid !== null,
    live: activeSocket?.readyState === WebSocket.OPEN && lastMediaAt !== null && now - lastMediaAt <= LIVE_WINDOW_MS,
    lastSeen: lastSeenAt === null ? null : new Date(lastSeenAt).toISOString(),
    lastMediaAt: lastMediaAt === null ? null : new Date(lastMediaAt).toISOString(),
    disconnectReason,
    vendor: config.vendor,
    model: config.model,
    codec: ROIP_CODEC,
    sampleRate: ROIP_SAMPLE_RATE,
    physicalChannel: config.physicalChannel,
    channelMapping: {
      physicalChannel: config.physicalChannel,
      channelId: ROIP_CHANNEL_ID,
      talkGroup: config.talkGroup,
    },
    channelId: ROIP_CHANNEL_ID,
    protocol: ROIP_PROTOCOL,
    singleInstanceRequired: config.singleInstanceRequired,
  };
}

export function isRoipTransportReady(): boolean {
  return getRoipGatewayStatus().ready;
}

export function onRoipStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function onRoipMedia(listener: MediaListener): () => void {
  mediaListeners.add(listener);
  return () => mediaListeners.delete(listener);
}

function notifyStatus() {
  const status = getRoipGatewayStatus();
  for (const listener of statusListeners) listener(status);
}

function isSupportedMediaFormat(start: any): boolean {
  const mediaFormat = start?.mediaFormat;
  if (!mediaFormat) return true;
  const encoding = typeof mediaFormat.encoding === "string" ? mediaFormat.encoding.toLowerCase() : "";
  const sampleRate = Number(mediaFormat.sampleRate);
  const channels = mediaFormat.channels === undefined ? 1 : Number(mediaFormat.channels);
  return (!encoding || encoding === "audio/x-mulaw" || encoding === "pcmu") &&
    (!sampleRate || sampleRate === ROIP_SAMPLE_RATE) &&
    channels === 1;
}

export function registerRoipRoutes(app: Express): void {
  app.post("/webhooks/roip/sip", (req, res) => {
    const config = getRoipConfig();
    if (!config.configured) {
      res.status(503).type("text/plain").send("RoIP is not configured");
      return;
    }
    const token = streamTokens.issue();
    const streamUrl = `${config.appBaseUrl.replace(/^http/, "ws")}/ws/roip?token=${encodeURIComponent(token)}`;
    const response = new twilio.twiml.VoiceResponse();
    response.connect().stream({ url: streamUrl });
    res.type("text/xml").send(response.toString());
  });
}

export function validPcmuFrame(payload: unknown): payload is string {
  if (typeof payload !== "string" || payload.length !== 216 || !/^[A-Za-z0-9+/]{214}==$/.test(payload)) return false;
  try {
    return Buffer.from(payload, "base64").length === PCMU_FRAME_BYTES;
  } catch {
    return false;
  }
}

/** Conservative VAD: PCMU digital silence is 0xff; weak codec noise does not seize a floor. */
export function isNonSilentPcmuFrame(payload: string): boolean {
  if (!validPcmuFrame(payload)) return false;
  const bytes = Buffer.from(payload, "base64");
  let total = 0;
  for (const byte of bytes) {
    const ulaw = (~byte) & 0xff;
    const magnitude = (((ulaw & 0x0f) << 3) + 0x84) << ((ulaw >> 4) & 7);
    total += Math.abs((ulaw & 0x80) ? 0x84 - magnitude : magnitude - 0x84);
  }
  return total / PCMU_FRAME_BYTES >= 650;
}

export class FrameCadenceGate {
  private lastAt: number | null = null;
  accept(now = Date.now()): boolean {
    if (this.lastAt !== null && now - this.lastAt < 10) return false;
    this.lastAt = now;
    return true;
  }
}

export function sendBrowserAudioToRoip(payload: unknown): boolean {
  if (!validPcmuFrame(payload) || !activeStreamSid || activeSocket?.readyState !== WebSocket.OPEN ||
      activeSocket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) return false;
  activeSocket.send(JSON.stringify({
    event: "media",
    streamSid: activeStreamSid,
    media: { payload },
  }));
  return true;
}

export function setupRoipServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const handleRoipUpgrade = (request: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    if (requestUrl.pathname !== "/ws/roip") return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  };
  httpServer.on("upgrade", handleRoipUpgrade);
  wss.on("connection", (ws, request) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (!getRoipConfig().enabled || !streamTokens.take(url.searchParams.get("token"))) {
      ws.close(1008, "Unauthorized RoIP stream");
      return;
    }
    if (activeSocket?.readyState === WebSocket.OPEN) activeSocket.close(1012, "Gateway stream replaced");
    activeSocket = ws;
    activeStreamSid = null;
    lastSeenAt = Date.now();
    lastMediaAt = null;
    disconnectReason = null;
    const cadence = new FrameCadenceGate();
    notifyStatus();

    ws.on("message", (raw) => {
      if (activeSocket !== ws || raw.toString().length > 4096) return;
      let message: any;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      lastSeenAt = Date.now();
      if (message?.event === "start" && typeof message.start?.streamSid === "string") {
        if (!isSupportedMediaFormat(message.start)) {
          disconnectReason = "Gateway must use PCMU/8000 mono audio.";
          ws.close(1003, disconnectReason);
          notifyStatus();
          return;
        }
        activeStreamSid = message.start.streamSid;
        notifyStatus();
      } else if (message?.event === "media" && validPcmuFrame(message.media?.payload) && cadence.accept(lastSeenAt)) {
        lastMediaAt = lastSeenAt;
        for (const listener of mediaListeners) listener(message.media.payload);
        notifyStatus();
      } else if (message?.event === "stop") {
        ws.close(1000);
      }
    });
    ws.on("close", () => {
      if (activeSocket !== ws) return;
      activeSocket = null;
      activeStreamSid = null;
      lastSeenAt = Date.now();
      lastMediaAt = null;
      disconnectReason = "Gateway stream disconnected.";
      notifyStatus();
    });
  });

  const sweep = setInterval(() => streamTokens.sweep(), 30_000);
  wss.on("close", () => {
    httpServer.off("upgrade", handleRoipUpgrade);
    clearInterval(sweep);
  });
  return wss;
}