/**
 * Booking Engine v2 — pure availability computation.
 *
 * computeSlots() is a PURE function: all inputs (schedules, overrides, busy
 * ranges, `now`) are passed in and no I/O happens inside, so it is fully
 * unit-testable (see server/__tests__/booking-availability.test.ts). Callers
 * (server/booking/v2-routes.ts) load the rows and inject them.
 *
 * Conventions:
 *   - All intervals are half-open [start, end) on UTC instants.
 *   - Weekly schedules and overrides are in staff-LOCAL wall time; conversion
 *     to UTC uses the staff's IANA timezone via date-fns-tz, which makes DST
 *     handling correct by construction: a 00:00–06:00 shift is 5 real hours on
 *     the spring-forward day and 7 on the fall-back day.
 *   - An override row for a date REPLACES that day's weekly windows entirely;
 *     NULL start+end means the whole day is off.
 *   - A shift whose end time is <= its start time spans midnight into the
 *     next local day.
 *   - `busy` ranges (existing appointments' padded timeslots + external busy
 *     blocks) are compared against the candidate's PADDED interval, so
 *     padding causes back-to-back rejection.
 *   - Candidate visible starts are stepped from (window start + paddingBefore)
 *     by `slotStepMin` (default = service duration), and the padded interval
 *     must fit entirely inside the working window.
 *   - clientTimezone is used ONLY to label each slot with the client-local
 *     day (`clientDay`) for grouping in API responses.
 */
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

export interface WeeklyWindow {
  weekday: number; // 0 = Sunday … 6 = Saturday (staff-local)
  startLocal: string; // "HH:MM" or "HH:MM:SS"
  endLocal: string;
}

export interface DayOverride {
  dateLocal: string; // "YYYY-MM-DD" (staff-local)
  startLocal: string | null; // both null => day off
  endLocal: string | null;
}

export interface BusyInterval {
  start: Date; // UTC instant, inclusive
  end: Date; // UTC instant, exclusive
}

export interface ComputeSlotsInput {
  staffTimezone: string; // IANA, e.g. "America/New_York"
  weekly: WeeklyWindow[];
  overrides?: DayOverride[];
  busy?: BusyInterval[];
  durationMin: number; // visible service duration
  paddingBeforeMin?: number; // default 0
  paddingAfterMin?: number; // default 0
  slotStepMin?: number; // default = durationMin
  minLeadTimeMin?: number; // default 0 — earliest bookable = now + lead
  maxHorizonDays?: number; // default 60 — latest bookable = now + horizon
  from: Date; // requested range start (UTC)
  to: Date; // requested range end (UTC, exclusive)
  now: Date; // injected clock
  clientTimezone: string; // IANA — grouping only
}

export interface SlotUTC {
  start: string; // ISO visible start (what the client sees)
  end: string; // ISO visible end
  paddedStart: string; // ISO — what will be written to the timeslot range
  paddedEnd: string;
  clientDay: string; // "YYYY-MM-DD" in the client's timezone
}

const MS_PER_MIN = 60_000;
const MS_PER_DAY = 86_400_000;

