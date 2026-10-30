import { fromZonedTime, toZonedTime, format } from "date-fns-tz";
import { addMinutes, addDays, startOfDay } from "date-fns";
import { storage } from "../storage";
import type { Service, BookingResource } from "@shared/schema";
import { getTwilioSettings } from "../twilio-settings-storage";
import { googleCalendarService } from "../google-calendar";

// One bookable slot returned to the UI.
// `startsAt` / `endsAt` are absolute UTC instants (ISO strings).
// `resourceIds` is the chosen set that will satisfy the service requirements
// if the customer picks this slot — captured at booking time on the lock.
export interface AvailableSlot {
  startsAt: string;
  endsAt: string;
  resourceIds: number[];
}

export interface SlotComputeOptions {
  serviceId: number;
  // Calendar date in the customer's tz, 'YYYY-MM-DD'
  date: string;
  // IANA timezone the date string is interpreted in
  timezone: string;
  // Optional: minutes between candidate slot starts. Defaults to service duration.
  intervalMinutes?: number;
}

// Resolve the resource pool that satisfies each requirement of a service.
// Phase-1 supports services with one or more requirements, each of quantity 1,
// either pinning a specific resource or matching one tag.
async function resolveResourceCandidates(serviceId: number): Promise<number[][]> {
  const reqs = await storage.getServiceRequirements(serviceId);
  if (reqs.length === 0) {
    throw new Error(`Service ${serviceId} has no resource requirements configured`);
  }

  const groups: number[][] = [];
  for (const req of reqs) {
    if (req.resourceId) {
      // Pinned resource — single-element pool
      const r = await storage.getBookingResource(req.resourceId);
      if (!r || !r.isActive) continue;
      groups.push([req.resourceId]);
      continue;
    }
    if (req.tagId) {
      const ids = await storage.getResourceIdsByTag(req.tagId);
      // Filter to active resources only
      const active: number[] = [];
      for (const id of ids) {
        const r = await storage.getBookingResource(id);
        if (r?.isActive) active.push(id);
      }
      if (active.length === 0) continue;
      groups.push(active);
      continue;
    }
  }

  if (groups.length === 0) {
    throw new Error(`Service ${serviceId} has no satisfiable resource requirements`);
  }
  return groups;
}

// Pick the first non-conflicting resource from each requirement group.
// Returns null if any group is fully blocked at the given time.
async function pickResourcesForSlot(
  groups: number[][],
  startsAt: Date,
  endsAt: Date,
): Promise<number[] | null> {
  const chosen: number[] = [];
  for (const group of groups) {
    let picked: number | null = null;
    for (const candidate of group) {
      // Skip if already chosen for another requirement
      if (chosen.includes(candidate)) continue;

      const apptConflicts = await storage.getActiveAppointmentResourceConflicts([candidate], startsAt, endsAt);
      if (apptConflicts.length > 0) continue;

      const lockConflicts = await storage.getActiveLockResourceConflicts([candidate], startsAt, endsAt);
      if (lockConflicts.length > 0) continue;

      picked = candidate;
      break;
    }
    if (picked === null) return null;
    chosen.push(picked);
  }
  return chosen;
}

// Convert a 'HH:MM' time on a given date in a given tz into a UTC Date.
function localTimeToUtc(date: string, timeHHMM: string, timezone: string): Date {
  // 'YYYY-MM-DD HH:MM:SS' in the target zone → absolute UTC
  return fromZonedTime(`${date} ${timeHHMM}:00`, timezone);
}

// Generate candidate slot start times for a date, walking the resource's
// working window for that day-of-week.
async function generateCandidateStarts(
  date: string,
  timezone: string,
  resourceIds: number[],
  intervalMinutes: number,
): Promise<{ windows: { start: Date; end: Date }[]; intervalMinutes: number }> {
  // Determine which day-of-week 'date' lands on, in the target timezone
  const noonUtcAnchor = fromZonedTime(`${date} 12:00:00`, timezone);
  const localNoon = toZonedTime(noonUtcAnchor, timezone);
  const dow = localNoon.getDay();

  // Union of all working windows across the resource pool for that day
  const windows: { start: Date; end: Date }[] = [];
  for (const rid of resourceIds) {
    const hours = await storage.getBusinessHoursForResource(rid);
    const todayHours = hours.filter(h => h.dayOfWeek === dow && !h.isClosed);
    for (const h of todayHours) {
      windows.push({
        start: localTimeToUtc(date, h.startTime, timezone),
        end: localTimeToUtc(date, h.endTime, timezone),
      });
    }
  }
  if (windows.length === 0) return { windows: [], intervalMinutes };

  // Merge overlapping windows so we don't generate duplicate start times
  windows.sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: { start: Date; end: Date }[] = [windows[0]];
  for (let i = 1; i < windows.length; i++) {
    const last = merged[merged.length - 1];
    const w = windows[i];
    if (w.start.getTime() <= last.end.getTime()) {
      if (w.end.getTime() > last.end.getTime()) last.end = w.end;
    } else {
      merged.push(w);
    }
  }

  return { windows: merged, intervalMinutes };
}

