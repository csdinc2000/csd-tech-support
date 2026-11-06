/**
 * Shared pieces of PTT "ring": the app-wide ringing pop-up
 * (components/ptt/ptt-ring-alerts.tsx), the "Ring staff" panel on the PTT
 * console and the console itself.
 *
 * Ringing specific people opens a private call (`direct:<uuid>`) only they and
 * the caller can join; ringing everyone uses a shared talk group.
 */

export type IncomingRing = {
  id: number;
  groupId: string;
  callerUserId: string;
  callerName: string;
  channelId: string;
  channelName: string;
  createdAt: string;
  expiresAt: string;
};

export type IncomingRingsResponse = { serverTime: string; rings: IncomingRing[] };

export type PttRosterEntry = {
  id: string;
  name: string;
  email: string | null;
  role: string;
  avatarUrl: string | null;
  online: boolean;
  pttChannelId: string | null;
  onPtt: boolean;
};

export type RingStatus = "ringing" | "answered" | "declined" | "cancelled" | "missed";

export type RingGroup = {
  groupId: string;
  channelId: string;
  createdAt: string;
  expiresAt: string;
  pages: Array<{ id: number; targetUserId: string; name: string; status: RingStatus; respondedAt: string | null }>;
};

/** Fired on window to move an already-open PTT console into a call. */
export const PTT_JOIN_EVENT = "csd:ptt-join";
export type PttJoinDetail = { channelId: string; label?: string };

const DIRECT_CHANNEL_PATTERN = /^direct:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHARED_CHANNELS = ["dispatch", "field", "priority"];

export function isDirectChannel(channelId: string | null | undefined): boolean {
  return typeof channelId === "string" && DIRECT_CHANNEL_PATTERN.test(channelId);
}

export function isJoinableChannel(channelId: string | null | undefined): channelId is string {
  return typeof channelId === "string" && (SHARED_CHANNELS.includes(channelId) || isDirectChannel(channelId));
}

/** `/ptt?channel=…&with=…` — what Answer opens. */
export function pttCallPath(channelId: string, label?: string): string {
  const params = new URLSearchParams({ channel: channelId });
  if (label) params.set("with", label);
  return `/ptt?${params.toString()}`;
}

/** Channel + label the console should open, read from its own URL. */
export function pttCallFromSearch(search: string): PttJoinDetail | null {
  const params = new URLSearchParams(search);
  const channelId = params.get("channel");
  if (!isJoinableChannel(channelId)) return null;
  const label = params.get("with")?.trim().slice(0, 120) || undefined;
  return { channelId, label };
}

/** Pop-up headline, e.g. "Private call" or "Everyone · Dispatch". */
export function describeRing(ring: Pick<IncomingRing, "channelId" | "channelName">): string {
  return isDirectChannel(ring.channelId) ? "Private call" : `All staff · ${ring.channelName}`;
}

/** Seconds left on a ring, corrected for clock skew using the server's timestamp. */
export function ringSecondsLeft(ring: Pick<IncomingRing, "expiresAt">, serverTime: string, receivedAt: number, now = Date.now()): number {
  const remainingAtServer = new Date(ring.expiresAt).getTime() - new Date(serverTime).getTime();
  return Math.max(0, Math.ceil((remainingAtServer - (now - receivedAt)) / 1000));
}

export const RING_STATUS_LABEL: Record<RingStatus, string> = {
  ringing: "Ringing…",
  answered: "Answered",
  declined: "Declined",
  cancelled: "Cancelled",
  missed: "No answer",
};
