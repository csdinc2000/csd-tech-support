const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";
const ZOOM_API_BASE = "https://api.zoom.us/v2";
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 12_000;

type ZoomTokenResponse = {
  access_token?: string;
  expires_in?: number;
};

type ZoomMeetingResponse = {
  id?: string | number;
  join_url?: string;
};

type CachedToken = { value: string; expiresAt: number };
type ZoomFetch = typeof fetch;

let cachedToken: CachedToken | null = null;
let pendingToken: Promise<CachedToken> | null = null;
let fetchZoom: ZoomFetch = (...args) => fetch(...args);

export class ZoomMeetingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ZoomMeetingError";
  }
}

export function isZoomConfigured(): boolean {
  return Boolean(
    process.env.ZOOM_ACCOUNT_ID?.trim()
    && process.env.ZOOM_CLIENT_ID?.trim()
    && process.env.ZOOM_CLIENT_SECRET?.trim(),
  );
}

async function requestAccessToken(): Promise<CachedToken> {
  if (!isZoomConfigured()) {
    throw new ZoomMeetingError("Zoom Server-to-Server OAuth is not configured.");
  }

  const accountId = process.env.ZOOM_ACCOUNT_ID!.trim();
  const clientId = process.env.ZOOM_CLIENT_ID!.trim();
  const clientSecret = process.env.ZOOM_CLIENT_SECRET!.trim();
  const authorization = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "account_credentials",
    account_id: accountId,
  });

  let response: Response;
  try {
    response = await fetchZoom(ZOOM_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${authorization}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ZoomMeetingError("Could not reach Zoom authorization.");
  }
  if (!response.ok) throw new ZoomMeetingError("Zoom authorization was rejected.", response.status);

  let payload: ZoomTokenResponse;
  try {
    payload = await response.json() as ZoomTokenResponse;
  } catch {
    throw new ZoomMeetingError("Zoom returned an invalid authorization response.");
  }
  if (!payload.access_token || !Number.isFinite(payload.expires_in) || !payload.expires_in) {
    throw new ZoomMeetingError("Zoom returned an incomplete authorization response.");
  }

  const token = {
    value: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000 - TOKEN_EXPIRY_MARGIN_MS,
  };
  cachedToken = token;
  return token;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  pendingToken ??= requestAccessToken();
  try {
    return (await pendingToken).value;
  } finally {
    pendingToken = null;
  }
}

async function zoomRequest<T>(
  path: string,
  init: { method: "POST" | "DELETE"; body?: unknown },
): Promise<T | null> {
  const token = await getAccessToken();
  let response: Response;
  try {
    response = await fetchZoom(`${ZOOM_API_BASE}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ZoomMeetingError("Could not reach the Zoom meeting service.");
  }
  if (!response.ok) {
    if (response.status === 401 && cachedToken?.value === token) cachedToken = null;
    throw new ZoomMeetingError("Zoom rejected the meeting request.", response.status);
  }
  if (response.status === 204) return null;
  try {
    return await response.json() as T;
  } catch {
    throw new ZoomMeetingError("Zoom returned an invalid meeting response.", response.status);
  }
}

export async function createZoomMeeting(input: {
  hostEmail: string;
  summary: string;
  description?: string;
  startIso: string;
  endIso: string;
  timezone: string;
}): Promise<{ id: string; joinUrl: string }> {
  const duration = Math.ceil((Date.parse(input.endIso) - Date.parse(input.startIso)) / 60_000);
  const created = await zoomRequest<ZoomMeetingResponse>(
    `/users/${encodeURIComponent(input.hostEmail)}/meetings`,
    {
      method: "POST",
      body: {
        topic: input.summary,
        type: 2,
        start_time: input.startIso,
        duration,
        timezone: input.timezone,
        ...(input.description ? { agenda: input.description } : {}),
        settings: {
          join_before_host: false,
          waiting_room: true,
        },
      },
    },
  );

  if (!created?.id || !created.join_url) {
    throw new ZoomMeetingError("Zoom did not return a meeting ID and join link.");
  }
  let joinUrl: URL;
  try {
    joinUrl = new URL(created.join_url);
  } catch {
    throw new ZoomMeetingError("Zoom returned an invalid meeting link.");
  }
  if (joinUrl.protocol !== "https:" || !(joinUrl.hostname === "zoom.us" || joinUrl.hostname.endsWith(".zoom.us"))) {
    throw new ZoomMeetingError("Zoom returned an invalid meeting link.");
  }
  return { id: String(created.id), joinUrl: joinUrl.toString() };
}

export async function deleteZoomMeeting(meetingId: string): Promise<void> {
  await zoomRequest(`/meetings/${encodeURIComponent(meetingId)}`, { method: "DELETE" });
}

export function __setZoomFetchForTests(fetcher?: ZoomFetch): void {
  fetchZoom = fetcher ?? ((...args) => fetch(...args));
  cachedToken = null;
  pendingToken = null;
}
