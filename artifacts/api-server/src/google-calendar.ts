// Google Calendar integration via Replit Connectors.
// Auth + token refresh handled by the SDK — never cache the proxy result.
// Blueprint id: google-calendar (added via integrations skill).
import { ReplitConnectors } from "@replit/connectors-sdk";
import type { ProxyOptions } from "@replit/connectors-sdk";
import { randomUUID } from "node:crypto";

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

export interface GoogleMeetEventResult {
  id: string;
  htmlLink: string | null;
  meetUrl: string | null;
}

export interface GoogleCalendarEvent {
  id: string;
  summary: string;
  description: string | null;
  location: string | null;
  startIso: string | null;
  endIso: string | null;
  htmlLink: string | null;
  status: string;
  attendees: { email: string; displayName?: string }[];
  reference: string | null;
}

export function buildGoogleMeetEventPayload(input: CalendarEventInput): Record<string, unknown> {
  const event: Record<string, unknown> = {
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: { dateTime: input.startIso, timeZone: input.timezone },
    end: { dateTime: input.endIso, timeZone: input.timezone },
    conferenceData: {
      createRequest: {
        requestId: randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };
  if (input.attendees?.length) {
    event.attendees = input.attendees.map((attendee) => ({
      email: attendee.email,
      displayName: attendee.displayName,
    }));
  }
  return event;
}

export function buildGoogleMeetEventRequestPath(calendarId: string): string {
  const params = new URLSearchParams({
    conferenceDataVersion: "1",
    sendUpdates: "all",
  });
  return `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
}

export const googleCalendarService = {
  // Health check — also returns the calendar list so the UI can verify the
  // attached account is the one the user expects (e.g. calendar@example.com).
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

  async listEvents(calendarId: string, timeMin: string, timeMax: string): Promise<GoogleCalendarEvent[]> {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "2500",
    });
    const result = await gc<{ items?: Array<Record<string, any>> }>(
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    );
    return (result.items ?? []).filter((event) => event.id && event.status !== "cancelled").map((event) => ({
      id: String(event.id),
      summary: String(event.summary ?? "(No title)"),
      description: event.description == null ? null : String(event.description),
      location: event.location == null ? null : String(event.location),
      startIso: event.start?.dateTime ?? event.start?.date ?? null,
      endIso: event.end?.dateTime ?? event.end?.date ?? null,
      htmlLink: event.htmlLink ?? null,
      status: String(event.status ?? "confirmed"),
      attendees: Array.isArray(event.attendees)
        ? event.attendees.map((attendee: any) => ({
            email: String(attendee.email ?? ""),
            displayName: attendee.displayName ? String(attendee.displayName) : undefined,
          })).filter((attendee: { email: string }) => attendee.email)
        : [],
      reference: event.extendedProperties?.private?.csdReference ?? null,
    }));
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

  // Meeting events request a Google Meet conference and send Calendar invitations.
  async createMeetEvent(calendarId: string, input: CalendarEventInput): Promise<GoogleMeetEventResult> {
    const created = await gc<{
      id?: string;
      htmlLink?: string;
      hangoutLink?: string;
      conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
    }>(
      buildGoogleMeetEventRequestPath(calendarId),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGoogleMeetEventPayload(input)),
      },
    );
    const id = created.id;
    if (!id) throw new Error("Google Calendar did not return a meeting event ID");
    const meetUrl = created.hangoutLink
      || created.conferenceData?.entryPoints?.find((entryPoint) => entryPoint.entryPointType === "video")?.uri
      || null;
    return { id, htmlLink: created.htmlLink || null, meetUrl };
  },

  // Create a Calendar invitation around a third-party meeting link, and send
  // updates to attendees. No Google Meet conference is requested for this event.
  async createExternalMeetingEvent(
    calendarId: string,
    input: CalendarEventInput,
    joinUrl: string,
  ): Promise<{ id: string; htmlLink: string | null }> {
    const description = [input.description?.trim(), `Join meeting: ${joinUrl}`]
      .filter(Boolean)
      .join("\n\n");
    const event: Record<string, unknown> = {
      summary: input.summary,
      description,
      location: joinUrl,
      start: { dateTime: input.startIso, timeZone: input.timezone },
      end: { dateTime: input.endIso, timeZone: input.timezone },
      attendees: input.attendees?.map((attendee) => ({
        email: attendee.email,
        displayName: attendee.displayName,
      })) ?? [],
    };
    const params = new URLSearchParams({ sendUpdates: "all" });
    const created = await gc<{ id?: string; htmlLink?: string }>(
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(event) },
    );
    if (!created.id) throw new Error("Google Calendar did not return an event ID");
    return { id: created.id, htmlLink: created.htmlLink || null };
  },

  async updateEvent(calendarId: string, eventId: string, patch: Partial<CalendarEventInput>): Promise<void> {
    const body: any = {};
    if (patch.summary !== undefined) body.summary = patch.summary;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.location !== undefined) body.location = patch.location;
    if (patch.startIso && patch.timezone) body.start = { dateTime: patch.startIso, timeZone: patch.timezone };
    if (patch.endIso && patch.timezone) body.end = { dateTime: patch.endIso, timeZone: patch.timezone };
    const params = new URLSearchParams({ sendUpdates: "all" });
    await gc(
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?${params}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
  },

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    const params = new URLSearchParams({ sendUpdates: "all" });
    await gc(
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?${params}`,
      { method: "DELETE" },
    );
  },
};