// Walk the working windows and emit only candidate starts whose slot end
// (start + duration) still fits inside the same window.
function generateStartsForDuration(
  windows: { start: Date; end: Date }[],
  intervalMinutes: number,
  durationMinutes: number,
): Date[] {
  const starts: Date[] = [];
  for (const w of windows) {
    let cursor = w.start;
    while (addMinutes(cursor, durationMinutes).getTime() <= w.end.getTime()) {
      starts.push(cursor);
      cursor = addMinutes(cursor, intervalMinutes);
    }
  }
  return starts;
}

// Main entry point. Returns the list of bookable slots for the customer.
export async function computeAvailableSlots(opts: SlotComputeOptions): Promise<AvailableSlot[]> {
  const service = await storage.getService(opts.serviceId);
  if (!service || !service.isActive || !service.isPubliclyBookable) {
    return [];
  }

  // Lead-time guard: never offer a slot starting before now() + minLeadTime
  const earliestStart = addMinutes(new Date(), service.minLeadTimeMinutes);

  // Advance-window guard
  const latestStart = addDays(new Date(), service.maxAdvanceDays);

  // Holiday check (covers business-wide closure when resourceId IS NULL)
  const businessHolidays = await storage.getHolidaysInRange(opts.date, opts.date);
  if (businessHolidays.some(h => h.resourceId === null)) {
    return [];
  }

  // Resolve which resources can satisfy each requirement
  const groups = await resolveResourceCandidates(opts.serviceId);
  const allResourceIds = Array.from(new Set(groups.flat()));

  // Compute the search window for time-off filtering
  const dayStartUtc = fromZonedTime(`${opts.date} 00:00:00`, opts.timezone);
  const dayEndUtc = addDays(dayStartUtc, 1);

  // Cache time-off per resource to avoid repeated queries
  const timeOffByResource = new Map<number, { start: Date; end: Date }[]>();
  for (const rid of allResourceIds) {
    const blocks = await storage.getResourceTimeOffInRange(rid, dayStartUtc, dayEndUtc);
    timeOffByResource.set(rid, blocks.map(b => ({ start: b.startsAt, end: b.endsAt })));
  }

  // Per-resource holidays
  const resourceHolidayIds = new Set(
    businessHolidays.filter(h => h.resourceId !== null).map(h => h.resourceId as number),
  );

  const intervalMinutes = opts.intervalMinutes ?? service.durationMinutes;
  const { windows } = await generateCandidateStarts(opts.date, opts.timezone, allResourceIds, intervalMinutes);
  const candidateStarts = generateStartsForDuration(windows, intervalMinutes, service.durationMinutes);

  // Total occupied window includes service buffers
  const before = service.bufferBeforeMinutes;
  const after = service.bufferAfterMinutes;

  // If a Google Calendar is attached and "block busy" is on, fetch the day's
  // busy ranges once and use them to filter candidate slots below.
  let calendarBusy: { start: Date; end: Date }[] = [];
  try {
    const settings = await getTwilioSettings();
    if (settings.schedulingCalendarBlockBusy && settings.schedulingCalendarId) {
      const busy = await googleCalendarService.getBusy(
        settings.schedulingCalendarId,
        dayStartUtc.toISOString(),
        dayEndUtc.toISOString(),
      );
      calendarBusy = busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
    }
  } catch (e: any) {
    // Calendar errors must not break availability — degrade gracefully.
    console.warn("[availability] Google Calendar freebusy lookup failed:", e?.message || e);
  }

  const slots: AvailableSlot[] = [];
  for (const startsAt of candidateStarts) {
    if (startsAt.getTime() < earliestStart.getTime()) continue;
    if (startsAt.getTime() > latestStart.getTime()) continue;

    const endsAt = addMinutes(startsAt, service.durationMinutes);
    const blockStart = addMinutes(startsAt, -before);
    const blockEnd = addMinutes(endsAt, after);

    // Filter resource pools to those not on time-off / holiday for this slot
    const filteredGroups: number[][] = groups.map(group =>
      group.filter(rid => {
        if (resourceHolidayIds.has(rid)) return false;
        const blocks = timeOffByResource.get(rid) ?? [];
        return !blocks.some(b =>
          b.start.getTime() < blockEnd.getTime() && b.end.getTime() > blockStart.getTime()
        );
      })
    );
    if (filteredGroups.some(g => g.length === 0)) continue;

    // Skip slots that overlap a busy event on the attached Google Calendar
    if (calendarBusy.some((b) => b.start.getTime() < blockEnd.getTime() && b.end.getTime() > blockStart.getTime())) {
      continue;
    }

    // Try to pick a non-conflicting resource for each requirement
    const chosen = await pickResourcesForSlot(filteredGroups, blockStart, blockEnd);
    if (!chosen) continue;

    slots.push({
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      resourceIds: chosen,
    });
  }

  return slots;
}

// Helper exported for tests / debugging
export { resolveResourceCandidates };
