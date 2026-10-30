import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const INVOICE_STATUSES = ["draft", "sent", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export type InvoiceLineInput = {
  description: string;
  quantity: number;
  unitAmountCents: number;
};

const MAX_CENTS = 2_000_000_000;

export function calculateInvoiceTotals(
  lines: InvoiceLineInput[],
  taxRateBps = 0,
  discountCents = 0,
) {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 200) {
    throw new Error("Invoice must contain between 1 and 200 line items");
  }
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 10000) {
    throw new Error("taxRateBps must be an integer between 0 and 10000");
  }
  if (!Number.isSafeInteger(discountCents) || discountCents < 0 || discountCents > MAX_CENTS) {
    throw new Error("discountCents must be a non-negative integer");
  }

  const normalizedLines = lines.map((line, index) => {
    const description = typeof line.description === "string" ? line.description.trim() : "";
    if (!description || description.length > 500) {
      throw new Error(`Line item ${index + 1} must have a description of at most 500 characters`);
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 100000) {
      throw new Error(`Line item ${index + 1} quantity must be a positive integer`);
    }
    if (
      !Number.isSafeInteger(line.unitAmountCents) ||
      line.unitAmountCents < 0 ||
      line.unitAmountCents > MAX_CENTS
    ) {
      throw new Error(`Line item ${index + 1} unitAmountCents must be a non-negative integer`);
    }
    const amountCents = line.quantity * line.unitAmountCents;
    if (!Number.isSafeInteger(amountCents) || amountCents > MAX_CENTS) {
      throw new Error(`Line item ${index + 1} amount is too large`);
    }
    return { description, quantity: line.quantity, unitAmountCents: line.unitAmountCents, amountCents };
  });

  const subtotalCents = normalizedLines.reduce((sum, line) => sum + line.amountCents, 0);
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents > MAX_CENTS) {
    throw new Error("Invoice subtotal is too large");
  }
  const taxCents = Math.round((subtotalCents * taxRateBps) / 10000);
  if (discountCents > subtotalCents + taxCents) {
    throw new Error("discountCents cannot exceed subtotal plus tax");
  }
  return {
    lines: normalizedLines,
    subtotalCents,
    taxRateBps,
    taxCents,
    discountCents,
    totalCents: subtotalCents + taxCents - discountCents,
  };
}

export function normalizePayPalCheckoutUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2000) throw new Error("Invalid PayPal checkout URL");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid PayPal checkout URL");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    (host !== "paypal.com" && host !== "www.paypal.com" && host !== "paypal.me") ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("PayPal checkout URL must use HTTPS on paypal.com, www.paypal.com, or paypal.me");
  }
  return parsed.toString();
}

export function assertDraftMutable(status: string): void {
  if (status !== "draft") throw new Error("Only draft invoices can be edited or deleted");
}

export function canTransitionInvoiceStatus(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return (
    (from === "draft" && to === "sent") ||
    (from === "sent" && (to === "paid" || to === "void"))
  );
}

export function assertInvoiceStatusTransition(from: InvoiceStatus, to: InvoiceStatus): void {
  if (!canTransitionInvoiceStatus(from, to)) {
    throw new Error(`Invoice cannot transition from ${from} to ${to}`);
  }
}

export function generatePublicInvoiceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashPublicInvoiceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function verifyPublicInvoiceToken(token: string, expectedHash: string): boolean {
  if (!isValidPublicInvoiceToken(token)) return false;
  const actual = Buffer.from(hashPublicInvoiceToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isValidPublicInvoiceToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{40,100}$/.test(token);
}

export function getCanonicalInvoiceAppBaseUrl(raw = process.env.APP_BASE_URL): string {
  if (!raw || !raw.trim()) throw new Error("APP_BASE_URL is required to create public invoice links");
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("APP_BASE_URL must be an HTTPS origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

export function isInvoicePaymentWebhookType(type: unknown): boolean {
  return type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded";
}

export function isValidInvoiceCheckoutPayment(
  session: { id?: unknown; mode?: unknown; status?: unknown; payment_status?: unknown; amount_total?: unknown; currency?: unknown; metadata?: Record<string, unknown> | null },
  invoice: { id: number; total_cents: number; stripe_checkout_session_id: string | null },
): boolean {
  return (
    session.id === invoice.stripe_checkout_session_id &&
    session.mode === "payment" &&
    session.status === "complete" &&
    session.payment_status === "paid" &&
    session.amount_total === invoice.total_cents &&
    typeof session.currency === "string" &&
    session.currency.toLowerCase() === "usd" &&
    session.metadata?.invoiceId === String(invoice.id) &&
    !!invoice.stripe_checkout_session_id
  );
}