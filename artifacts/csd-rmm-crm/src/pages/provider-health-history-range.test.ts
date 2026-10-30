import assert from "node:assert/strict";
import test from "node:test";
import {
  historyDateRangeToUtcInstants,
  readHistoryDateRange,
} from "./provider-health-history-range.ts";

test("shared New York dates retain their original boundaries across the spring DST change", () => {
  const { range, error } = readHistoryDateRange(new URLSearchParams(
    "historyFrom=2026-03-07&historyTo=2026-03-08&historyZone=America%2FNew_York",
  ));
  assert.equal(error, null);
  assert.deepEqual(historyDateRangeToUtcInstants(range!), {
    fromDate: "2026-03-07T05:00:00.000Z",
    toDate: "2026-03-09T04:00:00.000Z",
  });
});

test("shared Tokyo dates include changes near UTC midnight and export uses the same bounds", () => {
  const { range } = readHistoryDateRange(new URLSearchParams(
    "historyFrom=2026-09-27&historyTo=2026-09-27&historyZone=Asia%2FTokyo",
  ));
  assert.deepEqual(historyDateRangeToUtcInstants(range!), {
    fromDate: "2026-09-26T15:00:00.000Z",
    toDate: "2026-09-27T15:00:00.000Z",
  });
});

test("Santiago's midnight clock change uses the first instant of each adjacent day", () => {
  const september5 = readHistoryDateRange(new URLSearchParams(
    "historyFrom=2026-09-05&historyTo=2026-09-05&historyZone=America%2FSantiago",
  )).range!;
  const september6 = readHistoryDateRange(new URLSearchParams(
    "historyFrom=2026-09-06&historyTo=2026-09-06&historyZone=America%2FSantiago",
  )).range!;
  assert.deepEqual(historyDateRangeToUtcInstants(september5), {
    fromDate: "2026-09-05T04:00:00.000Z",
    toDate: "2026-09-06T04:00:00.000Z",
  });
  assert.deepEqual(historyDateRangeToUtcInstants(september6), {
    fromDate: "2026-09-06T04:00:00.000Z",
    toDate: "2026-09-07T03:00:00.000Z",
  });
});

test("date-only older links always use UTC, regardless of the viewer's zone", () => {
  const { range } = readHistoryDateRange(new URLSearchParams(
    "historyFrom=2026-09-27&historyTo=2026-09-27",
  ));
  assert.equal(range?.timeZone, "UTC");
  assert.deepEqual(historyDateRangeToUtcInstants(range!), {
    fromDate: "2026-09-27T00:00:00.000Z",
    toDate: "2026-09-28T00:00:00.000Z",
  });
});

test("invalid or orphaned zones cannot silently alter the visible range", () => {
  for (const query of [
    "historyFrom=2026-09-27&historyTo=2026-09-27&historyZone=Nowhere",
    "historyFrom=2026-09-27&historyTo=2026-09-27&historyZone=",
    "historyZone=America%2FNew_York",
  ]) {
    const result = readHistoryDateRange(new URLSearchParams(query));
    assert.equal(result.range, null);
    assert.ok(result.error);
  }
});