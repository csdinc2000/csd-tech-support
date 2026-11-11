/**
 * Pure helpers for the sales agents. No database or network access here so
 * every rule can be unit-tested directly (see sales-agents-core.test.ts).
 */

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

export function firstNameOf(fullName: string | null | undefined): string {
  const first = String(fullName ?? "").trim().split(/\s+/)[0] ?? "";
  // Avoid greeting someone as "Acme" when only a company name was captured.
  return /^[A-Za-zÀ-ÿ'’-]{1,30}$/.test(first) ? first.charAt(0).toUpperCase() + first.slice(1) : "";
}

export const DEFAULT_AUTO_TEXT_TEMPLATE =
  "Hi {firstName}, thanks for contacting Computer Systems Depot! We got your request and a technician will reach out shortly. Need us sooner? Call (954) 637-7300. Reply STOP to opt out.";

const TEMPLATE_TOKENS = ["firstName", "service", "company"] as const;
export type TemplateValues = Partial<Record<(typeof TEMPLATE_TOKENS)[number], string | null | undefined>>;

/**
 * Fill {firstName} / {service} / {company}. Unknown tokens are left alone so a
 * typo is visible in the preview. Empty values collapse cleanly ("Hi there,").
 */
export function renderAutoText(template: string, values: TemplateValues): string {
  let out = template;
  for (const token of TEMPLATE_TOKENS) {
    const value = String(values[token] ?? "").trim();
    const fallback = token === "firstName" ? "there" : token === "service" ? "your request" : "";
    out = out.split(`{${token}}`).join(value || fallback);
  }
  return out.replace(/[ \t]{2,}/g, " ").replace(/ ([,.!?])/g, "$1").trim();
}

export function validateAutoTextTemplate(template: string): string | null {
  const text = template.trim();
  if (text.length < 10) return "The message is too short.";
  if (text.length > 480) return "Keep the message under 480 characters (about three texts).";
  if (!/\bSTOP\b/i.test(text)) return 'Include opt-out wording such as "Reply STOP to opt out."';
  const unknown = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((t) => !(TEMPLATE_TOKENS as readonly string[]).includes(t));
  if (unknown.length) return `Unknown placeholder: {${unknown[0]}}. Use {firstName}, {service} or {company}.`;
  return null;
}

// ---------------------------------------------------------------------------
// Speed to Lead
// ---------------------------------------------------------------------------

export type BusinessHours = {
  businessHoursOnly: boolean;
  startHour: number; // 0-23, local
  endHour: number; // 1-24, local, exclusive
  days: number[]; // 0 = Sunday
  timezone: string;
};

/** Local weekday (0=Sun) and hour for an instant in an IANA time zone. */
export function localDayHour(now: Date, timezone: string): { day: number; hour: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(now);
  }
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday), hour };
}

export function isWithinBusinessHours(now: Date, hours: BusinessHours): boolean {
  if (!hours.businessHoursOnly) return true;
  const { day, hour } = localDayHour(now, hours.timezone);
  return hours.days.includes(day) && hour >= hours.startHour && hour < hours.endHour;
}

export function parseBusinessDays(value: string): number[] {
  return [...new Set(value.split(",").map((d) => Number(d.trim())).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
}

/**
 * Whether a lead should get the automation. Only inbound leads created after
 * the automation was switched on; cold sources (prospects we imported) are
 * excluded because they never asked to be contacted.
 */
export function leadQualifiesForSpeedToLead(
  lead: { source: string | null; createdAt: Date },
  settings: { enabled: boolean; enabledAt: Date | null; excludedSources: string[] },
): boolean {
  if (!settings.enabled || !settings.enabledAt) return false;
  if (lead.createdAt.getTime() < settings.enabledAt.getTime()) return false;
  const source = (lead.source ?? "").trim().toLowerCase();
  return !settings.excludedSources.map((s) => s.trim().toLowerCase()).includes(source);
}

export function shouldEscalate(
  event: { leadCreatedAt: Date; firstContactAt: Date | null; escalatedAt: Date | null },
  targetMinutes: number,
  now: Date,
): boolean {
  if (event.firstContactAt || event.escalatedAt) return false;
  return now.getTime() - event.leadCreatedAt.getTime() >= targetMinutes * 60_000;
}

export type SpeedToLeadMetrics = {
  total: number;
  contacted: number;
  waiting: number;
  medianMinutes: number | null;
  withinTargetPct: number | null;
  autoTextsSent: number;
  escalations: number;
};

export function summarizeSpeedToLead(
  events: Array<{ leadCreatedAt: Date; firstContactAt: Date | null; autoTextStatus: string; escalatedAt: Date | null }>,
  targetMinutes: number,
): SpeedToLeadMetrics {
  const minutes = events
    .filter((e) => e.firstContactAt)
    .map((e) => Math.max(0, (e.firstContactAt!.getTime() - e.leadCreatedAt.getTime()) / 60_000))
    .sort((a, b) => a - b);
  const mid = Math.floor(minutes.length / 2);
  const median = minutes.length === 0 ? null : minutes.length % 2 ? minutes[mid] : (minutes[mid - 1] + minutes[mid]) / 2;
  return {
    total: events.length,
    contacted: minutes.length,
    waiting: events.length - minutes.length,
    medianMinutes: median == null ? null : Math.round(median * 10) / 10,
    withinTargetPct: minutes.length ? Math.round((minutes.filter((m) => m <= targetMinutes).length / minutes.length) * 100) : null,
    autoTextsSent: events.filter((e) => e.autoTextStatus === "sent").length,
    escalations: events.filter((e) => e.escalatedAt).length,
  };
}

/** Interaction types that count as a human reaching out to the lead. */
// call_in is excluded: it is usually the lead's own first call, not our reply.
export const FIRST_CONTACT_INTERACTION_TYPES = ["call_out", "sms", "email", "appointment", "meeting", "manual_contact"] as const;
/** performed_by values that are automation, never a human first contact. */
export const AUTOMATED_PERFORMERS = ["system", "speed_to_lead", "automation"] as const;

// ---------------------------------------------------------------------------
// Lead Generation Agent
// ---------------------------------------------------------------------------

export function normalizeWebsite(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".")) return null;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)) return null;
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return null;
  }
}

/** Stable key so the same business is recognised across runs and against the CRM. */
export function prospectDedupeKey(name: string, website: string | null): string {
  const host = website ? (() => { try { return new URL(website).hostname.replace(/^www\./, ""); } catch { return ""; } })() : "";
  if (host) return `web:${host}`;
  return `name:${name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").replace(/\b(inc|llc|corp|co|ltd|pa|pllc)\b/g, "").replace(/\s+/g, " ").trim()}`;
}

export function clampScore(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}

/** Digits-only E.164-ish US phone, or null. Keeps formatting decisions in one place. */
export function normalizeProspectPhone(value: string | null | undefined): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

// ---------------------------------------------------------------------------
// Executive Assistant
// ---------------------------------------------------------------------------

export type TaskBucket = "overdue" | "today" | "upcoming" | "someday";

export function bucketTask(dueAt: Date | null, now: Date, timezone = "America/New_York"): TaskBucket {
  if (!dueAt) return "someday";
  if (dueAt.getTime() < now.getTime()) return "overdue";
  const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return day(dueAt) === day(now) ? "today" : "upcoming";
}
