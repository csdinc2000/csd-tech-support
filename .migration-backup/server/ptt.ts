import type { Express, Request } from "express";
import type { Server } from "http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { isAuthenticated } from "./replit_integrations/auth";
import { isAdminUser } from "./security";
import {
  getRoipGatewayStatus,
  onRoipMedia,
  onRoipStatus,
  registerRoipRoutes,
  ROIP_CHANNEL_ID,
  ROIP_GATEWAY_HOLDER,
  ROIP_PROTOCOL,
  isNonSilentPcmuFrame,
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

type ChannelId = (typeof PTT_CHANNELS)[number]["id"];

type PttUser = {
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
  canDispatchRadio: boolean;
  lastRoipFrameAt: number | null;
};

type PttToken = {
  user: PttUser;
  expiresAt: number;
  canDispatchRadio: boolean;
};

type PttMessage = {
  type?: unknown;
  channelId?: unknown;
  to?: unknown;
  payload?: unknown;
};

const SESSION_TTL_MS = 5 * 60 * 1000;
const pttTokens = new Map<string, PttToken>();
const pttClients = new Map<string, PttClient>();
const channelFloors = new Map<ChannelId, string>();
const GATEWAY_HANGOVER_MS = 350;
let gatewayLastVoiceAt: number | null = null;

export function canUseDispatchRadio(canDispatchRadio: boolean, channelId: ChannelId | undefined): boolean {
  return canDispatchRadio && channelId === ROIP_CHANNEL_ID;
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

function leaveChannel(client: PttClient) {
  const channelId = client.channelId;
  if (!channelId) return;

  if (channelFloors.get(channelId) === client.id) {
    channelFloors.delete(channelId);
    broadcastChannel(channelId, {
      type: "floor",
      action: "released",
      clientId: client.id,
      userName: client.user.name,
    });
  }

  client.channelId = undefined;
  broadcastChannel(channelId, {
    type: "user-left",
    clientId: client.id,
  });
}

function getSessionUser(req: Request): PttUser {
  const user = req.user as {
    claims?: { sub?: string; email?: string; first_name?: string; last_name?: string };
  } | undefined;
  const claims = user?.claims;
  const name = [claims?.first_name, claims?.last_name].filter(Boolean).join(" ").trim();
  return {
    id: claims?.sub || claims?.email || "operator",
    name: name || claims?.email || "Operator",
    email: claims?.email,
  };
}

export function registerPttRoutes(app: Express) {
  registerRoipRoutes(app);
  app.get("/api/ptt/session", isAuthenticated, (req, res) => {
    const token = randomUUID();
    pttTokens.set(token, {
      user: getSessionUser(req),
      expiresAt: Date.now() + SESSION_TTL_MS,
      canDispatchRadio: isAdminUser(req),
    });

    res.json({
      token,
      expiresInSeconds: SESSION_TTL_MS / 1000,
      channels: PTT_CHANNELS,
      roip: {
        ...getRoipGatewayStatus(),
        websocketPath: "/ws/roip",
        protocol: ROIP_PROTOCOL,
      },
    });
  });
}

function takeToken(rawToken: string | null): PttToken | null {
  if (!rawToken) return null;
  const entry = pttTokens.get(rawToken);
  pttTokens.delete(rawToken);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry;
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
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/ptt", maxPayload: 48 * 1024 });
  const roipWss = setupRoipServer(httpServer);
  const removeRoipMediaListener = onRoipMedia((payload) => {
    const now = Date.now();
    const holder = channelFloors.get(ROIP_CHANNEL_ID);
    const voiced = isNonSilentPcmuFrame(payload);
    if (voiced) {
      if (holder && holder !== ROIP_GATEWAY_HOLDER) return;
      gatewayLastVoiceAt = now;
      if (!holder) {
        channelFloors.set(ROIP_CHANNEL_ID, ROIP_GATEWAY_HOLDER);
        broadcastChannel(ROIP_CHANNEL_ID, {
          type: "floor", action: "granted", clientId: ROIP_GATEWAY_HOLDER, userName: "Radio gateway",
        });
      }
    }
    if (channelFloors.get(ROIP_CHANNEL_ID) !== ROIP_GATEWAY_HOLDER) return;
    broadcastChannel(ROIP_CHANNEL_ID, {
      type: "roip-media", protocol: ROIP_PROTOCOL, channelId: ROIP_CHANNEL_ID, codec: "PCMU", sampleRate: 8000, payload,
    });
  });
  const removeRoipStatusListener = onRoipStatus((gateway) => {
    broadcastChannel(ROIP_CHANNEL_ID, {
      type: "gateway-status",
      protocol: ROIP_PROTOCOL,
      gateway,
    });
  });

  wss.on("connection", (ws, request) => {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    const token = takeToken(requestUrl.searchParams.get("token"));
    if (!token) {
      ws.close(1008, "PTT session expired");
      return;
    }

    const client: PttClient = {
      id: randomUUID(),
      ws,
      user: token.user,
      isAlive: true,
      canDispatchRadio: token.canDispatchRadio,
      lastRoipFrameAt: null,
    };
    pttClients.set(client.id, client);

    sendJson(ws, {
      type: "hello",
      clientId: client.id,
      operator: client.user,
      channels: PTT_CHANNELS,
    });

    ws.on("pong", () => {
      client.isAlive = true;
    });

    ws.on("message", (raw) => {
      const message = parseMessage(raw);
      if (!message || typeof message.type !== "string") {
        sendJson(ws, { type: "error", message: "Invalid PTT message." });
        return;
      }

      if (message.type === "join") {
        if (!channelExists(message.channelId)) {
          sendJson(ws, { type: "error", message: "Unknown PTT channel." });
          return;
        }
        const nextChannel = message.channelId;
        if (nextChannel === ROIP_CHANNEL_ID && !client.canDispatchRadio) {
          sendJson(ws, { type: "error", message: "Dispatch radio access requires an administrator account." });
          return;
        }
        if (client.channelId === nextChannel) {
          sendJson(ws, { type: "channel-state", ...channelState(nextChannel) });
          return;
        }
        leaveChannel(client);
        client.channelId = nextChannel;
        sendJson(ws, { type: "channel-state", ...channelState(nextChannel) });
        broadcastChannel(nextChannel, {
          type: "user-joined",
          user: publicUser(client),
        }, client.id);
        return;
      }

      if (message.type === "floor-request") {
        const channelId = client.channelId;
        if (!channelId) {
          sendJson(ws, { type: "error", message: "Join a channel before transmitting." });
          return;
        }
        if (channelId === ROIP_CHANNEL_ID && !client.canDispatchRadio) {
          sendJson(ws, { type: "error", message: "Dispatch radio access requires an administrator account." });
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
        channelFloors.set(channelId, client.id);
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
        if (channelId && channelFloors.get(channelId) === client.id) {
          channelFloors.delete(channelId);
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
        const targetId = typeof message.to === "string" ? message.to : "";
        const target = pttClients.get(targetId);
        if (
          target &&
          target.channelId &&
          target.channelId === client.channelId &&
          message.payload &&
          typeof message.payload === "object"
        ) {
          sendJson(target.ws, {
            type: "signal",
            from: client.id,
            payload: message.payload,
          });
        }
        return;
      }

      if (message.type === "roip-media") {
        const channelId = client.channelId;
        const now = Date.now();
        if (
          channelId !== ROIP_CHANNEL_ID ||
          !client.canDispatchRadio ||
          channelFloors.get(channelId) !== client.id ||
          (client.lastRoipFrameAt !== null && now - client.lastRoipFrameAt < 10) ||
          !sendBrowserAudioToRoip(message.payload)
        ) {
          sendJson(ws, { type: "error", message: "RoIP media rejected." });
        } else {
          client.lastRoipFrameAt = now;
        }
        return;
      }

      if (message.type === "ping") {
        sendJson(ws, { type: "pong" });
        return;
      }

      sendJson(ws, { type: "error", message: "Unsupported PTT message." });
    });

    ws.on("close", () => {
      leaveChannel(client);
      pttClients.delete(client.id);
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of Array.from(pttClients.values())) {
      if (!client.isAlive) {
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
  const gatewayFloorTimer = setInterval(() => {
    const now = Date.now();
    if (channelFloors.get(ROIP_CHANNEL_ID) !== ROIP_GATEWAY_HOLDER ||
        gatewayLastVoiceAt === null || now - gatewayLastVoiceAt <= GATEWAY_HANGOVER_MS) return;
    channelFloors.delete(ROIP_CHANNEL_ID);
    gatewayLastVoiceAt = null;
    broadcastChannel(ROIP_CHANNEL_ID, {
      type: "floor", action: "released", clientId: ROIP_GATEWAY_HOLDER, userName: "Radio gateway",
    });
  }, 100);

  wss.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(gatewayFloorTimer);
    removeRoipMediaListener();
    removeRoipStatusListener();
    roipWss.close();
  });
  return wss;
}