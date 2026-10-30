import type { Express, Request } from "express";
import { CreateStaffMeetingBody, CreateStaffMeetingResponse, ListMeetingStaffResponse } from "@workspace/api-zod";
import { pool } from "./db";
import { getTwilioSettings } from "./twilio-settings-storage";
import { googleCalendarService } from "./google-calendar";
import { queueStaffMeetingNotification } from "./slack";
import { createZoomMeeting, isZoomConfigured } from "./zoom-meetings";
import { rateLimit } from "./security";

export type MeetingStaffRow = { id: string; email: string; first_name: string | null; last_name: string | null };

const createMeetingLimiter = rateLimit({
  windowMs: 60_000,
  max: 8,
  key: (req) => req.dbUser?.id ?? req.ip ?? "unknown",
  message: "Too many meetings created. Please wait a minute.",
});

function configuredOwnerEmails(): string[] {
  return (process.env.ADMIN_EMAILS || process.env.CSD_ADMIN_EMAIL || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export async function getMeetingStaff(staffIds?: string[]): Promise<MeetingStaffRow[]> {
  const owners = configuredOwnerEmails();
  const result = await pool.query<MeetingStaffRow>(
    `SELECT u.id::text AS id, lower(trim(u.email)) AS email, u.first_name, u.last_name
     FROM auth_users u
     LEFT JOIN staff_access_profiles p ON p.user_id = u.id
     WHERE trim(COALESCE(u.email, '')) <> ''
       AND trim(u.email) ~* '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
       AND (p.user_id IS NOT NULL OR lower(trim(u.email)) = ANY($1::text[]))
       AND (
         CASE
           WHEN lower(trim(u.email)) = ANY($1::text[])
             AND NOT EXISTS (
               SELECT 1 FROM staff_access_audit owner_audit
               WHERE owner_audit.target_user_id = u.id
                 AND owner_audit.action = 'owner_status_updated'
             )
             THEN 'approved'
           ELSE p.approval_status
         END
       ) = 'approved'
       AND ($2::text[] IS NULL OR u.id::text = ANY($2::text[]))
     ORDER BY COALESCE(u.first_name, ''), COALESCE(u.last_name, ''), lower(trim(u.email)), u.id`,
    [owners, staffIds ?? null],
  );
  return result.rows;
}

export function displayName(staff: MeetingStaffRow): string {
  const name = [staff.first_name, staff.last_name].filter(Boolean).join(" ").trim();
  return name || staff.email;
}

export function registerStaffMeetingRoutes(app: Express): void {
  app.get("/api/calendar/meeting-staff", async (req, res): Promise<void> => {
    try {
      const staff = (await getMeetingStaff()).map((row) => ({
        id: row.id,
        name: displayName(row),
        email: row.email,
      }));
      res.json(ListMeetingStaffResponse.parse({ staff }));
    } catch {
      req.log.error("Could not load the meeting staff directory");
      res.status(500).json({ error: "Could not load staff for meeting invitations." });
    }
  });

  app.post("/api/calendar/meetings", createMeetingLimiter, async (req: Request, res): Promise<void> => {
    const parsed = CreateStaffMeetingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Enter a meeting title, valid times, and a staff selection." });
      return;
    }

    const input = parsed.data;
    const provider = input.provider ?? "google_meet";
    const startAt = input.startIso;
    const endAt = input.endIso;
    if (!isValidTimezone(input.timezone)) {
      res.status(400).json({ error: "Choose a valid time zone." });
      return;
    }
    if (startAt.getTime() <= Date.now() || endAt.getTime() <= startAt.getTime()) {
      res.status(400).json({ error: "The meeting must start in the future and end after it starts." });
      return;
    }

    const staffIds = [...new Set(input.staffIds)];
    const guestEmails = [...new Map(
      (input.guestEmails ?? []).map((guest) => [
        guest.email.trim().toLowerCase(),
        { name: guest.name.trim(), email: guest.email.trim().toLowerCase() },
      ]),
    ).values()];
    if (!input.inviteAllStaff && staffIds.length === 0 && guestEmails.length === 0) {
      res.status(400).json({ error: "Choose at least one staff member or guest to invite." });
      return;
    }

    const settings = await getTwilioSettings();
    if (!settings.schedulingCalendarId) {
      res.status(409).json({ error: "Attach a Google Calendar in Scheduling settings before creating meetings." });
      return;
    }
    if (provider === "zoom" && !isZoomConfigured()) {
      res.status(409).json({ error: "Zoom meeting creation is not configured. Contact an administrator." });
      return;
    }

    let invitees: MeetingStaffRow[];
    try {
      invitees = await getMeetingStaff(input.inviteAllStaff ? undefined : staffIds);
    } catch {
      req.log.error("Could not verify meeting invitees");
      res.status(500).json({ error: "Could not verify the staff selection." });
      return;
    }
    if ((!input.inviteAllStaff && invitees.length !== staffIds.length) || (input.inviteAllStaff && invitees.length === 0)) {
      res.status(409).json({ error: "The staff list changed. Refresh it and choose recipients again." });
      return;
    }
    const staffEmails = new Set(invitees.map((staff) => staff.email.trim().toLowerCase()));
    const calendarGuests = guestEmails.filter((guest) => !staffEmails.has(guest.email));

    const calendarInput = {
      summary: input.summary.trim(),
      description: input.description?.trim() || undefined,
      startIso: startAt.toISOString(),
      endIso: endAt.toISOString(),
      timezone: input.timezone,
       attendees: [
         ...invitees.map((staff) => ({ email: staff.email, displayName: displayName(staff) })),
         ...calendarGuests.map((guest) => ({ email: guest.email, displayName: guest.name })),
       ],
    };
    let event: { id: string; htmlLink: string | null };
    let meetUrl: string | null = null;
    let zoomUrl: string | null = null;
    try {
      if (provider === "zoom") {
        const hostEmail = req.dbUser?.email?.trim().toLowerCase();
        if (!hostEmail) {
          res.status(409).json({ error: "Your signed-in account needs an email address to host a Zoom meeting." });
          return;
        }
        const zoomMeeting = await createZoomMeeting({
          hostEmail,
          ...calendarInput,
        });
        zoomUrl = zoomMeeting.joinUrl;
        event = await googleCalendarService.createExternalMeetingEvent(
          settings.schedulingCalendarId,
          calendarInput,
          zoomUrl,
        );
      } else {
        const googleEvent = await googleCalendarService.createMeetEvent(
          settings.schedulingCalendarId,
          calendarInput,
        );
        event = { id: googleEvent.id, htmlLink: googleEvent.htmlLink };
        meetUrl = googleEvent.meetUrl;
      }
    } catch (error) {
      req.log.error(
        {
          provider,
          errorName: error instanceof Error ? error.name : "unknown",
          ...(provider === "zoom" && error instanceof Error && "status" in error
            ? { providerStatus: error.status }
            : {}),
        },
        provider === "zoom" ? "Zoom or Calendar meeting creation failed" : "Google Calendar meeting creation failed",
      );
      res.status(502).json({
        error: provider === "zoom"
          ? "Zoom or Calendar could not confirm the meeting. Check both services before trying again."
          : "Could not confirm the meeting was created. Check Google Calendar before trying again.",
      });
      return;
    }

    const slackQueued = await queueStaffMeetingNotification({
      eventId: event.id,
      summary: input.summary.trim(),
      startIso: startAt.toISOString(),
      timezone: input.timezone,
      provider,
      joinUrl: zoomUrl ?? meetUrl,
      eventUrl: event.htmlLink,
      staffInvited: invitees.length,
    });

    res.status(201).json(CreateStaffMeetingResponse.parse({
      eventId: event.id,
      eventUrl: event.htmlLink,
      provider,
      meetUrl,
      zoomUrl,
      staffInvited: invitees.length,
      guestInvited: calendarGuests.length,
      slackQueued,
    }));
  });
}
