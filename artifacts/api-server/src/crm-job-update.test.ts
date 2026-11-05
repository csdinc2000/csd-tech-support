import assert from "node:assert/strict";
import test from "node:test";
import { crmJobUpdateFromBody } from "./crm-job-update";

test("an ISO completed date string becomes a Date", () => {
  const update = crmJobUpdateFromBody({ status: "completed", completedDateTime: "2026-11-03T15:30:00.000Z" }, { completedDateTime: null });
  assert.ok(update.completedDateTime instanceof Date);
  assert.equal((update.completedDateTime as Date).toISOString(), "2026-11-03T15:30:00.000Z");
});

test("a bare calendar day is stored at noon UTC so it keeps its day in US time zones", () => {
  const update = crmJobUpdateFromBody({ completedDateTime: "2026-10-28" }, { completedDateTime: null });
  assert.equal((update.completedDateTime as Date).toISOString(), "2026-10-28T12:00:00.000Z");
});

test("the completed date can be cleared", () => {
  const update = crmJobUpdateFromBody({ completedDateTime: "" }, { completedDateTime: new Date() });
  assert.equal(update.completedDateTime, null);
});

test("marking completed stamps today only when no date exists or is supplied", () => {
  const before = Date.now();
  const stamped = crmJobUpdateFromBody({ status: "completed" }, { completedDateTime: null });
  assert.ok((stamped.completedDateTime as Date).getTime() >= before);

  const kept = crmJobUpdateFromBody({ status: "completed" }, { completedDateTime: new Date("2026-01-02T12:00:00Z") });
  assert.equal(kept.completedDateTime, undefined);
});

test("identity columns are ignored and bad values are rejected", () => {
  const update = crmJobUpdateFromBody({ id: 9, jobNumber: "X", createdAt: "2020-01-01", notes: "ok" }, { completedDateTime: null });
  assert.deepEqual(update, { notes: "ok" });
  assert.throws(() => crmJobUpdateFromBody({ status: "done" }, { completedDateTime: null }), /status must be one of/);
  assert.throws(() => crmJobUpdateFromBody({ completedDateTime: "not a date" }, { completedDateTime: null }), /not a valid date/);
  assert.throws(() => crmJobUpdateFromBody({ estimatedAmount: "12.5" }, { completedDateTime: null }), /whole number/);
});

test("ready_pickup is an accepted status", () => {
  assert.deepEqual(crmJobUpdateFromBody({ status: "ready_pickup" }, { completedDateTime: null }), { status: "ready_pickup" });
});