function normalizeTime(t: string): string {
  // "9:00" | "09:00" | "09:00:00" -> "HH:MM:SS"
  const [h = "0", m = "0", s = "0"] = t.split(":");
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}:${s.padStart(2, "0")}`;
}

/** Staff-local wall time on a local calendar date -> UTC instant. */
function localToUtc(dateLocal: string, timeLocal: string, tz: string): Date {
  return fromZonedTime(`${dateLocal}T${normalizeTime(timeLocal)}`, tz);
}

/** Day-of-week (0=Sun) of a Y-M-D calendar date, independent of any timezone. */
function weekdayOf(dateLocal: string): number {
  const [y, m, d] = dateLocal.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Next Y-M-D calendar date (pure calendar math — no tz involved). */
function nextDate(dateLocal: string): string {
  const [y, m, d] = dateLocal.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d) + MS_PER_DAY);
  return next.toISOString().slice(0, 10);
}

interface Interval {
  start: number; // epoch ms
  end: number;
}

export function computeSlots(input: ComputeSlotsInput): SlotUTC[] {
  const {
    staffTimezone,
    weekly,
    overrides = [],
    busy = [],
    durationMin,
    paddingBeforeMin = 0,
    paddingAfterMin = 0,
    minLeadTimeMin = 0,
    maxHorizonDays = 60,
    from,
    to,
    now,
    clientTimezone,
  } = input;
  const slotStepMin = input.slotStepMin ?? durationMin;

  if (durationMin <= 0 || slotStepMin <= 0) return [];
  if (to.getTime() <= from.getTime()) return [];

  const overrideByDate = new Map(overrides.map((o) => [o.dateLocal, o]));
  const busyIvs: Interval[] = busy.map((b) => ({
    start: b.start.getTime(),
    end: b.end.getTime(),
  }));

  const durationMs = durationMin * MS_PER_MIN;
  const padBeforeMs = paddingBeforeMin * MS_PER_MIN;
  const padAfterMs = paddingAfterMin * MS_PER_MIN;
  const stepMs = slotStepMin * MS_PER_MIN;

  // Bookability window: [now + lead, now + horizon] intersected with [from, to)
  const earliestStart = Math.max(
    from.getTime(),
    now.getTime() + minLeadTimeMin * MS_PER_MIN,
  );
  const latestStart = Math.min(
    to.getTime() - 1,
    now.getTime() + maxHorizonDays * MS_PER_DAY,
  );
  if (latestStart < earliestStart) return [];

  // Enumerate staff-local calendar dates that could contribute windows.
  // Start one day early so a midnight-spanning shift from the previous local
  // day is not missed; end on the local date of `to`.
  let dateLocal = formatInTimeZone(
    new Date(from.getTime() - MS_PER_DAY),
    staffTimezone,
    "yyyy-MM-dd",
  );
  const lastDate = formatInTimeZone(to, staffTimezone, "yyyy-MM-dd");

  const windows: Interval[] = [];
  // Hard bound on iterations (range is validated by callers; this is a guard).
  for (let i = 0; i < 400 && dateLocal <= lastDate; i++, dateLocal = nextDate(dateLocal)) {
    const override = overrideByDate.get(dateLocal);
    let dayWindows: { startLocal: string; endLocal: string }[];
    if (override) {
      dayWindows =
        override.startLocal && override.endLocal
          ? [{ startLocal: override.startLocal, endLocal: override.endLocal }]
          : []; // day off
    } else {
      const wd = weekdayOf(dateLocal);
      dayWindows = weekly.filter((w) => w.weekday === wd);
    }

    for (const w of dayWindows) {
      const startUtc = localToUtc(dateLocal, w.startLocal, staffTimezone);
      let endUtc = localToUtc(dateLocal, w.endLocal, staffTimezone);
      if (endUtc.getTime() <= startUtc.getTime()) {
        // Shift spans midnight into the next local day.
        endUtc = localToUtc(nextDate(dateLocal), w.endLocal, staffTimezone);
      }
      if (endUtc.getTime() > startUtc.getTime()) {
        windows.push({ start: startUtc.getTime(), end: endUtc.getTime() });
      }
    }
  }

  windows.sort((a, b) => a.start - b.start);

  const slots: SlotUTC[] = [];
  const seen = new Set<number>();

  for (const win of windows) {
    // First candidate visible start leaves room for the before-padding.
    for (
      let visibleStart = win.start + padBeforeMs;
      visibleStart + durationMs + padAfterMs <= win.end;
      visibleStart += stepMs
    ) {
      if (visibleStart < earliestStart) continue;
      if (visibleStart > latestStart) break;
      if (seen.has(visibleStart)) continue;

      const paddedStart = visibleStart - padBeforeMs;
      const paddedEnd = visibleStart + durationMs + padAfterMs;
      const clashes = busyIvs.some(
        (b) => paddedStart < b.end && b.start < paddedEnd,
      );
      if (clashes) continue;

      seen.add(visibleStart);
      slots.push({
        start: new Date(visibleStart).toISOString(),
        end: new Date(visibleStart + durationMs).toISOString(),
        paddedStart: new Date(paddedStart).toISOString(),
        paddedEnd: new Date(paddedEnd).toISOString(),
        clientDay: formatInTimeZone(
          new Date(visibleStart),
          clientTimezone,
          "yyyy-MM-dd",
        ),
      });
    }
  }

  slots.sort((a, b) => a.start.localeCompare(b.start));
  return slots;
}
