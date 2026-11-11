import type { Express, Request, Response } from "express";
import { z } from "zod/v4";
import { pool } from "./db";
import { getStaffAccess, getStaffAssignmentScope } from "./staff-access";
import { getTwilioSettings } from "./twilio-settings-storage";
import { googleCalendarService } from "./google-calendar";

const rangeSchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});
const eventSchema = z.object({
  summary: z.string().trim().min(1).max(200),
  description: z.string().max(4000).optional(),
  location: z.string().max(500).optional(),
  startIso: z.string().datetime({ offset: true }),
  endIso: z.string().datetime({ offset: true }),
  timezone: z.string().min(1).max(100),
  attendees: z.array(z.object({ email: z.string().email(), displayName: z.string().max(200).optional() })).max(100).optional(),
});

function validTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); return true; } catch { return false; }
}

async function requireCalendarManager(req: Request, res: Response): Promise<boolean> {
  const access = await getStaffAccess(req);
  if (!access.features.scheduling) {
    res.status(403).json({ error: "Scheduling access is required to change calendar events." });
    return false;
  }
  return true;
}

export function registerStaffCalendarRoutes(app: Express): void {
  app.get("/api/staff-calendar/events", async (req, res): Promise<void> => {
    const access = await getStaffAccess(req);
    if (!access.features.scheduling && !access.features.operations) {
      res.status(403).json({ error: "Calendar access is required." });
      return;
    }
    const range = rangeSchema.safeParse(req.query);
    if (!range.success || new Date(range.data.to).getTime() <= new Date(range.data.from).getTime()) {
      res.status(400).json({ error: "Choose a valid calendar date range." });
      return;
    }
    const from = new Date(range.data.from);
    const to = new Date(range.data.to);
    if (to.getTime() - from.getTime() > 100 * 24 * 60 * 60_000) {
      res.status(400).json({ error: "Calendar ranges cannot exceed 100 days." });
      return;
    }

    try {
      if (access.features.scheduling) {
        const settings = await getTwilioSettings();
        if (!settings.schedulingCalendarId) {
          res.json({ events: [], canManage: true, configured: false, source: "unconfigured" });
          return;
        }
        const [calendarEvents, appointments] = await Promise.all([
          googleCalendarService.listEvents(settings.schedulingCalendarId, from.toISOString(), to.toISOString()),
          pool.query(
            `SELECT a.id, a.reference, a.google_event_id, a.starts_at, a.ends_at, a.status,
                    a.customer_name, s.name AS service_name
             FROM appointments a LEFT JOIN services s ON s.id = a.service_id
             WHERE a.starts_at >= $1 AND a.starts_at < $2`,
            [from, to],
          ),
        ]);
        const appointmentsByReference = new Map(appointments.rows.map((row) => [String(row.reference), row]));
        const seen = new Set<string>();
        const events = calendarEvents.map((event) => {
          const appointment = event.reference ? appointmentsByReference.get(event.reference) : undefined;
          if (appointment) seen.add(String(appointment.id));
          return {
            ...event,
            kind: appointment ? "appointment" : "event",
            appointmentId: appointment ? Number(appointment.id) : null,
            customerName: appointment ? appointment.customer_name : null,
            serviceName: appointment ? appointment.service_name : null,
            appointmentStatus: appointment ? appointment.status : null,
            editable: appointment
              ? Boolean(appointment.google_event_id) && ["pending", "confirmed", "in_progress"].includes(String(appointment.status))
              : true,
          };
        });
        for (const row of appointments.rows) {
          if (seen.has(String(row.id))) continue;
          events.push({
            id: row.google_event_id ? String(row.google_event_id) : `appointment-${row.id}`,
            summary: `${row.service_name || "Appointment"} — ${row.customer_name}`,
            description: `Reference: ${row.reference}`,
            location: null,
            startIso: new Date(row.starts_at).toISOString(),
            endIso: new Date(row.ends_at).toISOString(),
            htmlLink: null,
            status: row.status,
            attendees: [],
            reference: String(row.reference),
            kind: "appointment",
            appointmentId: Number(row.id),
            customerName: row.customer_name,
            serviceName: row.service_name,
            appointmentStatus: row.status,
            editable: Boolean(row.google_event_id),
          });
        }
        events.sort((a, b) => Date.parse(a.startIso ?? "") - Date.parse(b.startIso ?? ""));
        res.json({ events, canManage: true, configured: true, source: "shared-calendar" });
        return;
      }

      const scope = await getStaffAssignmentScope(req);
      const rows = await pool.query(
        `SELECT DISTINCT a.id, a.reference, a.google_event_id, a.starts_at, a.ends_at, a.status,
                a.customer_name, a.customer_phone, s.name AS service_name
         FROM appointments a
         LEFT JOIN services s ON s.id = a.service_id
         LEFT JOIN crm_contacts c ON c.id = a.contact_id
         WHERE a.starts_at >= $1 AND a.starts_at < $2
           AND (
             a.contact_id = ANY($3::int[]) OR c.client_id = ANY($4::int[])
             OR EXISTS (
               SELECT 1 FROM appointment_resources ar
               JOIN booking_resources br ON br.id = ar.resource_id AND br.type = 'staff'
               JOIN users legacy_user ON legacy_user.id = br.user_id
               JOIN auth_users auth_user ON lower(auth_user.email) = lower(legacy_user.email)
               WHERE ar.appointment_id = a.id AND auth_user.id = $5
             )
           )
         ORDER BY a.starts_at`,
        [from, to, [...scope.contactIds], [...scope.clientIds], req.dbUser?.id ?? null],
      );
      res.json({
        events: rows.rows.map((row) => ({
          id: row.google_event_id || `appointment-${row.id}`,
          summary: `${row.service_name || "Appointment"} — ${row.customer_name}`,
          description: null,
          location: null,
          startIso: new Date(row.starts_at).toISOString(),
          endIso: new Date(row.ends_at).toISOString(),
          htmlLink: null,
          status: row.status,
          attendees: [],
          reference: row.reference,
          kind: "appointment",
          appointmentId: Number(row.id),
          customerName: row.customer_name,
          customerPhone: row.customer_phone,
          serviceName: row.service_name,
          appointmentStatus: row.status,
          editable: false,
        })),
        canManage: false,
        configured: true,
        source: "assigned-appointments",
      });
    } catch (error) {
      req.log.error({ errorName: error instanceof Error ? error.name : "unknown" }, "Staff calendar read failed");
      res.status(502).json({
        error: access.features.scheduling
          ? "Google Calendar could not be reached. Check or reconnect it in Scheduling settings."
          : "Could not load appointments assigned to you.",
      });
    }
  });

  app.post("/api/staff-calendar/events", async (req, res): Promise<void> => {
    if (!(await requireCalendarManager(req, res))) return;
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Enter a title, valid time, and time zone." }); return; }
    const input = parsed.data;
    if (!validTimezone(input.timezone) || new Date(input.endIso) <= new Date(input.startIso)) {
      res.status(400).json({ error: "Choose a valid time zone and an end time after the start." });
      return;
    }
    try {
      const settings = await getTwilioSettings();
      if (!settings.schedulingCalendarId) { res.status(409).json({ error: "No shared booking calendar is attached." }); return; }
      const id = await googleCalendarService.createEvent(settings.schedulingCalendarId, input);
      res.status(201).json({ eventId: id });
    } catch (error) {
      req.log.error({ errorName: error instanceof Error ? error.name : "unknown" }, "Calendar event creation failed");
      res.status(502).json({ error: "Could not create the calendar event." });
    }
  });

  app.patch("/api/staff-calendar/events/:eventId", async (req, res): Promise<void> => {
    if (!(await requireCalendarManager(req, res))) return;
    const parsed = eventSchema.partial().safeParse(req.body);
    if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
      res.status(400).json({ error: "Enter valid changes to the calendar event." });
      return;
    }
    const patch = parsed.data;
    if ((patch.startIso || patch.endIso) && (!patch.startIso || !patch.endIso || new Date(patch.endIso) <= new Date(patch.startIso))) {
      res.status(400).json({ error: "Provide both a start and end time, with the end after the start." });
      return;
    }
    if (patch.timezone && !validTimezone(patch.timezone)) {
      res.status(400).json({ error: "Choose a valid time zone." });
      return;
    }
    try {
      const settings = await getTwilioSettings();
      if (!settings.schedulingCalendarId) { res.status(409).json({ error: "No shared booking calendar is attached." }); return; }
      const eventId = String(req.params.eventId);
      const appointment = await pool.query(
        "SELECT id, starts_at, ends_at, status FROM appointments WHERE google_event_id = $1 AND google_calendar_id = $2",
        [eventId, settings.schedulingCalendarId],
      );
      if (appointment.rows[0] && !["pending", "confirmed", "in_progress"].includes(String(appointment.rows[0].status))) {
        res.status(409).json({ error: "Only active customer appointments can be rescheduled here." });
        return;
      }
      if (appointment.rows[0] && (patch.summary || patch.description || patch.location || patch.attendees)) {
        res.status(400).json({ error: "Customer appointment details can only be changed through its appointment record; edit the time here." });
        return;
      }
      await googleCalendarService.updateEvent(settings.schedulingCalendarId, eventId, {
        ...patch,
        timezone: patch.timezone || "America/New_York",
      });
      if (appointment.rows[0] && patch.startIso && patch.endIso) {
        const row = appointment.rows[0];
        try {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const conflicts = await client.query(
              `SELECT 1 FROM appointment_resources current
               JOIN appointment_resources other ON other.resource_id = current.resource_id
               WHERE current.appointment_id = $1 AND other.appointment_id <> $1
                 AND other.status IN ('pending','confirmed','in_progress')
                 AND other.starts_at < $3 AND other.ends_at > $2
               LIMIT 1`,
              [row.id, patch.startIso, patch.endIso],
            );
            if (conflicts.rowCount) throw new Error("APPOINTMENT_CONFLICT");
            await client.query("UPDATE appointments SET starts_at=$2, ends_at=$3, updated_at=NOW() WHERE id=$1", [row.id, patch.startIso, patch.endIso]);
            await client.query("UPDATE appointment_resources SET starts_at=$2, ends_at=$3 WHERE appointment_id=$1", [row.id, patch.startIso, patch.endIso]);
            await client.query("COMMIT");
          } catch (error) {
            await client.query("ROLLBACK");
            await googleCalendarService.updateEvent(settings.schedulingCalendarId, eventId, {
              startIso: new Date(row.starts_at).toISOString(),
              endIso: new Date(row.ends_at).toISOString(),
              timezone: patch.timezone || "America/New_York",
            });
            if (error instanceof Error && error.message === "APPOINTMENT_CONFLICT") {
              res.status(409).json({ error: "That time conflicts with another appointment assigned to this technician." });
              return;
            }
            throw error;
          } finally {
            client.release();
          }
        } catch (error) {
          if (res.headersSent) return;
          throw error;
        }
      }
      res.json({ updated: true });
    } catch (error) {
      req.log.error({ errorName: error instanceof Error ? error.name : "unknown" }, "Calendar event update failed");
      res.status(502).json({ error: "Could not update the calendar event." });
    }
  });

  app.delete("/api/staff-calendar/events/:eventId", async (req, res): Promise<void> => {
    if (!(await requireCalendarManager(req, res))) return;
    try {
      const settings = await getTwilioSettings();
      if (!settings.schedulingCalendarId) { res.status(409).json({ error: "No shared booking calendar is attached." }); return; }
      const eventId = String(req.params.eventId);
      const appointment = await pool.query(
        "SELECT id, status FROM appointments WHERE google_event_id = $1 AND google_calendar_id = $2",
        [eventId, settings.schedulingCalendarId],
      );
      if (appointment.rows[0] && !["pending", "confirmed", "in_progress"].includes(String(appointment.rows[0].status))) {
        res.status(409).json({ error: "Only active customer appointments can be cancelled here." });
        return;
      }
      await googleCalendarService.deleteEvent(settings.schedulingCalendarId, eventId);
      if (appointment.rows[0]) {
        await pool.query(
          `UPDATE appointments SET status='cancelled', cancelled_at=NOW(),
           cancellation_reason='Cancelled from the staff calendar', updated_at=NOW()
           WHERE id=$1 AND status IN ('pending','confirmed','in_progress')`,
          [appointment.rows[0].id],
        );
        await pool.query(
          "UPDATE appointment_resources SET status='cancelled' WHERE appointment_id=$1",
          [appointment.rows[0].id],
        );
      }
      res.json({ deleted: true, appointmentCancelled: Boolean(appointment.rows[0]) });
    } catch (error) {
      req.log.error({ errorName: error instanceof Error ? error.name : "unknown" }, "Calendar event deletion failed");
      res.status(502).json({ error: "Could not delete the calendar event." });
    }
  });
}
