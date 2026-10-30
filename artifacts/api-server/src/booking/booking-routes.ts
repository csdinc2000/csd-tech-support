import type { Express, Request, Response } from "express";
import { randomBytes } from "crypto";
import { addMinutes } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { z } from "zod/v4";
import { and, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db";
import {
  bookingSlotLocks,
  bookingSlotLockResources,
  appointments,
  appointmentResources,
  services,
  APPOINTMENT_ACTIVE_STATUSES,
} from "@workspace/db";
import { storage } from "../storage";
import { isAdminUser, rateLimit } from "../security";
import { getStaffAssignmentScope } from "../staff-access";
import { computeAvailableSlots } from "./availability-service";
import { getTwilioSettings } from "../twilio-settings-storage";
import { googleCalendarService } from "../google-calendar";
import { routeParam } from "../lib/route-params";
import { enqueueStaffEventNotification } from "../staff-dispatch";

// 5-minute soft lock TTL
const LOCK_TTL_MINUTES = 5;
// Default tz for derivation when client doesn't supply one. Phase-1 single tz.
const DEFAULT_TZ = "America/New_York";

// Public booking writes (slot locks + appointment confirmation) are
// rate-limited per IP to blunt abuse of the unauthenticated booking flow.
const bookingWriteLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: "Too many booking requests. Please wait a minute and try again.",
});

const availabilityQuerySchema = z.object({
  serviceId: z.coerce.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  timezone: z.string().min(1).default(DEFAULT_TZ),
});

// NOTE: client-supplied `resourceIds` are intentionally NOT trusted.
// The server recomputes available slots and matches by `startsAt`.
const createLockSchema = z.object({
  serviceId: z.number().int().positive(),
  startsAt: z.string().datetime(),
  timezone: z.string().min(1).default(DEFAULT_TZ),
  sessionId: z.string().optional(),
});

const confirmAppointmentSchema = z.object({
  lockToken: z.string().min(1),
  customerName: z.string().min(2),
  customerEmail: z.string().email(),
  customerPhone: z.string().optional(),
  customerTimezone: z.string().default(DEFAULT_TZ),
  customerNotes: z.string().optional(),
  contactId: z.number().int().positive().optional(),
  source: z.enum(["web", "embed", "phone", "walk_in", "admin"]).default("web"),
});

const listAppointmentsQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: z.enum(["pending", "confirmed", "in_progress", "completed", "cancelled", "no_show"]).optional(),
});

