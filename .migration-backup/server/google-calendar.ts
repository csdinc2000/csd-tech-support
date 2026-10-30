// Google Calendar integration via Replit Connectors.
// Auth + token refresh handled by the SDK — never cache the proxy result.
// Blueprint id: google-calendar (added via integrations skill).
import { ReplitConnectors } from "@replit/connectors-sdk";
import type { ProxyOptions } from "@replit/connectors-sdk";

const connectors = new ReplitConnectors();

async function gc<T = any>(path: string, init?: ProxyOptions): Promise<T> {
  const res = await connectors.proxy("google-calendar", path, init || { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google Calendar API ${res.status} ${path}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export interface CalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
  backgroundColor?: string;
}

export interface FreeBusyRange {
  start: string;
  end: string;
}

export interface CalendarEventInput {
  summary: string;
  description?: string;
  startIso: string;
  endIso: string;
  timezone: string;
  attendees?: { email: string; displayName?: string }[];
  location?: string;
  reference?: string; // our internal CSD-A-… reference, embedded in extendedProperties
}

export const googleCalendarService = {
  // Health check — also returns the calendar list so the UI can verify the
  // attached account is the one the user expects (e.g. csdinc2000@gmail.com).
  async getStatus(): Promise<{ connected: boolean; calendars?: CalendarListEntry[]; account?: string; error?: string }> {
    try {
      const list = await gc<{ items?: CalendarListEntry[] }>("/calendar/v3/users/me/calendarList");
      const calendars = list.items || [];
      const primary = calendars.find((c) => c.primary);
      return { connected: true, calendars, account: primary?.id };
    } catch (e: any) {
      return { connected: false, error: e?.message || String(e) };
    }
  },

  async listCalendars(): Promise<CalendarListEntry[]> {
    const list = await gc<{ items?: CalendarListEntry[] }>("/calendar/v3/users/me/calendarList");
    return list.items || [];
  },

  // Returns busy ranges for a calendar between two ISO instants.
  async getBusy(calendarId: string, timeMinIso: string, timeMaxIso: string): Promise<FreeBusyRange[]> {
    const body = {
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      items: [{ id: calendarId }],
    };
    const res = await gc<{ calendars?: Record<string, { busy?: FreeBusyRange[]; errors?: any[] }> }>(
      "/calendar/v3/freeBusy",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
    const cal = res.calendars?.[calendarId];
    return cal?.busy || [];
  },

  // Push a new appointment to the chosen calendar. Returns the Google event id.
  async createEvent(calendarId: string, input: CalendarEventInput): Promise<string | null> {
    const event: any = {
      summary: input.summary,
      description: input.description,
      location: input.location,
      start: { dateTime: input.startIso, timeZone: input.timezone },
      end: { dateTime: input.endIso, timeZone: input.timezone },
    };
    if (input.attendees?.length) {
      event.attendees = input.attendees.map((a) => ({ email: a.email, displayName: a.displayName }));
    }
    if (input.reference) {
      event.extendedProperties = { private: { csdReference: input.reference } };
    }
    const created = await gc<{ id?: string; htmlLink?: string }>(
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) },
    );
    return created.id || null;
  },

  async updateEvent(calendarId: string, eventId: string, patch: Partial<CalendarEventInput>): Promise<void> {
    const body: any = {};
    if (patch.summary) body.summary = patch.summary;
    if (patch.description) body.description = patch.description;
    if (patch.location) body.location = patch.location;
    if (patch.startIso && patch.timezone) body.start = { dateTime: patch.startIso, timeZone: patch.timezone };
    if (patch.endIso && patch.timezone) body.end = { dateTime: patch.endIso, timeZone: patch.timezone };
    await gc(
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
  },

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await gc(
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: "DELETE" },
    );
  },
};
