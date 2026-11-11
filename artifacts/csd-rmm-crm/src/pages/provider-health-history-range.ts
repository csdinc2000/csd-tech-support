import { fromZonedTime } from "date-fns-tz";

export type WarningHistoryDateRange = {
  fromDate: string;
  toDate: string;
  timeZone: string;
};

export const historyFromParam = "historyFrom";
export const historyToParam = "historyTo";
export const historyZoneParam = "historyZone";

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function readHistoryDateRange(params: URLSearchParams): {
  range: WarningHistoryDateRange | null;
  error: string | null;
} {
  const fromDate = params.get(historyFromParam);
  const toDate = params.get(historyToParam);
  const zone = params.get(historyZoneParam);
  if (fromDate === null && toDate === null && zone === null) return { range: null, error: null };
  if (!fromDate || !toDate) {
    return { range: null, error: "The link needs both a From and a To date. Choose both dates, then show the range, or clear the dates." };
  }
  if (!isCalendarDate(fromDate) || !isCalendarDate(toDate)) {
    return { range: null, error: "The link contains an invalid date. Choose real From and To dates, then show the range, or clear the dates." };
  }
  if (fromDate > toDate) {
    return { range: null, error: "The link's start date is after its end date. Correct the dates, then show the range, or clear the dates." };
  }
  // Older links did not save a zone. Interpret them consistently as UTC instead
  // of assigning a different period to every recipient.
  const timeZone = zone === null ? "UTC" : zone;
  if (!isTimeZone(timeZone)) {
    return { range: null, error: "The link contains an invalid time zone. Show the dates again to use your time zone, or clear the dates." };
  }
  return { range: { fromDate, toDate, timeZone }, error: null };
}

export function historyDateRangeToUtcInstants(range: WarningHistoryDateRange) {
  const nextDate = new Date(`${range.toDate}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return {
    fromDate: firstInstantOfDay(range.fromDate, range.timeZone).toISOString(),
    toDate: firstInstantOfDay(nextDate.toISOString().slice(0, 10), range.timeZone).toISOString(),
  };
}

function firstInstantOfDay(date: string, timeZone: string): Date {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localDate = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant));
    const part = (type: string) => parts.find((item) => item.type === type)!.value;
    return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
  };

  // fromZonedTime gives a close estimate, but a midnight DST jump can make
  // 00:00 nonexistent and resolve it into the previous calendar day.
  const estimate = fromZonedTime(`${date}T00:00:00`, timeZone).getTime();
  const window = 48 * 60 * 60 * 1000;
  let low = estimate - window;
  let high = estimate + window;
  // Find the first UTC millisecond whose date in the saved zone is this day
  // (or later). The upper bound is exclusive.
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDate(middle) < date) low = middle + 1;
    else high = middle;
  }
  return new Date(low);
}