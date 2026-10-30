/**
 * Unit tests for the Booking Engine v2 availability computation
 * (server/booking/availability.ts). Pure-function tests — no DB, no server.
 *
 * Run: npm test   (tsx --test server/__tests__/*.test.ts)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSlots, type ComputeSlotsInput } from "../booking/availability";

const NY = "America/New_York";

function base(partial: Partial<ComputeSlotsInput>): ComputeSlotsInput {
  return {
    staffTimezone: NY,
    weekly: [],
    overrides: [],
    busy: [],
    durationMin: 60,
    paddingBeforeMin: 0,
    paddingAfterMin: 0,
    minLeadTimeMin: 0,
    maxHorizonDays: 365,
    from: new Date("2026-06-01T00:00:00Z"),
    to: new Date("2026-06-02T00:00:00Z"),
    now: new Date("2026-01-01T00:00:00Z"),
    clientTimezone: NY,
    ...partial,
  };
}

function starts(slots: { start: string }[]): string[] {
  return slots.map((s) => s.start);
}

// ---------------------------------------------------------------------------
// DST — spring forward (America/New_York, 2026-03-08: 02:00 EST -> 03:00 EDT)
// ---------------------------------------------------------------------------
test("DST spring-forward: 00:00-06:00 shift yields only 5 real hours and no 2am slot", () => {
  const slots = computeSlots(
    base({
      weekly: [{ weekday: 0, startLocal: "00:00", endLocal: "06:00" }], // Sunday
      from: new Date("2026-03-08T00:00:00-05:00"),
      to: new Date("2026-03-08T12:00:00-04:00"),
    }),
  );
  // 00:00 EST = 05:00Z; 06:00 EDT = 10:00Z — a 5-hour window.
  assert.deepEqual(starts(slots), [
    "2026-03-08T05:00:00.000Z", // 00:00 EST
    "2026-03-08T06:00:00.000Z", // 01:00 EST
    "2026-03-08T07:00:00.000Z", // 03:00 EDT — 02:00 local does not exist
    "2026-03-08T08:00:00.000Z", // 04:00 EDT
    "2026-03-08T09:00:00.000Z", // 05:00 EDT
  ]);
});

// ---------------------------------------------------------------------------
// DST — fall back (America/New_York, 2026-11-01: 02:00 EDT -> 01:00 EST)
// ---------------------------------------------------------------------------
test("DST fall-back: 00:00-06:00 shift yields 7 real hours", () => {
  const slots = computeSlots(
    base({
      weekly: [{ weekday: 0, startLocal: "00:00", endLocal: "06:00" }], // Sunday
      from: new Date("2026-11-01T00:00:00-04:00"),
      to: new Date("2026-11-01T23:59:00-05:00"),
    }),
  );
  // 00:00 EDT = 04:00Z; 06:00 EST = 11:00Z — a 7-hour window.
  assert.equal(slots.length, 7);
  assert.equal(slots[0].start, "2026-11-01T04:00:00.000Z");
  assert.equal(slots[6].start, "2026-11-01T10:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Shift spanning midnight
// ---------------------------------------------------------------------------
test("shift spanning midnight (22:00-02:00) produces slots across the boundary", () => {
  const slots = computeSlots(
    base({
      // Monday 2026-06-01 22:00 -> Tuesday 02:00 local
      weekly: [{ weekday: 1, startLocal: "22:00", endLocal: "02:00" }],
      from: new Date("2026-06-01T00:00:00-04:00"),
      to: new Date("2026-06-02T12:00:00-04:00"),
    }),
  );
  assert.deepEqual(starts(slots), [
    "2026-06-02T02:00:00.000Z", // Mon 22:00 EDT
    "2026-06-02T03:00:00.000Z", // Mon 23:00 EDT
    "2026-06-02T04:00:00.000Z", // Tue 00:00 EDT
    "2026-06-02T05:00:00.000Z", // Tue 01:00 EDT
  ]);
  // Slots after midnight belong to the next client-local day.
  assert.equal(slots[1].clientDay, "2026-06-01");
  assert.equal(slots[2].clientDay, "2026-06-02");
});

// ---------------------------------------------------------------------------
// Padding causes back-to-back rejection
// ---------------------------------------------------------------------------
test("padding rejects a slot back-to-back with an existing appointment", () => {
  const common = {
    weekly: [{ weekday: 1, startLocal: "09:00", endLocal: "13:00" }], // Mon 2026-06-01
    from: new Date("2026-06-01T09:00:00-04:00"),
    to: new Date("2026-06-01T17:00:00-04:00"),
    // Existing appointment's padded timeslot: 10:00-11:15 local (14:00-15:15Z)
    busy: [
      {
        start: new Date("2026-06-01T14:00:00Z"),
        end: new Date("2026-06-01T15:15:00Z"),
      },
    ],
  };

  // Without padding: hourly candidates at 09,10,11,12 minus the busy clash.
  const noPad = computeSlots(base({ ...common }));
  assert.deepEqual(starts(noPad), [
    "2026-06-01T13:00:00.000Z", // 09:00 — ends 10:00, touches busy start: OK (half-open)
    "2026-06-01T16:00:00.000Z", // 12:00 — first hourly candidate after busy end 11:15
  ]);

  // With 15-min after-padding the 09:00 slot's padded end (10:15) now overlaps
  // the existing appointment starting at 10:00 → rejected.
  const padded = computeSlots(base({ ...common, paddingAfterMin: 15 }));
  assert.ok(
    !starts(padded).includes("2026-06-01T13:00:00.000Z"),
    "09:00 slot must be rejected when padding collides with the 10:00 appointment",
  );
});

test("padding must fit inside the working window", () => {
  const slots = computeSlots(
    base({
      weekly: [{ weekday: 1, startLocal: "09:00", endLocal: "10:30" }],
      durationMin: 60,
      paddingBeforeMin: 15,
      paddingAfterMin: 15,
      from: new Date("2026-06-01T00:00:00-04:00"),
      to: new Date("2026-06-02T00:00:00-04:00"),
    }),
  );
  // Only candidate: visible 09:15-10:15, padded 09:00-10:30 — exactly fits.
  assert.deepEqual(starts(slots), ["2026-06-01T13:15:00.000Z"]);
  assert.equal(slots[0].paddedStart, "2026-06-01T13:00:00.000Z");
  assert.equal(slots[0].paddedEnd, "2026-06-01T14:30:00.000Z");
});

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------
test("whole-day override (NULL times) removes a normal workday", () => {
  const input = base({
    weekly: [{ weekday: 1, startLocal: "09:00", endLocal: "17:00" }],
    from: new Date("2026-06-01T00:00:00-04:00"),
    to: new Date("2026-06-02T00:00:00-04:00"),
  });
  assert.ok(computeSlots(input).length > 0, "sanity: weekday normally has slots");

  const withDayOff = computeSlots({
    ...input,
    overrides: [{ dateLocal: "2026-06-01", startLocal: null, endLocal: null }],
  });
  assert.equal(withDayOff.length, 0);
});

test("ranged override replaces the weekly windows for that day", () => {
  const slots = computeSlots(
    base({
      weekly: [{ weekday: 1, startLocal: "09:00", endLocal: "17:00" }],
      overrides: [
        { dateLocal: "2026-06-01", startLocal: "12:00", endLocal: "14:00" },
      ],
      from: new Date("2026-06-01T00:00:00-04:00"),
      to: new Date("2026-06-02T00:00:00-04:00"),
    }),
  );
  assert.deepEqual(starts(slots), [
    "2026-06-01T16:00:00.000Z", // 12:00 EDT
    "2026-06-01T17:00:00.000Z", // 13:00 EDT
  ]);
});

// ---------------------------------------------------------------------------
// Lead-time cutoff mid-day
// ---------------------------------------------------------------------------
test("min lead time cuts off same-day slots mid-day", () => {
  const slots = computeSlots(
    base({
      weekly: [{ weekday: 1, startLocal: "09:00", endLocal: "17:00" }],
      now: new Date("2026-06-01T10:30:00-04:00"),
      minLeadTimeMin: 120, // earliest bookable: 12:30 local
      from: new Date("2026-06-01T00:00:00-04:00"),
      to: new Date("2026-06-02T00:00:00-04:00"),
    }),
  );
  // Hourly candidates 09..16; first one at/after 12:30 is 13:00 EDT (17:00Z).
  assert.equal(slots[0].start, "2026-06-01T17:00:00.000Z");
  assert.deepEqual(
    starts(slots),
    ["17:00", "18:00", "19:00", "20:00"].map((t) => `2026-06-01T${t}:00.000Z`),
  );
});

// ---------------------------------------------------------------------------
// Horizon + step + grouping
// ---------------------------------------------------------------------------
test("max horizon caps how far out slots are offered", () => {
  const slots = computeSlots(
    base({
      weekly: [{ weekday: 1, startLocal: "09:00", endLocal: "10:00" }],
      now: new Date("2026-05-31T00:00:00Z"),
      maxHorizonDays: 5, // horizon ends 2026-06-05 — Monday 06-08 is out of reach
      from: new Date("2026-06-01T00:00:00Z"),
      to: new Date("2026-06-15T00:00:00Z"),
    }),
  );
  assert.deepEqual(starts(slots), ["2026-06-01T13:00:00.000Z"]);
});

test("slot step smaller than duration yields overlapping candidates", () => {
  const slots = computeSlots(
    base({
      weekly: [{ weekday: 1, startLocal: "09:00", endLocal: "11:00" }],
      durationMin: 60,
      slotStepMin: 30,
      from: new Date("2026-06-01T00:00:00-04:00"),
      to: new Date("2026-06-02T00:00:00-04:00"),
    }),
  );
  assert.deepEqual(
    starts(slots),
    ["13:00", "13:30", "14:00"].map((t) => `2026-06-01T${t}:00.000Z`),
  );
});

test("clientDay groups by the CLIENT timezone, not the staff timezone", () => {
  const slots = computeSlots(
    base({
      weekly: [{ weekday: 1, startLocal: "21:00", endLocal: "23:00" }], // Mon evening NY
      clientTimezone: "Europe/London",
      from: new Date("2026-06-01T00:00:00-04:00"),
      to: new Date("2026-06-02T00:00:00-04:00"),
    }),
  );
  // 21:00 EDT Mon = 01:00Z Tue = 02:00 London Tue.
  assert.equal(slots.length, 2);
  assert.ok(slots.every((s) => s.clientDay === "2026-06-02"));
});
