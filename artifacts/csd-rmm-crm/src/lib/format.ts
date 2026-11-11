// Shared display formatters. Use these instead of re-declaring helpers per page.

/**
 * "(954) 555-0101" for a 10-digit US number (with or without +1 / punctuation);
 * anything else is returned as given. `empty` is shown for a missing value.
 */
export function formatUsPhone(value: string | null | undefined, empty = ""): string {
  if (!value) return empty;
  const digits = value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : value;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });

/** Money stored in cents (invoices, appointments, CRM jobs and leads): "$150.00". */
export function formatUsdCents(cents: number, options: { wholeDollars?: boolean } = {}): string {
  return (options.wholeDollars ? usdWhole : usd).format(cents / 100);
}

/** Same as formatUsdCents, but shows `empty` for null/undefined. */
export function formatUsdCentsOr(cents: number | null | undefined, empty = "—"): string {
  return cents == null ? empty : formatUsdCents(cents);
}
