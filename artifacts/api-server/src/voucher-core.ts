// ---------------------------------------------------------------------------
// Discount vouchers — pure helpers (no database), unit-tested in
// voucher-core.test.ts. Routes and storage live in vouchers.ts.
// ---------------------------------------------------------------------------

export const VOUCHER_STATUSES = ["active", "redeemed", "void"] as const;
export type VoucherStatus = (typeof VOUCHER_STATUSES)[number];
/** What staff and customers see: `active` past its expiry date reads as `expired`. */
export type VoucherState = VoucherStatus | "expired";

export const MIN_PERCENT_OFF = 1;
export const MAX_PERCENT_OFF = 100;

// No 0/O, 1/I/L — codes get read aloud over the phone and typed at the counter.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_SUFFIX_LENGTH = 6;

/**
 * A voucher code such as `CSD-7K3QDM`. The percentage is deliberately not
 * part of the code, so staff can adjust the discount without the code going
 * stale. `randomBytes` is injectable for tests.
 */
export function makeVoucherCode(randomBytes: (size: number) => Uint8Array): string {
  const bytes = randomBytes(CODE_SUFFIX_LENGTH);
  let suffix = "";
  for (let i = 0; i < CODE_SUFFIX_LENGTH; i++) suffix += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `CSD-${suffix}`;
}

/** Cleans a code typed by a person ("csd 7k3qdm", "CSD-7K3QDM "). Returns null when it can't be a code. */
export function normalizeVoucherCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const match = /^CSD([A-Z0-9]{6})$/.exec(compact);
  return match ? `CSD-${match[1]}` : null;
}

/** True for a whole-number percentage the business can honour (1–100). */
export function isValidPercentOff(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_PERCENT_OFF && value <= MAX_PERCENT_OFF;
}

/**
 * Discount in cents for a subtotal: the percentage rounded to the nearest
 * cent, never more than the optional cap and never more than the subtotal.
 */
export function voucherDiscountCents(subtotalCents: number, percentOff: number, maxDiscountCents: number | null = null): number {
  if (!Number.isFinite(subtotalCents) || subtotalCents <= 0) return 0;
  if (!isValidPercentOff(percentOff)) throw new Error("percentOff must be a whole number from 1 to 100");
  let discount = Math.round((subtotalCents * percentOff) / 100);
  if (maxDiscountCents != null && maxDiscountCents >= 0) discount = Math.min(discount, maxDiscountCents);
  return Math.min(discount, Math.round(subtotalCents));
}

/** Today's calendar date (YYYY-MM-DD) in the business time zone. */
export function businessDate(now: Date, timeZone = "America/New_York"): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * A voucher is good through the end of its expiry date (business time), so a
 * customer holding a "valid until Nov 30" voucher can still use it on Nov 30.
 */
export function voucherState(
  voucher: { status: VoucherStatus; expiresOn: string | null },
  today: string,
): VoucherState {
  if (voucher.status !== "active") return voucher.status;
  if (voucher.expiresOn && voucher.expiresOn < today) return "expired";
  return "active";
}

export type VoucherSummary = { total: number; active: number; redeemed: number; expired: number; void: number };

export function summarizeVouchers(states: VoucherState[]): VoucherSummary {
  const summary: VoucherSummary = { total: states.length, active: 0, redeemed: 0, expired: 0, void: 0 };
  for (const state of states) summary[state] += 1;
  return summary;
}

/** "$25.00" — for emails and the redemption preview. */
export function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "Nov 30, 2026" from a YYYY-MM-DD date, without time-zone drift. */
export function formatDateOnly(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

/** One line describing the offer: "15% off your next service (up to $50.00)". */
export function describeVoucher(voucher: { percentOff: number; maxDiscountCents: number | null }): string {
  const cap = voucher.maxDiscountCents != null ? ` (up to ${formatUsd(voucher.maxDiscountCents)})` : "";
  return `${voucher.percentOff}% off your next service${cap}`;
}