export function registerBookingRoutes(app: Express) {
  // -------- Public catalog --------

  app.get("/api/booking/categories", async (_req: Request, res: Response) => {
    try {
      const categories = await storage.getServiceCategories({ activeOnly: true });
      res.json(categories);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/booking/services", async (_req: Request, res: Response) => {
    try {
      const services = await storage.getServices({ publicOnly: true });
      res.json(services);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/booking/services/:slug", async (req: Request, res: Response) => {
    try {
      const service = await storage.getServiceBySlug(routeParam(req.params.slug, "slug"));
      if (!service) return res.status(404).json({ error: "Service not found" });
      res.json(service);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------- Availability --------

  app.get("/api/booking/availability", async (req: Request, res: Response) => {
    try {
      const parsed = availabilityQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }
      const slots = await computeAvailableSlots(parsed.data);
      res.json({ slots });
    } catch (err: any) {
      console.error("Availability error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // -------- Slot locking --------
  // The server is authoritative: it recomputes the slot set for the given date
  // and matches the requested startsAt. The endsAt and resourceIds come from
  // that recomputation — clients cannot influence what gets reserved.
  app.post("/api/booking/locks", bookingWriteLimiter, async (req: Request, res: Response) => {
    try {
      const parsed = createLockSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }
      const { serviceId, sessionId, timezone } = parsed.data;
      const requestedStart = new Date(parsed.data.startsAt);
      if (isNaN(requestedStart.getTime())) {
        return res.status(400).json({ error: "Invalid startsAt" });
      }
      if (requestedStart.getTime() <= Date.now()) {
        return res.status(400).json({ error: "Slot start is in the past" });
      }

      const service = await storage.getService(serviceId);
      if (!service) return res.status(404).json({ error: "Service not found" });
      if (!service.isActive || !service.isPubliclyBookable) {
        return res.status(400).json({ error: "Service is not bookable" });
      }

      // Recompute slots for the date (in client's tz) containing the requested start
      const date = formatInTimeZone(requestedStart, timezone, "yyyy-MM-dd");
      const slots = await computeAvailableSlots({ serviceId, date, timezone });
      const match = slots.find(s => new Date(s.startsAt).getTime() === requestedStart.getTime());
      if (!match) {
        return res.status(409).json({ error: "Slot is no longer available" });
      }

      const startsAt = new Date(match.startsAt);
      const endsAt = new Date(match.endsAt);
      const resourceIds = match.resourceIds;

      const lockToken = randomBytes(24).toString("base64url");
      const expiresAt = addMinutes(new Date(), LOCK_TTL_MINUTES);

      const lock = await storage.createBookingSlotLock(
        { lockToken, serviceId, startsAt, endsAt, sessionId, expiresAt },
        resourceIds,
      );

      res.status(201).json({
        lockToken: lock.lockToken,
        startsAt: lock.startsAt,
        endsAt: lock.endsAt,
        expiresAt: lock.expiresAt,
        ttlSeconds: LOCK_TTL_MINUTES * 60,
      });
    } catch (err: any) {
      console.error("Lock create error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/booking/locks/:token", async (req: Request, res: Response) => {
    try {
      const lock = await storage.getBookingSlotLockByToken(routeParam(req.params.token, "token"));
      if (!lock) return res.status(404).json({ error: "Lock not found" });
      await storage.deleteBookingSlotLock(lock.id);
      res.status(204).end();
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------- Confirm (lock → appointment) --------
  // All-or-nothing: lock SELECT FOR UPDATE → conflict re-check → appointment
  // INSERT → appointment_resources INSERT → lock DELETE, in one transaction.
  app.post("/api/booking/appointments", bookingWriteLimiter, async (req: Request, res: Response) => {
    try {
      const parsed = confirmAppointmentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }
      const data = parsed.data;
      // This endpoint is deliberately public. A caller must never be able to
      // attach an appointment to an arbitrary CRM person just by submitting an
      // ID. Logged-in staff may make that explicit association instead.
      const authenticated =
        typeof (req as any).isAuthenticated === "function" && (req as any).isAuthenticated();
      const staffContactId = authenticated && isAdminUser(req) ? data.contactId : undefined;
      if (staffContactId != null && !(await storage.getCrmContact(staffContactId))) {
        return res.status(400).json({ error: "CRM contact not found" });
      }

      const result = await db.transaction(async (tx) => {
        // Row-level lock the slot lock so concurrent confirms serialize
        const lockRows = await tx.execute<any>(sql`
          SELECT * FROM booking_slot_locks
          WHERE lock_token = ${data.lockToken}
          FOR UPDATE
        `);
        const lockRow = (lockRows.rows ?? lockRows)[0];
        if (!lockRow) {
          return { status: 404, body: { error: "Lock not found or already consumed" } };
        }

        const lockExpiresAt = new Date(lockRow.expires_at);
        const lockStartsAt = new Date(lockRow.starts_at);
        const lockEndsAt = new Date(lockRow.ends_at);

        if (lockExpiresAt.getTime() < Date.now()) {
          await tx.delete(bookingSlotLocks).where(eq(bookingSlotLocks.id, lockRow.id));
          return { status: 410, body: { error: "Lock expired. Please select a new time." } };
        }

        // Resources attached to this lock
        const lockResources = await tx.select().from(bookingSlotLockResources)
          .where(eq(bookingSlotLockResources.lockId, lockRow.id));
        if (lockResources.length === 0) {
          return { status: 500, body: { error: "Lock has no resources attached" } };
        }
        const resourceIds = lockResources.map(r => r.resourceId);

        // Final conflict check against active appointments
        const apptConflicts = await tx.select().from(appointmentResources).where(and(
          inArray(appointmentResources.resourceId, resourceIds),
          inArray(appointmentResources.status, APPOINTMENT_ACTIVE_STATUSES as unknown as string[]),
          lt(appointmentResources.startsAt, lockEndsAt),
          gt(appointmentResources.endsAt, lockStartsAt),
        ));
        if (apptConflicts.length > 0) {
          await tx.delete(bookingSlotLocks).where(eq(bookingSlotLocks.id, lockRow.id));
          return { status: 409, body: { error: "Slot was just taken. Please pick another." } };
        }

        // Service for pricing/deposit
        const service = await storage.getService(lockRow.service_id);
        if (!service) {
          return { status: 500, body: { error: "Service for lock missing" } };
        }

        let depositRequiredCents = 0;
        switch (service.depositType) {
          case "full": depositRequiredCents = service.basePriceCents; break;
          case "flat": depositRequiredCents = service.depositAmountCents; break;
          case "percent": depositRequiredCents = Math.round(service.basePriceCents * service.depositPercent / 100); break;
          case "none": default: depositRequiredCents = 0;
        }

        // Generate human-friendly reference inside the same tx
        const year = new Date().getUTCFullYear();
        const refRows = await tx.execute<any>(sql`
          SELECT COUNT(*)::text AS count FROM appointments
          WHERE EXTRACT(YEAR FROM created_at AT TIME ZONE 'UTC') = ${year}
        `);
        const seq = (parseInt(((refRows.rows ?? refRows)[0]?.count ?? "0"), 10) + 1)
          .toString().padStart(6, "0");
        const reference = `CSD-A-${year}-${seq}`;

        const [appt] = await tx.insert(appointments).values({
          serviceId: service.id,
          contactId: staffContactId,
          customerName: data.customerName,
          customerEmail: data.customerEmail,
          customerPhone: data.customerPhone,
          startsAt: lockStartsAt,
          endsAt: lockEndsAt,
          customerTimezone: data.customerTimezone,
          status: "pending",
          totalCents: service.basePriceCents,
          depositRequiredCents,
          amountPaidCents: 0,
          customerNotes: data.customerNotes,
          source: data.source,
          reference,
        } as any).returning();

        await tx.insert(appointmentResources).values(
          resourceIds.map(rid => ({
            appointmentId: appt.id,
            resourceId: rid,
            startsAt: lockStartsAt,
            endsAt: lockEndsAt,
            status: appt.status,
          }))
        );

        // Consume the lock
        await tx.delete(bookingSlotLocks).where(eq(bookingSlotLocks.id, lockRow.id));
        await enqueueStaffEventNotification({ kind: "appointment", id: appt.id }, tx);

        return {
          status: 201,
          body: {
            appointment: {
              id: appt.id,
              reference: appt.reference,
              startsAt: appt.startsAt,
              endsAt: appt.endsAt,
              status: appt.status,
              totalCents: appt.totalCents,
              depositRequiredCents: appt.depositRequiredCents,
            },
          },
        };
      });

      // Best-effort: push the confirmed appointment to the attached Google
      // Calendar. Failure here must NOT roll back the booking.
      if (result.status === 201 && (result.body as any)?.appointment) {
        const appt: any = (result.body as any).appointment;
        try {
          const settings = await getTwilioSettings();
          if (settings.schedulingCalendarPushEvents && settings.schedulingCalendarId) {
            const data = (parsed.success ? parsed.data : null) as any;
            const service = await storage.getService(appt.serviceId ?? data?.serviceId);
            const eventId = await googleCalendarService.createEvent(settings.schedulingCalendarId, {
              summary: `${service?.name || "Appointment"} — ${data?.customerName ?? ""}`.trim(),
              description:
                `Reference: ${appt.reference}\n` +
                `Customer: ${data?.customerName ?? ""}\n` +
                (data?.customerPhone ? `Phone: ${data.customerPhone}\n` : "") +
                (data?.customerEmail ? `Email: ${data.customerEmail}\n` : "") +
                (data?.customerNotes ? `\nNotes:\n${data.customerNotes}` : ""),
              startIso: new Date(appt.startsAt).toISOString(),
              endIso: new Date(appt.endsAt).toISOString(),
              timezone: data?.customerTimezone || "America/New_York",
              attendees: data?.customerEmail ? [{ email: data.customerEmail, displayName: data?.customerName }] : undefined,
              reference: appt.reference,
            });
            if (eventId) {
              await db.update(appointments)
                .set({ googleEventId: eventId, googleCalendarId: settings.schedulingCalendarId })
                .where(eq(appointments.id, appt.id));
            }
          }
        } catch (calErr: any) {
          console.error("Google Calendar push failed (booking still confirmed):", calErr?.message || calErr);
        }
      }

      res.status(result.status).json(result.body);
    } catch (err: any) {
      console.error("Appointment confirm error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // -------- Lookup (for confirmation page / staff) --------

  // -------- Staff schedule --------
  // Not on the public allowlist in index.ts, so this requires a session. Staff
  // with assignment-restricted scope only see appointments for their contacts;
  // guest bookings (no contactId) stay owner/admin-only.
  app.get("/api/booking/appointments", async (req: Request, res: Response) => {
    try {
      const parsed = listAppointmentsQuerySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: "from/to must be ISO timestamps" });
      const { from, to, status } = parsed.data;
      if (from && to && to <= from) return res.status(400).json({ error: "to must be after from" });
      const scope = await getStaffAssignmentScope(req);
      const conditions = [] as any[];
      if (from) conditions.push(gte(appointments.startsAt, from));
      if (to) conditions.push(lt(appointments.startsAt, to));
      if (status) conditions.push(eq(appointments.status, status));
      const rows = await db
        .select({ appointment: appointments, serviceName: services.name, serviceDurationMinutes: services.durationMinutes })
        .from(appointments)
        .leftJoin(services, eq(services.id, appointments.serviceId))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(appointments.startsAt);
      const visible = scope.unrestricted
        ? rows
        : rows.filter((row) => row.appointment.contactId != null && scope.contactIds.has(row.appointment.contactId));
      res.json(visible.map((row) => ({
        ...row.appointment,
        serviceName: row.serviceName ?? null,
        serviceDurationMinutes: row.serviceDurationMinutes ?? null,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/booking/appointments/:reference", async (req: Request, res: Response) => {
    try {
      const a = await storage.getAppointmentByReference(routeParam(req.params.reference, "reference"));
      if (!a) return res.status(404).json({ error: "Appointment not found" });
      // `appointments.contactId` is a person, not an account. Preserve it and
      // include the resolved account only when the person is linked.
      const contact = a.contactId == null ? undefined : await storage.getCrmContact(a.contactId);
      res.json({ ...a, clientId: contact?.clientId ?? null });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}

// Background sweeper — runs on an interval to delete expired locks.
export function startSlotLockSweeper(intervalMs = 60_000) {
  setInterval(async () => {
    try {
      const n = await storage.sweepExpiredSlotLocks();
      if (n > 0) console.log(`[booking] swept ${n} expired slot lock(s)`);
    } catch (err) {
      console.error("[booking] sweeper error:", err);
    }
  }, intervalMs);
}
