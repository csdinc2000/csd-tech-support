import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { toValidE164 } from "./phone-validation";

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
  // Discounts reduce the taxable amount: tax is charged on (subtotal - discount).
  if (discountCents > subtotalCents) {
    throw new Error("discountCents cannot exceed the subtotal");
  }
  const taxCents = invoiceTaxCents(subtotalCents, discountCents, taxRateBps);
  return {
    lines: normalizedLines,
    subtotalCents,
    taxRateBps,
    taxCents,
    discountCents,
    totalCents: subtotalCents + taxCents - discountCents,
  };
}

/** Sales tax on the discounted amount, rounded to the nearest cent. */
export function invoiceTaxCents(subtotalCents: number, discountCents: number, taxRateBps: number): number {
  return Math.round((Math.max(0, subtotalCents - discountCents) * taxRateBps) / 10000);
}

export function isoDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? null : value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** True when an edit to a sent invoice changes what the customer is asked to pay, or who pays it. */
export function sentInvoiceBillingChanged(
  existing: Record<string, any>,
  oldLines: { description: string; quantity: number; unit_amount_cents: number }[],
  input: { dueDate: string | null; totals: ReturnType<typeof calculateInvoiceTotals> },
  contactId: number,
  clientId: number | null,
): boolean {
  if (Number(existing.contact_id) !== Number(contactId)) return true;
  if ((existing.client_id == null ? null : Number(existing.client_id)) !== (clientId == null ? null : Number(clientId))) return true;
  if (isoDate(existing.due_date) !== input.dueDate) return true;
  const t = input.totals;
  if (
    existing.subtotal_cents !== t.subtotalCents || existing.tax_rate_bps !== t.taxRateBps ||
    existing.tax_cents !== t.taxCents || existing.discount_cents !== t.discountCents ||
    existing.total_cents !== t.totalCents
  ) return true;
  if (oldLines.length !== t.lines.length) return true;
  return t.lines.some((line, index) =>
    oldLines[index].description !== line.description ||
    Number(oldLines[index].quantity) !== line.quantity ||
    Number(oldLines[index].unit_amount_cents) !== line.unitAmountCents,
  );
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

/** Stripe's PDF CDN may return application/octet-stream; inspect the bytes before accepting it. */
export async function hasPdfSignature(body: ReadableStream<Uint8Array> | null): Promise<boolean> {
  if (!body) return false;
  const signature = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  const reader = body.getReader();
  let matched = 0;
  try {
    while (matched < signature.length) {
      const { value, done } = await reader.read();
      if (done) return false;
      for (const byte of value) {
        if (byte !== signature[matched]) return false;
        matched++;
        if (matched === signature.length) return true;
      }
    }
    return true;
  } finally {
    reader.releaseLock();
  }
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

export function sanitizeStripeReconciliationError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown reconciliation error";
  return message
    .replace(/\b(?:sk|rk|whsec|pk)_[A-Za-z0-9_-]+/gi, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /([?&\s](?:token|secret|password|api[_-]?key|signature)=)[^\s&]+/gi,
      "$1[redacted]",
    )
    .slice(0, 500);
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
  return (
    type === "checkout.session.completed" ||
    type === "checkout.session.async_payment_succeeded" ||
    type === "invoice.paid" ||
    type === "invoice.payment_succeeded"
  );
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

export function isValidStripeNativeInvoicePayment(
  stripeInvoice: {
    id?: unknown;
    status?: unknown;
    paid?: unknown;
    amount_paid?: unknown;
    currency?: unknown;
    metadata?: Record<string, unknown> | null;
  },
  invoice: { id: number; total_cents: number; stripe_invoice_id: string | null },
): boolean {
  return (
    stripeInvoice.id === invoice.stripe_invoice_id &&
    stripeInvoice.status === "paid" &&
    stripeInvoice.amount_paid === invoice.total_cents &&
    typeof stripeInvoice.currency === "string" &&
    stripeInvoice.currency.toLowerCase() === "usd" &&
    stripeInvoice.metadata?.crmInvoiceId === String(invoice.id) &&
    !!invoice.stripe_invoice_id
  );
}
/**
 * A billable party as chosen in the UI. Invoices are always stored against a
 * CRM contact that belongs to a client account, but the person raising the
 * invoice should not have to know that: they pick a client, a contact, or type
 * a brand new name, and the server resolves (or creates) the contact/account
 * pair behind it.
 */
export type InvoiceRecipientInput =
  | { kind: "contact"; contactId: number }
  | { kind: "client"; clientId: number }
  | { kind: "new"; name: string; email: string | null; phone: string | null; company: string | null };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeInvoiceEmail(value: unknown, field = "email"): string | null {
  if (value === undefined || value === null || value === "") return null;
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!email) return null;
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new Error(`${field} is not a valid email address`);
  return email;
}

export function normalizeInvoicePhone(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const phone = typeof value === "string" ? value.trim() : "";
  if (!phone) return null;
  if (phone.length > 40 || !toValidE164(phone)) throw new Error("phone number is invalid");
  return phone;
}

function requiredId(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`${field} is required`);
  return id;
}

function trimmedName(value: unknown, field: string, min: number, max: number): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (text.length < min || text.length > max) {
    throw new Error(`${field} must be between ${min} and ${max} characters`);
  }
  return text;
}

/**
 * Accepts the recipient shapes the invoice UI can produce and rejects anything
 * else. `contactId` on its own is still honoured so existing clients and saved
 * drafts keep working.
 */
export function normalizeInvoiceRecipient(body: any): InvoiceRecipientInput {
  const raw = body?.recipient;
  if (raw === undefined || raw === null) return { kind: "contact", contactId: requiredId(body?.contactId, "contactId") };
  if (typeof raw !== "object") throw new Error("recipient is invalid");

  switch (raw.kind) {
    case "contact":
      return { kind: "contact", contactId: requiredId(raw.contactId, "contactId") };
    case "client":
      return { kind: "client", clientId: requiredId(raw.clientId, "clientId") };
    case "new": {
      const name = trimmedName(raw.name, "recipient name", 2, 160);
      const company = raw.company === undefined || raw.company === null || String(raw.company).trim() === ""
        ? null
        : trimmedName(raw.company, "company", 2, 160);
      return {
        kind: "new",
        name,
        email: normalizeInvoiceEmail(raw.email, "recipient email"),
        phone: normalizeInvoicePhone(raw.phone),
        company,
      };
    }
    default:
      throw new Error("recipient kind must be contact, client, or new");
  }
}

/**
 * Account name for a walk-in: the business when there is one, otherwise the
 * person, so the ledger never shows an empty or duplicated account label.
 */
export function billingAccountName(personName: string, company?: string | null): string {
  const business = String(company ?? "").trim();
  return business || String(personName ?? "").trim();
}
