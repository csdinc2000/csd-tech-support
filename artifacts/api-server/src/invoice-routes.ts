import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { pool } from "./db";
import { getUncachableStripeClient } from "./stripeClient";
import { getAuth } from "@clerk/express";
import { requireAuth } from "./middlewares/clerkAuth";
import { isOwnerIdentity, rateLimit } from "./security";
import { canAccessFeature } from "./staff-access";
import {
  assertDraftMutable,
  assertInvoiceStatusTransition,
  calculateInvoiceTotals,
  generatePublicInvoiceToken,
  isoDate,
  sentInvoiceBillingChanged,
  hasPdfSignature,
  hashPublicInvoiceToken,
  getCanonicalInvoiceAppBaseUrl,
  isInvoicePaymentWebhookType,
  isValidInvoiceCheckoutPayment,
  isValidStripeNativeInvoicePayment,
  isValidPublicInvoiceToken,
  normalizeInvoiceRecipient,
  normalizePayPalCheckoutUrl,
  sanitizeStripeReconciliationError,
  verifyPublicInvoiceToken,
  billingAccountName,
  type InvoiceLineInput,
  type InvoiceRecipientInput,
  type InvoiceStatus,
} from "./invoice-core";
import { enqueueInvoiceEmail, processInvoiceEmailOutbox } from "./invoice-email-outbox";
import { reminderScheduledAt } from "./invoice-email-core";
import { logger } from "./lib/logger";
import { routeParam } from "./lib/route-params";
import {
  applyInvoiceDefaultsToOmittedFields,
  addUtcCalendarDays,
  DEFAULT_INVOICE_SETTINGS,
  getInvoiceSettings,
  invoiceBrandingSnapshot,
  publicInvoiceBranding,
  saveInvoiceSettings,
  validateInvoiceSettings,
  type InvoiceSettings,
} from "./invoice-settings";

type DbInvoice = Record<string, any>;

const STRIPE_DOCUMENT_MAX_ATTEMPTS = 3;
const STRIPE_DOCUMENT_RETRY_DELAYS_MS = [250, 750];

type StripeDocumentFetch = typeof globalThis.fetch;
type StripeDocumentResponse = Awaited<ReturnType<StripeDocumentFetch>>;

type StripeDocumentCheck = {
  crmInvoiceId: number;
  stripeInvoiceId: string;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
};

export class StripeDocumentVerificationError extends Error {
  readonly crmInvoiceId: number;
  readonly stripeInvoiceId: string;
  readonly documentKind: "hosted_invoice" | "invoice_pdf";
  readonly statusCategory: "permanent" | "exhausted";
  readonly attemptCount: number;

  constructor(
    input: StripeDocumentCheck,
    document: "hosted invoice" | "invoice PDF",
    reason: string,
    statusCategory: "permanent" | "exhausted",
    attemptCount: number,
  ) {
    super(
      `Stripe ${document} unavailable for CRM invoice ${input.crmInvoiceId} and Stripe invoice ${input.stripeInvoiceId}: ${reason}`,
    );
    this.name = "StripeDocumentVerificationError";
    this.crmInvoiceId = input.crmInvoiceId;
    this.stripeInvoiceId = input.stripeInvoiceId;
    this.documentKind = document === "hosted invoice" ? "hosted_invoice" : "invoice_pdf";
    this.statusCategory = statusCategory;
    this.attemptCount = attemptCount;
  }
}

function stripeDocumentFailure(
  input: StripeDocumentCheck,
  document: "hosted invoice" | "invoice PDF",
  reason: string,
  statusCategory: "permanent" | "exhausted" = "permanent",
  attemptCount = 1,
): StripeDocumentVerificationError {
  return new StripeDocumentVerificationError(input, document, reason, statusCategory, attemptCount);
}

function isTransientStripeDocumentStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function verifyStripeDocument(
  input: StripeDocumentCheck,
  document: "hosted invoice" | "invoice PDF",
  url: string | null,
  expectedContentType: string | null,
  fetchDocument: StripeDocumentFetch,
  pause: (milliseconds: number) => Promise<void>,
): Promise<void> {
  if (!url || !/^https:\/\//i.test(url)) {
    throw stripeDocumentFailure(input, document, "document URL is missing or invalid");
  }

  for (let attempt = 1; attempt <= STRIPE_DOCUMENT_MAX_ATTEMPTS; attempt++) {
    let response: StripeDocumentResponse;
    try {
      response = await fetchDocument(url, { redirect: "follow" });
    } catch {
      if (attempt < STRIPE_DOCUMENT_MAX_ATTEMPTS) {
        await pause(STRIPE_DOCUMENT_RETRY_DELAYS_MS[attempt - 1]);
        continue;
      }
      throw stripeDocumentFailure(input, document, "network request failed after 3 attempts", "exhausted", attempt);
    }

    try {
      if (response.ok) {
        if (expectedContentType) {
          const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
          if (contentType !== expectedContentType) {
            if (document === "invoice PDF" && contentType === "application/octet-stream") {
              let validPdf: boolean;
              try {
                validPdf = await hasPdfSignature(response.body);
              } catch {
                throw stripeDocumentFailure(input, document, "PDF response could not be inspected");
              }
              if (validPdf) return;
              throw stripeDocumentFailure(input, document, "binary response does not contain a PDF");
            }
            throw stripeDocumentFailure(
              input,
              document,
              `expected ${expectedContentType} but received ${contentType ?? "no content type"}`,
            );
          }
        }
        return;
      }

      if (!isTransientStripeDocumentStatus(response.status)) {
        throw stripeDocumentFailure(input, document, `received HTTP ${response.status}`);
      }
      if (attempt === STRIPE_DOCUMENT_MAX_ATTEMPTS) {
        throw stripeDocumentFailure(input, document, `received HTTP ${response.status} after 3 attempts`, "exhausted", attempt);
      }
    } finally {
      await response.body?.cancel();
    }
    await pause(STRIPE_DOCUMENT_RETRY_DELAYS_MS[attempt - 1]);
  }
}

export async function verifyStripeInvoiceDocuments(
  input: StripeDocumentCheck,
  options: {
    fetchDocument?: StripeDocumentFetch;
    pause?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  const fetchDocument = options.fetchDocument ?? globalThis.fetch;
  const pause = options.pause ?? wait;
  await verifyStripeDocument(input, "hosted invoice", input.hostedInvoiceUrl, null, fetchDocument, pause);
  await verifyStripeDocument(input, "invoice PDF", input.invoicePdfUrl, "application/pdf", fetchDocument, pause);
}

export async function verifyCurrentStripeInvoiceDocuments(
  row: DbInvoice,
  options: {
    retrieveInvoice?: (stripeInvoiceId: string) => Promise<{
      id: string;
      hosted_invoice_url?: string | null;
      invoice_pdf?: string | null;
    }>;
    fetchDocument?: StripeDocumentFetch;
    pause?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  if (!row.stripe_invoice_id) {
    throw new Error("Invoice email link is unavailable");
  }
  const retrieveInvoice = options.retrieveInvoice ?? (async (stripeInvoiceId: string) => {
    const stripe = await getUncachableStripeClient();
    return stripe.invoices.retrieve(stripeInvoiceId);
  });
  const stripeInvoice = await retrieveInvoice(row.stripe_invoice_id);
  await verifyStripeInvoiceDocuments(
    {
      crmInvoiceId: row.id,
      stripeInvoiceId: stripeInvoice.id,
      hostedInvoiceUrl: stripeInvoice.hosted_invoice_url ?? null,
      invoicePdfUrl: stripeInvoice.invoice_pdf ?? null,
    },
    { fetchDocument: options.fetchDocument, pause: options.pause },
  );
}

const publicInvoiceLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: "Too many invoice requests. Please wait and try again.",
  // Single-process limiter: tokens must not make its cardinality unbounded.
  key: (req) => `${req.ip || req.socket.remoteAddress || "unknown"}:public-invoice`,
  maxEntries: 2000,
});

function requireInvoiceAdmin(req: Request, res: Response, next: NextFunction) {
  void canAccessFeature(req, "invoices")
    .then((allowed) => allowed ? next() : res.status(403).json({ error: "Approved invoice access required" }))
    .catch(next);
}

function actor(req: Request): string {
  const auth = getAuth(req);
  return String(auth.sessionClaims?.email || req.dbUser?.id || "admin");
}

function baseUrl(): string {
  return getCanonicalInvoiceAppBaseUrl();
}

function idParam(value: string | string[], name = "id"): number {
  const id = Number(routeParam(value, name));
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid invoice id");
  return id;
}

function optionalText(value: unknown, name: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > max) throw new Error(`${name} is invalid`);
  return value.trim();
}

function calendarDate(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${name} is invalid`);
  return value;
}

function dueDate(value: unknown): string | null {
  return calendarDate(value, "dueDate");
}

/** The day the work was performed. `undefined` means "not supplied" (callers may default it from the job). */
function serviceDate(value: unknown): string | null | undefined {
  return value === undefined ? undefined : calendarDate(value, "serviceDate");
}

/** YYYY-MM-DD for a job's completion timestamp, used to default an invoice's service date. */
function jobServiceDate(job: { completed_date_time?: unknown } | null | undefined): string | null {
  const value = job?.completed_date_time;
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
}

function invoicePayload(body: any) {
  const recipient = normalizeInvoiceRecipient(body);
  const jobId = body?.jobId === undefined || body?.jobId === null || body?.jobId === "" ? null : Number(body.jobId);
  if (jobId !== null && (!Number.isSafeInteger(jobId) || jobId < 1)) throw new Error("jobId is invalid");
  const totals = calculateInvoiceTotals(
    body?.lineItems as InvoiceLineInput[],
    body?.taxRateBps ?? 0,
    body?.discountCents ?? 0,
  );
  return {
    recipient,
    jobId,
    dueDate: dueDate(body?.dueDate),
    serviceDate: serviceDate(body?.serviceDate),
    notes: optionalText(body?.notes, "notes", 10000),
    paypalCheckoutUrl: normalizePayPalCheckoutUrl(body?.paypalCheckoutUrl),
    totals,
  };
}

const invoiceOriginSchema = z.object({
  originInquiryId: z.uuid().optional(),
  correctionOfInvoiceId: z.number().int().positive().refine(Number.isSafeInteger).optional(),
});

function publicInvoice(row: DbInvoice, lines: any[], payments: any[]) {
  return {
    invoiceNumber: row.invoice_number,
    status: row.status,
    currency: row.currency,
    client: {
      name: row.client_name,
    },
    branding: publicInvoiceBranding(row.branding_snapshot),
    jobNumber: row.job_number,
    dueDate: row.due_date,
    serviceDate: row.service_date ?? null,
    notes: row.notes,
    lineItems: lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitAmountCents: line.unit_amount_cents,
      amountCents: line.amount_cents,
    })),
    subtotalCents: row.subtotal_cents,
    taxRateBps: row.tax_rate_bps,
    taxCents: row.tax_cents,
    discountCents: row.discount_cents,
    totalCents: row.total_cents,
    paypalCheckoutUrl: row.external_payment_pending ? null : row.paypal_checkout_url,
    stripeHostedInvoiceUrl: row.external_payment_pending ? null : row.stripe_hosted_invoice_url,
    stripeInvoicePdfUrl: row.stripe_invoice_pdf_url,
    sentAt: row.sent_at,
    paidAt: row.paid_at,
    payments: payments.map((payment) => ({
      provider: payment.provider,
      amountCents: payment.amount_cents,
      currency: payment.currency,
      verified: payment.verified,
      paidAt: payment.paid_at,
    })),
  };
}

function ownerInvoice(row: DbInvoice) {
  const { public_token_hash: _secretTokenHash, ...safe } = row;
  return safe;
}

function stripeDocumentIncidents(auditRows: DbInvoice[]) {
  return auditRows
    .filter((entry) => entry.action === "stripe_document_failed")
    .map((entry) => {
      const details = entry.details ?? {};
      return {
        id: entry.id,
        documentKind: details.documentKind === "invoice_pdf" ? "invoice_pdf" : "hosted_invoice",
        failureCategory: details.statusCategory === "exhausted" ? "exhausted" : "permanent",
        attempts: Number.isSafeInteger(details.attemptCount) && details.attemptCount > 0
          ? details.attemptCount
          : 1,
        resolutionStatus: details.resolutionStatus === "resolved" ? "resolved" : "active",
        lastSeenAt: typeof details.lastSeenAt === "string" ? details.lastSeenAt : entry.created_at,
        resolvedAt: details.resolutionStatus === "resolved" && typeof details.resolvedAt === "string"
          ? details.resolvedAt
          : null,
      };
    });
}

async function loadInvoice(id: number): Promise<DbInvoice | undefined> {
  const result = await pool.query("SELECT * FROM invoices WHERE id = $1", [id]);
  return result.rows[0];
}

async function loadInvoiceByToken(token: string): Promise<DbInvoice | undefined> {
  if (!isValidPublicInvoiceToken(token)) return undefined;
  const hash = hashPublicInvoiceToken(token);
  const result = await pool.query("SELECT * FROM invoices WHERE public_token_hash = $1", [hash]);
  const row = result.rows[0];
  return row && verifyPublicInvoiceToken(token, row.public_token_hash) ? row : undefined;
}

async function loadLinesAndPayments(id: number) {
  const [lines, payments] = await Promise.all([
    pool.query("SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position", [id]),
    pool.query("SELECT * FROM invoice_payments WHERE invoice_id = $1 ORDER BY paid_at, id", [id]),
  ]);
  return { lines: lines.rows, payments: payments.rows };
}

function stripeDaysUntilDue(value: unknown): number {
  if (typeof value !== "string" && !(value instanceof Date)) return 30;
  const dueDate = value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return 30;
  const due = new Date(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(due.valueOf()) || due.toISOString().slice(0, 10) !== dueDate) return 30;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.max(1, Math.min(365, Math.round((due.getTime() - todayUtc) / 86_400_000)));
}

async function ensureStripeCustomer(row: DbInvoice): Promise<string> {
  if (row.stripe_customer_id) return row.stripe_customer_id;
  const previous = row.client_id
    ? (
        await pool.query(
          `SELECT stripe_customer_id FROM invoices
            WHERE client_id=$1 AND stripe_customer_id IS NOT NULL
            ORDER BY id DESC LIMIT 1`,
          [row.client_id],
        )
      ).rows[0]?.stripe_customer_id
    : null;
  if (previous) {
    await pool.query("UPDATE invoices SET stripe_customer_id=$2, updated_at=now() WHERE id=$1", [row.id, previous]);
    return previous;
  }

  const stripe = await getUncachableStripeClient();
  const customer = await stripe.customers.create(
    {
      name: row.client_name,
      email: row.client_email || undefined,
      metadata: {
        crmClientId: row.client_id ? String(row.client_id) : "",
        crmContactId: String(row.contact_id),
      },
    },
    { idempotencyKey: `crm-invoice-customer-${row.client_id || `contact-${row.contact_id}`}` },
  );
  await pool.query("UPDATE invoices SET stripe_customer_id=$2, updated_at=now() WHERE id=$1", [row.id, customer.id]);
  return customer.id;
}

/**
 * Idempotency-key prefix for the Stripe objects of one invoice revision. Editing
 * a sent invoice voids its Stripe invoice and bumps `stripe_revision`, so the
 * replacement must not reuse the original keys (Stripe would replay the voided
 * objects for 24 hours). Revision 0 keeps the historical key format.
 */
export function stripeNativeInvoiceKey(row: DbInvoice): string {
  const revision = Number(row.stripe_revision ?? 0);
  return revision > 0 ? `crm-native-invoice-${row.id}-r${revision}` : `crm-native-invoice-${row.id}`;
}

function serviceDateLabel(value: unknown): string | null {
  if (!value) return null;
  const iso = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [year, month, day] = iso.split("-");
  return `${month}/${day}/${year}`;
}

export async function ensureStripeNativeInvoice(row: DbInvoice, branding?: InvoiceSettings) {
  const stripe = await getUncachableStripeClient();
  const customerId = await ensureStripeCustomer(row);
  const lines = (await loadLinesAndPayments(row.id)).lines;
  const key = stripeNativeInvoiceKey(row);
  const servedOn = serviceDateLabel(row.service_date);
  let stripeInvoice = row.stripe_invoice_id
    ? await stripe.invoices.retrieve(row.stripe_invoice_id)
    : await stripe.invoices.create(
        {
          customer: customerId,
          collection_method: "send_invoice",
          days_until_due: stripeDaysUntilDue(row.due_date),
          auto_advance: false,
          description: `Computer Systems Depot invoice ${row.invoice_number}`,
          footer: (branding ?? await getInvoiceSettings()).footer.slice(0, 500) || undefined,
          metadata: { crmInvoiceId: String(row.id), crmInvoiceNumber: row.invoice_number },
          custom_fields: [
            { name: "CSD invoice", value: row.invoice_number },
            ...(servedOn ? [{ name: "Date of service", value: servedOn }] : []),
          ],
        },
        { idempotencyKey: key },
      );

  await pool.query(
    `UPDATE invoices SET stripe_customer_id=$2, stripe_invoice_id=$3,
       stripe_hosted_invoice_url=$4, stripe_invoice_pdf_url=$5, updated_at=now()
     WHERE id=$1`,
    [row.id, customerId, stripeInvoice.id, stripeInvoice.hosted_invoice_url ?? null, stripeInvoice.invoice_pdf ?? null],
  );

  if (stripeInvoice.status === "draft") {
    for (const line of lines) {
      await stripe.invoiceItems.create(
        {
          customer: customerId,
          invoice: stripeInvoice.id,
          amount: line.amount_cents,
          currency: "usd",
          description: `${line.description} (${line.quantity} × $${(line.unit_amount_cents / 100).toFixed(2)})`,
          metadata: { crmInvoiceId: String(row.id), position: String(line.position) },
        },
        { idempotencyKey: `${key}-line-${line.position}` },
      );
    }
    if (row.tax_cents > 0) {
      await stripe.invoiceItems.create(
        {
          customer: customerId,
          invoice: stripeInvoice.id,
          amount: row.tax_cents,
          currency: "usd",
          description: `Tax (${(row.tax_rate_bps / 100).toFixed(2)}%)`,
          metadata: { crmInvoiceId: String(row.id), adjustment: "tax" },
        },
        { idempotencyKey: `${key}-tax` },
      );
    }
    if (row.discount_cents > 0) {
      await stripe.invoiceItems.create(
        {
          customer: customerId,
          invoice: stripeInvoice.id,
          amount: -row.discount_cents,
          currency: "usd",
          description: "Discount",
          metadata: { crmInvoiceId: String(row.id), adjustment: "discount" },
        },
        { idempotencyKey: `${key}-discount` },
      );
    }
    stripeInvoice = await stripe.invoices.finalizeInvoice(stripeInvoice.id, { auto_advance: false });
  }

  if (stripeInvoice.total !== row.total_cents || stripeInvoice.currency.toLowerCase() !== "usd") {
    if (stripeInvoice.status === "open") await stripe.invoices.voidInvoice(stripeInvoice.id);
    throw new Error("Stripe invoice total does not match the CRM invoice");
  }

  await pool.query(
    `UPDATE invoices SET stripe_hosted_invoice_url=$2, stripe_invoice_pdf_url=$3, updated_at=now()
     WHERE id=$1`,
    [row.id, stripeInvoice.hosted_invoice_url ?? null, stripeInvoice.invoice_pdf ?? null],
  );
  return stripeInvoice;
}

async function recordAudit(client: any, invoiceId: number, who: string, action: string, details: unknown = null) {
  await client.query(
    "INSERT INTO invoice_audit_records (invoice_id, actor, action, details) VALUES ($1, $2, $3, $4)",
    [invoiceId, who, action, details === null ? null : JSON.stringify(details)],
  );
}

async function recordStripeReconciliationFailure(
  invoice: DbInvoice,
  event: any,
  error: unknown,
): Promise<void> {
  const details = {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    stripeEventId: typeof event?.id === "string" ? event.id : "unknown",
    attemptCount: 1,
    lastError: sanitizeStripeReconciliationError(error),
    lastSeenAt: new Date().toISOString(),
  };
  await pool.query(
    `INSERT INTO invoice_audit_records (invoice_id, actor, action, details)
     VALUES ($1, 'stripe', 'stripe_reconciliation_failed', $2::jsonb)
     ON CONFLICT (invoice_id, action) WHERE action = 'stripe_reconciliation_failed'
     DO UPDATE SET details = jsonb_build_object(
       'invoiceId', EXCLUDED.details->>'invoiceId',
       'invoiceNumber', EXCLUDED.details->>'invoiceNumber',
       'stripeEventId', EXCLUDED.details->>'stripeEventId',
       'attemptCount', COALESCE((invoice_audit_records.details->>'attemptCount')::integer, 0) + 1,
       'lastError', EXCLUDED.details->>'lastError',
       'lastSeenAt', EXCLUDED.details->>'lastSeenAt'
     )`,
    [invoice.id, JSON.stringify(details)],
  );
}

export async function recordStripeDocumentFailure(
  error: StripeDocumentVerificationError,
  observedAt = new Date(),
): Promise<void> {
  const details = {
    crmInvoiceId: error.crmInvoiceId,
    stripeInvoiceId: error.stripeInvoiceId,
    documentKind: error.documentKind,
    statusCategory: error.statusCategory,
    attemptCount: error.attemptCount,
    resolutionStatus: "active",
    lastSeenAt: observedAt.toISOString(),
  };
  await pool.query(
    `INSERT INTO invoice_audit_records (invoice_id, actor, action, details)
     VALUES ($1, 'stripe', 'stripe_document_failed', $2::jsonb)
     ON CONFLICT (invoice_id, action) WHERE action = 'stripe_document_failed'
     DO UPDATE SET details = EXCLUDED.details, created_at = now()
       WHERE COALESCE(
               (invoice_audit_records.details->>'lastSeenAt')::timestamptz,
               '-infinity'::timestamptz
             ) <=
             (EXCLUDED.details->>'lastSeenAt')::timestamptz
         AND (
           invoice_audit_records.details->>'resolvedAt' IS NULL
           OR (invoice_audit_records.details->>'resolvedAt')::timestamptz <
              (EXCLUDED.details->>'lastSeenAt')::timestamptz
         )`,
    [error.crmInvoiceId, JSON.stringify(details)],
  );
}

export async function resolveStripeDocumentFailure(
  client: any,
  invoiceId: number,
  verifiedAt = new Date(),
): Promise<void> {
  await client.query(
    `UPDATE invoice_audit_records
     SET details = details || jsonb_build_object(
       'resolutionStatus', 'resolved',
       'resolvedAt', $2::timestamptz::text
     )
     WHERE invoice_id = $1
       AND action = 'stripe_document_failed'
       AND COALESCE(details->>'resolutionStatus', 'active') = 'active'
       AND COALESCE(
             (details->>'lastSeenAt')::timestamptz,
             '-infinity'::timestamptz
           ) <= $2::timestamptz`,
    [invoiceId, verifiedAt.toISOString()],
  );
}

const PLACEHOLDER_CONTACT_TAG = "__deleted_contact_placeholder__";

type ResolvedParty = {
  contact: DbInvoice;
  account: DbInvoice;
  createdContact: boolean;
  createdAccount: boolean;
};

/** SQL fragment reducing a stored phone column to comparable digits. */
const digitsOnly = (column: string) => `regexp_replace(coalesce(${column}, ''), '\\D', '', 'g')`;

async function findOrCreateAccount(client: any, name: string, email: string | null, phone: string | null) {
  const existing = (
    await client.query("SELECT * FROM clients WHERE lower(name) = lower($1) ORDER BY id LIMIT 1", [name])
  ).rows[0];
  if (existing) return { account: existing, created: false };
  const account = (
    await client.query(
      "INSERT INTO clients (name, contact_email, contact_phone) VALUES ($1,$2,$3) RETURNING *",
      // clients.contact_email is NOT NULL; a walk-in billed by phone has none yet.
      [name, email ?? "", phone],
    )
  ).rows[0];
  return { account, created: true };
}

/**
 * Every invoice is stored against a contact that belongs to an account. A
 * contact captured from a phone call or a walk-in often has neither, so the
 * missing account is created (or matched by name) rather than refusing to bill.
 */
async function attachAccount(client: any, contact: DbInvoice) {
  if (contact.client_id) {
    const account = (await client.query("SELECT * FROM clients WHERE id=$1", [contact.client_id])).rows[0];
    if (account) return { contact, account, createdAccount: false };
  }
  const { account, created } = await findOrCreateAccount(
    client,
    billingAccountName(contact.full_name, contact.company),
    contact.email,
    contact.mobile_phone || contact.office_phone,
  );
  const updated = (
    await client.query("UPDATE crm_contacts SET client_id=$2, updated_at=now() WHERE id=$1 RETURNING *", [contact.id, account.id])
  ).rows[0];
  return { contact: updated ?? contact, account, createdAccount: created };
}

async function resolveRecipient(client: any, recipient: InvoiceRecipientInput): Promise<ResolvedParty> {
  if (recipient.kind === "contact") {
    const contact = (await client.query("SELECT * FROM crm_contacts WHERE id=$1", [recipient.contactId])).rows[0];
    if (!contact) throw new Error("CRM contact not found");
    if (contact.tags === PLACEHOLDER_CONTACT_TAG) throw new Error("That contact was deleted and cannot be invoiced");
    return { ...(await attachAccount(client, contact)), createdContact: false };
  }

  if (recipient.kind === "client") {
    const account = (await client.query("SELECT * FROM clients WHERE id=$1", [recipient.clientId])).rows[0];
    if (!account) throw new Error("Client account not found");
    // Prefer the contact that matches the account billing address, then anyone
    // reachable by email, so "bill this company" needs no second choice.
    const contact = (
      await client.query(
        `SELECT * FROM crm_contacts
          WHERE client_id = $1 AND (tags IS NULL OR tags <> $2)
          ORDER BY ($3::text IS NOT NULL AND lower(coalesce(email, '')) = $3) DESC,
                   (nullif(btrim(coalesce(email, '')), '') IS NOT NULL) DESC, id
          LIMIT 1`,
        [account.id, PLACEHOLDER_CONTACT_TAG, account.contact_email?.trim().toLowerCase() || null],
      )
    ).rows[0];
    if (contact) return { contact, account, createdContact: false, createdAccount: false };
    const created = (
      await client.query(
        "INSERT INTO crm_contacts (full_name, email, mobile_phone, company, client_id) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [`${account.name} billing`, account.contact_email || null, account.contact_phone, account.name, account.id],
      )
    ).rows[0];
    return { contact: created, account, createdContact: true, createdAccount: false };
  }

  // A brand new payer. Reuse the person if we already know their email or
  // phone, so ad-hoc billing does not quietly fork the CRM record.
  const matched = recipient.email || recipient.phone
    ? (
        await client.query(
          `SELECT * FROM crm_contacts
            WHERE (tags IS NULL OR tags <> $3)
              AND (
                ($1::text IS NOT NULL AND lower(email) = $1)
                OR ($2::text IS NOT NULL AND $2 <> '' AND ${digitsOnly("mobile_phone")} = $2)
                OR ($2::text IS NOT NULL AND $2 <> '' AND ${digitsOnly("office_phone")} = $2)
              )
            ORDER BY id LIMIT 1`,
          [recipient.email, recipient.phone ? recipient.phone.replace(/\D/g, "") : null, PLACEHOLDER_CONTACT_TAG],
        )
      ).rows[0]
    : undefined;
  if (matched) return { ...(await attachAccount(client, matched)), createdContact: false };

  const { account, created } = await findOrCreateAccount(
    client,
    billingAccountName(recipient.name, recipient.company),
    recipient.email,
    recipient.phone,
  );
  const contact = (
    await client.query(
      "INSERT INTO crm_contacts (full_name, email, mobile_phone, company, client_id) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [recipient.name, recipient.email, recipient.phone, recipient.company, account.id],
    )
  ).rows[0];
  return { contact, account, createdContact: true, createdAccount: created };
}

/** Contact, account, optional job and the printed address for one invoice. */
async function resolveInvoiceParty(client: any, input: { recipient: InvoiceRecipientInput; jobId: number | null }) {
  const party = await resolveRecipient(client, input.recipient);
  let job: any = null;
  if (input.jobId) {
    job = (await client.query("SELECT * FROM crm_jobs WHERE id = $1", [input.jobId])).rows[0];
    if (!job) throw new Error("CRM job not found");
    if (job.contact_id !== party.contact.id) throw new Error("CRM job account does not match the selected contact");
  }
  const { contact } = party;
  const address = [contact.address, contact.city, contact.state, contact.zip_code].filter(Boolean).join(", ") || null;
  return { ...party, job, address };
}

// Stripe's pay endpoint is atomic against a card payment. A pending claim
// permits replay of the exact same request after a lost response; a different
// Stripe payment never counts as proof of an external settlement.
export async function closeStripeForExternalPayment(
  stripe: Awaited<ReturnType<typeof getUncachableStripeClient>>,
  stripeInvoiceId: string,
  crmInvoiceId: number,
  provider: "paypal" | "manual",
  reference: string,
  retry: boolean,
): Promise<void> {
  const invoice = await stripe.invoices.retrieve(stripeInvoiceId);
  if (invoice.status !== "open" && !(retry && invoice.status === "paid")) {
    throw new Error(invoice.status === "paid" ? "Stripe invoice was already paid" : "Stripe invoice is not open for an external payment");
  }
  const key = `crm-external-payment-${crmInvoiceId}-${createHash("sha256").update(`${provider}:${reference}`).digest("hex")}`;
  const closed = await stripe.invoices.pay(stripeInvoiceId, { paid_out_of_band: true }, { idempotencyKey: key });
  if (closed.id !== stripeInvoiceId || closed.status !== "paid") throw new Error("Stripe invoice did not close");
}

export function canRecordStripeSettlement(row: { status: string; external_payment_pending: boolean }): boolean {
  return row.status === "sent" && !row.external_payment_pending;
}

export function assertNoPendingExternalPayment(row: { external_payment_pending: boolean }): void {
  if (row.external_payment_pending) {
    throw new Error("External payment reconciliation is pending. Resolve it before voiding this invoice.");
  }
}

async function reconcileInvoice(row: DbInvoice): Promise<DbInvoice> {
  // A close request may have succeeded at Stripe even if the process lost its
  // response. Do not classify that out-of-band settlement as a Stripe charge.
  if (row.external_payment_pending) return (await loadInvoice(row.id)) ?? row;
  if (row.stripe_invoice_id && row.status !== "paid" && row.status !== "void") {
    const stripe = await getUncachableStripeClient();
    const stripeInvoice = await stripe.invoices.retrieve(row.stripe_invoice_id);
    await pool.query(
      "UPDATE invoices SET stripe_hosted_invoice_url=$2, stripe_invoice_pdf_url=$3, updated_at=now() WHERE id=$1",
      [row.id, stripeInvoice.hosted_invoice_url ?? null, stripeInvoice.invoice_pdf ?? null],
    );
    if (!isValidStripeNativeInvoicePayment(stripeInvoice, row as { id: number; total_cents: number; stripe_invoice_id: string | null })) {
      return (await loadInvoice(row.id)) ?? row;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = (await client.query("SELECT status, external_payment_pending FROM invoices WHERE id=$1 FOR UPDATE", [row.id])).rows[0];
      if (!current || !canRecordStripeSettlement(current)) {
        await client.query("COMMIT");
        return (await loadInvoice(row.id)) ?? row;
      }
      await client.query(
        `INSERT INTO invoice_payments
           (invoice_id, provider, provider_payment_id, amount_cents, currency, verified, paid_at)
         VALUES ($1, 'stripe', $2, $3, 'USD', true, now())
         ON CONFLICT (provider, provider_payment_id) DO NOTHING`,
        [row.id, stripeInvoice.id, row.total_cents],
      );
      const updated = await client.query(
        `UPDATE invoices SET status='paid', paid_at=COALESCE(paid_at, now()), updated_at=now()
         WHERE id=$1 AND status='sent' RETURNING *`,
        [row.id],
      );
      if (updated.rows[0]) {
        await recordAudit(client, row.id, "stripe", "payment_verified", { stripeInvoiceId: stripeInvoice.id });
        await client.query(
          "UPDATE invoice_email_outbox SET status='cancelled', last_error='Invoice is paid', updated_at=now() WHERE invoice_id=$1 AND status IN ('pending','failed')",
          [row.id],
        );
      }
      await client.query("COMMIT");
      return updated.rows[0] ?? (await loadInvoice(row.id))!;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  if (!row.stripe_checkout_session_id || row.status === "paid" || row.status === "void") return row;
  const stripe = await getUncachableStripeClient();
  const session = await stripe.checkout.sessions.retrieve(row.stripe_checkout_session_id);
  if (session.status !== "complete" || session.payment_status !== "paid") return row;
  if (!isValidInvoiceCheckoutPayment(session, row as { id: number; total_cents: number; stripe_checkout_session_id: string | null })) {
    throw new Error("Stripe Checkout payment does not match this invoice");
  }

  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  const paymentId = paymentIntentId || session.id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query("SELECT status, external_payment_pending FROM invoices WHERE id=$1 FOR UPDATE", [row.id])).rows[0];
    if (!current || !canRecordStripeSettlement(current)) {
      await client.query("COMMIT");
      return (await loadInvoice(row.id)) ?? row;
    }
    await client.query(
      `INSERT INTO invoice_payments
         (invoice_id, provider, provider_payment_id, amount_cents, currency, verified, paid_at)
       VALUES ($1, 'stripe', $2, $3, 'USD', true, now())
       ON CONFLICT (provider, provider_payment_id) DO NOTHING`,
      [row.id, paymentId, row.total_cents],
    );
    const updated = await client.query(
      `UPDATE invoices SET status = 'paid', paid_at = COALESCE(paid_at, now()),
         stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, $2), updated_at = now()
       WHERE id = $1 AND status = 'sent' RETURNING *`,
      [row.id, paymentIntentId ?? null],
    );
    if (updated.rows[0]) {
      await recordAudit(client, row.id, "stripe", "payment_verified", { sessionId: session.id, paymentIntentId });
      await client.query(
        "UPDATE invoice_email_outbox SET status='cancelled', last_error='Invoice is paid', updated_at=now() WHERE invoice_id=$1 AND status IN ('pending','failed')",
        [row.id],
      );
    }
    await client.query("COMMIT");
    return updated.rows[0] ?? (await loadInvoice(row.id))!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Called only after the existing Stripe signature/sync handler has accepted a
// webhook. The event is still treated only as a hint: finality comes from a
// fresh Stripe retrieve plus the immutable local session binding.
export async function handleInvoiceStripeWebhookEvent(event: any): Promise<void> {
  if (!isInvoicePaymentWebhookType(event?.type)) return;
  const stripeObject = event?.data?.object;
  const native = event.type === "invoice.paid" || event.type === "invoice.payment_succeeded";
  const invoiceId = Number(native ? stripeObject?.metadata?.crmInvoiceId : stripeObject?.metadata?.invoiceId);
  if (!Number.isSafeInteger(invoiceId) || invoiceId < 1) return;
  if (!native && stripeObject?.mode !== "payment") return;
  const row = await loadInvoice(invoiceId);
  if (
    !row ||
    row.status !== "sent" ||
    (native ? row.stripe_invoice_id !== stripeObject.id : row.stripe_checkout_session_id !== stripeObject.id)
  ) return;
  if (row.external_payment_pending) return;
  try {
    await reconcileInvoice(row);
  } catch (error) {
    try {
      await recordStripeReconciliationFailure(row, event, error);
    } catch (auditError) {
      logger.error(
        { auditError, invoiceId: row.id, stripeEventId: event?.id },
        "Unable to record Stripe reconciliation failure",
      );
    }
    throw error;
  }
}

async function checkoutForInvoice(row: DbInvoice, successUrl: string, cancelUrl: string) {
  const stripe = await getUncachableStripeClient();
  // Claim creation in the database before calling Stripe. The marker means a
  // concurrent void refuses to race an unpersisted external Checkout Session.
  const client = await pool.connect();
  let claimed: DbInvoice;
  let checkoutIdempotencyKey: string;
  try {
    await client.query("BEGIN");
    claimed = (await client.query("SELECT * FROM invoices WHERE id=$1 FOR UPDATE", [row.id])).rows[0];
    if (!claimed || claimed.status !== "sent") throw new Error("Checkout is available only for sent invoices");
    if (claimed.total_cents < 50) throw new Error("Stripe checkout total must be at least 50 cents");
    if (claimed.stripe_checkout_session_id) {
      await client.query("COMMIT");
      const existing = await stripe.checkout.sessions.retrieve(claimed.stripe_checkout_session_id);
      if (existing.status === "open" || existing.status === "complete") {
        if (existing.status === "complete" && existing.payment_status === "paid") await reconcileInvoice(claimed);
        return existing;
      }
      // An expired session is replaced under a new persisted claim below.
      await client.query("BEGIN");
      claimed = (await client.query("SELECT * FROM invoices WHERE id=$1 FOR UPDATE", [row.id])).rows[0];
      if (!claimed || claimed.status !== "sent") throw new Error("Checkout is available only for sent invoices");
      await client.query(
        "UPDATE invoices SET stripe_checkout_session_id=NULL, checkout_creating=false, stripe_checkout_idempotency_key=NULL, updated_at=now() WHERE id=$1",
        [row.id],
      );
    }
    checkoutIdempotencyKey = claimed.stripe_checkout_idempotency_key || `invoice-checkout-${row.id}-${generatePublicInvoiceToken()}`;
    const claimedResult = await client.query(
      `UPDATE invoices SET checkout_creating=true, stripe_checkout_idempotency_key=$2, updated_at=now()
       WHERE id=$1 AND status='sent' RETURNING *`,
      [row.id, checkoutIdempotencyKey],
    );
    claimed = claimedResult.rows[0];
    if (!claimed) throw new Error("Checkout is available only for sent invoices");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  let productId = claimed.stripe_product_id as string | null;
  if (!productId) {
    const product = await stripe.products.create(
      { name: `Invoice ${claimed.invoice_number}`, metadata: { invoiceId: String(claimed.id), invoiceNumber: claimed.invoice_number } },
      { idempotencyKey: `invoice-product-${claimed.id}` },
    );
    productId = product.id;
    await pool.query("UPDATE invoices SET stripe_product_id = $2, updated_at = now() WHERE id = $1", [claimed.id, productId]);
  }

  let priceId = claimed.stripe_price_id as string | null;
  if (!priceId) {
    const price = await stripe.prices.create(
      { product: productId, currency: "usd", unit_amount: claimed.total_cents },
      { idempotencyKey: `invoice-price-${claimed.id}-${claimed.total_cents}` },
    );
    priceId = price.id;
    await pool.query("UPDATE invoices SET stripe_price_id = $2, updated_at = now() WHERE id = $1", [claimed.id, priceId]);
  }

  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment", line_items: [{ price: priceId, quantity: 1 }], customer_email: claimed.client_email || undefined,
        metadata: { invoiceId: String(claimed.id), invoiceNumber: claimed.invoice_number },
        payment_intent_data: { metadata: { invoiceId: String(claimed.id), invoiceNumber: claimed.invoice_number } },
        success_url: successUrl, cancel_url: cancelUrl,
      }, { idempotencyKey: checkoutIdempotencyKey },
    );
    const finalized = await pool.query(
      `UPDATE invoices SET stripe_checkout_session_id=$3, checkout_creating=false, updated_at=now()
       WHERE id=$1 AND status='sent' AND checkout_creating=true AND stripe_checkout_idempotency_key=$2 RETURNING *`,
      [claimed.id, checkoutIdempotencyKey, session.id],
    );
    if (!finalized.rows[0]) {
      // A void cannot proceed while claimed, but this protects against a
      // future administrative change or crash recovery condition.
      const current = await loadInvoice(claimed.id);
      if (current?.stripe_checkout_session_id === session.id) return session;
      if (session.status === "open") await stripe.checkout.sessions.expire(session.id);
      throw new Error("Checkout creation was superseded; retry the request");
    }
    if (session.status === "complete" && session.payment_status === "paid") await reconcileInvoice(finalized.rows[0]);
    return session;
  } catch (error) {
    await pool.query(
      `UPDATE invoices SET checkout_creating=false, updated_at=now()
       WHERE id=$1 AND status='sent' AND checkout_creating=true AND stripe_checkout_idempotency_key=$2`,
      [claimed.id, checkoutIdempotencyKey],
    );
    throw error;
  }
}

export async function ensureInvoiceSchema(): Promise<void> {
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS invoice_number_seq;
    CREATE TABLE IF NOT EXISTS invoices (
      id serial PRIMARY KEY,
      invoice_number text NOT NULL UNIQUE,
      client_id integer REFERENCES clients(id) ON DELETE RESTRICT,
      contact_id integer NOT NULL REFERENCES crm_contacts(id) ON DELETE RESTRICT,
      job_id integer REFERENCES crm_jobs(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','paid','void')),
      currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
      client_name text NOT NULL,
      client_email text,
      client_address text,
      job_number text,
      due_date date,
      notes text,
      paypal_checkout_url text,
      subtotal_cents integer NOT NULL CHECK (subtotal_cents >= 0),
      tax_rate_bps integer NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
      tax_cents integer NOT NULL CHECK (tax_cents >= 0),
      discount_cents integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
      total_cents integer NOT NULL CHECK (total_cents >= 0 AND total_cents = subtotal_cents + tax_cents - discount_cents),
      public_token_hash text UNIQUE,
      stripe_customer_id text,
      stripe_invoice_id text UNIQUE,
      stripe_hosted_invoice_url text,
      stripe_invoice_pdf_url text,
      stripe_product_id text,
      stripe_price_id text,
      stripe_checkout_session_id text UNIQUE,
      stripe_payment_intent_id text,
      checkout_creating boolean NOT NULL DEFAULT false,
      stripe_checkout_idempotency_key text,
      external_payment_pending boolean NOT NULL DEFAULT false,
      external_payment_provider text,
      external_payment_reference text,
      sent_at timestamptz,
      first_viewed_at timestamptz,
      paid_at timestamptz,
      voided_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS invoice_line_items (
      id serial PRIMARY KEY,
      invoice_id integer NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      position integer NOT NULL CHECK (position >= 0),
      description text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
      quantity integer NOT NULL CHECK (quantity > 0),
      unit_amount_cents integer NOT NULL CHECK (unit_amount_cents >= 0),
      amount_cents integer NOT NULL CHECK (amount_cents = quantity * unit_amount_cents),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (invoice_id, position)
    );
    CREATE TABLE IF NOT EXISTS invoice_payments (
      id serial PRIMARY KEY,
      invoice_id integer NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      provider text NOT NULL CHECK (provider IN ('stripe','manual','paypal')),
      provider_payment_id text NOT NULL,
      amount_cents integer NOT NULL CHECK (amount_cents >= 0),
      currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
      verified boolean NOT NULL DEFAULT false,
      recorded_by text,
      paid_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider, provider_payment_id)
    );
    CREATE INDEX IF NOT EXISTS invoice_payments_invoice_idx ON invoice_payments(invoice_id);
    CREATE TABLE IF NOT EXISTS invoice_audit_records (
      id serial PRIMARY KEY,
      invoice_id integer NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      actor text NOT NULL,
      action text NOT NULL,
      details jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS invoice_audit_records_invoice_idx ON invoice_audit_records(invoice_id);
    CREATE UNIQUE INDEX IF NOT EXISTS invoice_audit_records_stripe_failure_uidx
      ON invoice_audit_records(invoice_id, action)
      WHERE action = 'stripe_reconciliation_failed';
    CREATE UNIQUE INDEX IF NOT EXISTS invoice_audit_records_stripe_document_failure_uidx
      ON invoice_audit_records(invoice_id, action)
      WHERE action = 'stripe_document_failed';
    CREATE TABLE IF NOT EXISTS invoice_email_outbox (
      id bigserial PRIMARY KEY,
      invoice_id integer NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('invoice','resend','reminder')),
      recipient_email text NOT NULL,
      payload jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','accepted','failed','cancelled')),
      scheduled_at timestamptz NOT NULL DEFAULT now(),
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      attempt_count integer NOT NULL DEFAULT 0,
      idempotency_key text NOT NULL UNIQUE,
      accepted_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS invoice_email_outbox_ready_idx
      ON invoice_email_outbox(status, next_attempt_at, scheduled_at);
    CREATE INDEX IF NOT EXISTS invoice_email_outbox_invoice_idx ON invoice_email_outbox(invoice_id, created_at);
    CREATE TABLE IF NOT EXISTS invoice_email_delivery_attempts (
      id bigserial PRIMARY KEY,
      outbox_id bigint NOT NULL REFERENCES invoice_email_outbox(id) ON DELETE CASCADE,
      invoice_id integer NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      attempt_number integer NOT NULL,
      status text NOT NULL CHECK (status IN ('sending','accepted','failed')),
      provider_message_id text,
      error text,
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      UNIQUE(outbox_id, attempt_number)
    );
    CREATE INDEX IF NOT EXISTS invoice_email_attempts_invoice_idx
      ON invoice_email_delivery_attempts(invoice_id, started_at);
    ALTER TABLE invoice_email_outbox ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
    ALTER TABLE invoice_email_delivery_attempts DROP CONSTRAINT IF EXISTS invoice_email_delivery_attempts_status_check;
    ALTER TABLE invoice_email_outbox DROP CONSTRAINT IF EXISTS invoice_email_outbox_status_check;
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='invoice_email_outbox' AND column_name='delivered_at'
      ) THEN
        EXECUTE 'UPDATE invoice_email_outbox SET status=''accepted'', accepted_at=COALESCE(accepted_at, delivered_at) WHERE status=''delivered''';
      END IF;
    END
    $migration$;
    UPDATE invoice_email_delivery_attempts SET status='accepted' WHERE status='delivered';
    ALTER TABLE invoice_email_outbox ADD CONSTRAINT invoice_email_outbox_status_check
      CHECK (status IN ('pending','processing','accepted','failed','cancelled'));
    ALTER TABLE invoice_email_delivery_attempts ADD CONSTRAINT invoice_email_delivery_attempts_status_check
      CHECK (status IN ('sending','accepted','failed'));
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS checkout_creating boolean NOT NULL DEFAULT false;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_checkout_idempotency_key text;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_customer_id text;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_invoice_id text;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_hosted_invoice_url text;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_invoice_pdf_url text;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS external_payment_pending boolean NOT NULL DEFAULT false;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS external_payment_provider text;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS external_payment_reference text;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS first_viewed_at timestamptz;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS branding_snapshot jsonb;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS service_date date;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_revision integer NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS invoice_settings (
      id integer PRIMARY KEY CHECK (id = 1),
      settings jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS invoices_stripe_invoice_uidx ON invoices(stripe_invoice_id);
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS client_id integer REFERENCES clients(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS invoices_client_id_idx ON invoices(client_id);
    UPDATE invoices i SET client_id = c.client_id
      FROM crm_contacts c
      WHERE i.contact_id = c.id AND i.client_id IS NULL AND c.client_id IS NOT NULL;
  `);
}

/**
 * Cancels the Stripe invoice and Checkout Session a sent invoice currently
 * points at, so the customer can't pay the old amount. Returns "paid" without
 * changing anything when Stripe shows either one already paid.
 */
async function releaseStripePaymentLinks(row: DbInvoice): Promise<"released" | "paid"> {
  if (!row.stripe_invoice_id && !row.stripe_checkout_session_id) return "released";
  const stripe = await getUncachableStripeClient();
  // Expiring a Checkout Session is harmless (a new one is made on demand), so
  // it goes first. Voiding the Stripe invoice is irreversible and goes last.
  if (row.stripe_checkout_session_id) {
    const session = await stripe.checkout.sessions.retrieve(row.stripe_checkout_session_id);
    if (session.status === "complete" && session.payment_status === "paid") return "paid";
    if (session.status === "open") {
      try {
        await stripe.checkout.sessions.expire(session.id);
      } catch (error) {
        const latest = await stripe.checkout.sessions.retrieve(session.id);
        if (latest.status === "complete" && latest.payment_status === "paid") return "paid";
        if (latest.status !== "expired") throw error;
      }
    }
  }
  if (row.stripe_invoice_id) {
    const stripeInvoice = await stripe.invoices.retrieve(row.stripe_invoice_id);
    if (stripeInvoice.status === "paid") return "paid";
    if (stripeInvoice.status === "draft") await stripe.invoices.del(stripeInvoice.id);
    else if (stripeInvoice.status === "open") await stripe.invoices.voidInvoice(stripeInvoice.id);
  }
  return "released";
}

/** The original email payload (it holds the customer's link) with the invoice's current amount and due date. */
function currentInvoiceEmailPayload(source: any, row: DbInvoice) {
  return { ...source, totalCents: row.total_cents, dueDate: isoDate(row.due_date), clientName: row.client_name };
}

export function registerInvoiceRoutes(
  app: Express,
  options: { authMiddleware?: RequestHandler } = {},
) {
  app.get("/api/public/invoices/:token", publicInvoiceLimiter, async (req, res) => {
    try {
      if (!isValidPublicInvoiceToken(req.params.token)) {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      let row = await loadInvoiceByToken(req.params.token);
      if (!row || row.status === "draft" || row.status === "void") {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      row = await reconcileInvoice(row);
      const related = await loadLinesAndPayments(row.id);
      res.json(publicInvoice(row, related.lines, related.payments));
    } catch (error: any) {
      logger.error({ error }, "Public invoice lookup failed");
      res.status(500).json({ error: "Unable to load invoice" });
    }
  });

  // The customer page calls this only after its invoice data has rendered.
  // Keeping this separate from GET avoids counting mail-security link scans.
  app.post("/api/public/invoices/:token/view", publicInvoiceLimiter, async (req, res) => {
    try {
      if (!isValidPublicInvoiceToken(req.params.token)) {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      const row = await loadInvoiceByToken(req.params.token);
      if (!row || row.status === "draft" || row.status === "void") {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      const viewed = await pool.query(
        `UPDATE invoices SET first_viewed_at = COALESCE(first_viewed_at, now())
         WHERE id = $1 AND status NOT IN ('draft', 'void')
         RETURNING first_viewed_at`,
        [row.id],
      );
      if (!viewed.rows[0]) {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      res.json({ firstViewedAt: viewed.rows[0].first_viewed_at });
      return;
    } catch {
      // Do not include the private token in request logs or audit details.
      res.status(500).json({ error: "Unable to record invoice view" });
      return;
    }
  });

  app.post("/api/public/invoices/:token/create-stripe-checkout", publicInvoiceLimiter, async (req, res) => {
    try {
      if (!isValidPublicInvoiceToken(req.params.token)) {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      const row = await loadInvoiceByToken(req.params.token);
      if (!row || row.status === "draft" || row.status === "void") {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      if (row.status !== "sent" || row.external_payment_pending) {
        res.status(409).json({ error: "Invoice payment is being reconciled" });
        return;
      }
      const stripeInvoice = await ensureStripeNativeInvoice(row);
      if (!stripeInvoice.hosted_invoice_url) throw new Error("Stripe hosted invoice URL is unavailable");
      res.json({
        url: stripeInvoice.hosted_invoice_url,
        stripeInvoiceId: stripeInvoice.id,
        pdfUrl: stripeInvoice.invoice_pdf,
      });
    } catch (error: any) {
      const status = /only for sent/.test(error.message) ? 409 : 500;
      res.status(status).json({ error: status === 500 ? "Unable to open Stripe invoice" : error.message });
    }
  });

  const admin = [options.authMiddleware ?? requireAuth, requireInvoiceAdmin];

  app.get("/api/invoices/settings", options.authMiddleware ?? requireAuth, async (req, res) => {
    try {
      if (!await canAccessFeature(req, "invoices")) {
        res.status(403).json({ error: "Approved invoice access required" });
        return;
      }
      res.json(await getInvoiceSettings());
      return;
    } catch (error) {
      logger.error({ error }, "Invoice settings lookup failed");
      res.status(500).json({ error: "Unable to load invoice settings" });
      return;
    }
  });

  app.put("/api/invoices/settings", options.authMiddleware ?? requireAuth, async (req, res) => {
    if (!isOwnerIdentity(req) || req.ownerApprovalStatus !== "approved") {
      res.status(403).json({ error: "Active owner access required" });
      return;
    }
    try {
      const settings = validateInvoiceSettings(req.body);
      res.json(await saveInvoiceSettings(settings));
      return;
    } catch (error: any) {
      const message = error instanceof Error ? error.message : "Invalid invoice settings";
      const isValidationError = /must be|required|not allowed|unknown fields/.test(message);
      res.status(isValidationError ? 400 : 500).json({
        error: isValidationError ? message : "Unable to save invoice settings",
      });
      return;
    }
  });

  app.get("/api/invoices", ...admin, async (_req, res) => {
    try {
      const initial = await pool.query("SELECT * FROM invoices ORDER BY created_at DESC LIMIT 250");
      await Promise.all(initial.rows.map((row) => reconcileInvoice(row)));
      const result = await pool.query(
        `SELECT i.*, count(li.id)::integer AS line_item_count,
            (SELECT payload->>'publicUrl' FROM invoice_email_outbox
             WHERE invoice_id=i.id AND kind='invoice' ORDER BY created_at LIMIT 1) AS "publicUrl"
         FROM invoices i LEFT JOIN invoice_line_items li ON li.invoice_id = i.id
         GROUP BY i.id ORDER BY i.created_at DESC LIMIT 250`,
      );
      res.json(result.rows.map(ownerInvoice));
    } catch (error) {
      logger.error({ error }, "Invoice list failed");
      res.status(500).json({ error: "Unable to list invoices" });
    }
  });

  // Everyone who can be billed, in one list: client accounts, the people in the
  // CRM, and whoever currently has work open. Registered before "/:id" so the
  // literal path is not swallowed by the id route.
  app.get("/api/invoices/billing-parties", ...admin, async (_req, res) => {
    try {
      const result = await pool.query(
        `WITH billable_contacts AS (
           SELECT * FROM crm_contacts WHERE tags IS NULL OR tags <> $1
         ),
         invoice_stats AS (
           SELECT contact_id, count(*)::int AS invoice_count, max(created_at) AS last_invoice_at,
                  coalesce(sum(total_cents) FILTER (WHERE status = 'sent'), 0)::int AS open_balance_cents
           FROM invoices GROUP BY contact_id
         ),
         ranked_jobs AS (
           SELECT *, row_number() OVER (PARTITION BY contact_id ORDER BY created_at DESC) AS rank
           FROM crm_jobs
           WHERE contact_id IS NOT NULL AND status <> 'cancelled'
             -- Finished work stays billable until it is on a (non-void) invoice.
             AND (status <> 'completed' OR NOT EXISTS (
               SELECT 1 FROM invoices inv WHERE inv.job_id = crm_jobs.id AND inv.status <> 'void'
             ))
         ),
         open_jobs AS (
           SELECT contact_id, count(*)::int AS open_job_count,
                  coalesce(json_agg(json_build_object(
                    'id', id, 'jobNumber', job_number, 'serviceType', service_type,
                    'description', description, 'estimatedAmountCents', estimated_amount,
                    'status', status, 'completedDate', to_char(completed_date_time, 'YYYY-MM-DD')
                  ) ORDER BY created_at DESC) FILTER (WHERE rank <= 3), '[]'::json) AS jobs
           FROM ranked_jobs GROUP BY contact_id
         ),
         open_requests AS (
           SELECT contact_id, count(*)::int AS open_request_count
           FROM crm_leads
           WHERE contact_id IS NOT NULL AND status IN ('new', 'contacted', 'qualified', 'quoted')
           GROUP BY contact_id
         )
         SELECT 'contact' AS kind, c.id AS contact_id, c.client_id,
                c.full_name AS name, coalesce(a.name, c.company) AS org,
                nullif(btrim(coalesce(c.email, '')), '') AS email,
                coalesce(nullif(btrim(coalesce(c.mobile_phone, '')), ''), c.office_phone) AS phone,
                coalesce(s.invoice_count, 0) AS invoice_count, s.last_invoice_at,
                coalesce(s.open_balance_cents, 0) AS open_balance_cents,
                coalesce(j.open_job_count, 0) AS open_job_count, coalesce(j.jobs, '[]'::json) AS jobs,
                coalesce(r.open_request_count, 0) AS open_request_count
           FROM billable_contacts c
           LEFT JOIN clients a ON a.id = c.client_id
           LEFT JOIN invoice_stats s ON s.contact_id = c.id
           LEFT JOIN open_jobs j ON j.contact_id = c.id
           LEFT JOIN open_requests r ON r.contact_id = c.id
         UNION ALL
         SELECT 'client', NULL::int, a.id, a.name, NULL::text,
                nullif(btrim(coalesce(a.contact_email, '')), ''), a.contact_phone,
                coalesce(t.invoice_count, 0), t.last_invoice_at, coalesce(t.open_balance_cents, 0),
                0, '[]'::json, 0
           FROM clients a
           LEFT JOIN LATERAL (
             SELECT count(*)::int AS invoice_count, max(created_at) AS last_invoice_at,
                    coalesce(sum(total_cents) FILTER (WHERE status = 'sent'), 0)::int AS open_balance_cents
             FROM invoices WHERE client_id = a.id
           ) t ON true
         LIMIT 4000`,
        [PLACEHOLDER_CONTACT_TAG],
      );

      const parties = result.rows.map((row) => ({
        key: `${row.kind}:${row.kind === "contact" ? row.contact_id : row.client_id}`,
        kind: row.kind as "contact" | "client",
        contactId: row.contact_id as number | null,
        clientId: row.client_id as number | null,
        name: row.name as string,
        org: row.org as string | null,
        email: row.email as string | null,
        phone: row.phone as string | null,
        invoiceCount: row.invoice_count as number,
        lastInvoiceAt: row.last_invoice_at as string | null,
        openBalanceCents: row.open_balance_cents as number,
        openJobCount: row.open_job_count as number,
        openRequestCount: row.open_request_count as number,
        openJobs: (row.jobs ?? []) as { id: number; jobNumber: string; serviceType: string; description: string | null; estimatedAmountCents: number | null; status: string; completedDate: string | null }[],
      }));

      // Whoever has work open comes first, then whoever we billed most
      // recently: the two reasons someone opens this dropdown at all.
      parties.sort((left, right) => {
        const waiting = (party: typeof left) => (party.openJobCount + party.openRequestCount > 0 ? 1 : 0);
        if (waiting(left) !== waiting(right)) return waiting(right) - waiting(left);
        const seen = (party: typeof left) => (party.lastInvoiceAt ? Date.parse(party.lastInvoiceAt) : 0);
        if (seen(left) !== seen(right)) return seen(right) - seen(left);
        return left.name.localeCompare(right.name);
      });
      res.json(parties);
    } catch (error) {
      logger.error({ error }, "Billing party lookup failed");
      res.status(500).json({ error: "Unable to load customers" });
    }
  });

  // The work this shop actually bills for, ranked by how often it has been
  // invoiced, so a common job is one click rather than retyped.
  app.get("/api/invoices/service-presets", ...admin, async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT mode() WITHIN GROUP (ORDER BY description) AS description,
                count(*)::int AS uses,
                (percentile_disc(0.5) WITHIN GROUP (ORDER BY unit_amount_cents))::int AS unit_amount_cents
           FROM invoice_line_items
          GROUP BY lower(btrim(description))
          ORDER BY count(*) DESC, max(created_at) DESC
          LIMIT 12`,
      );
      res.json(result.rows.map((row) => ({
        description: row.description as string,
        unitAmountCents: row.unit_amount_cents as number,
        uses: row.uses as number,
      })));
    } catch (error) {
      logger.error({ error }, "Service preset lookup failed");
      res.status(500).json({ error: "Unable to load service presets" });
    }
  });

  app.get("/api/invoices/:id", ...admin, async (req, res) => {
    try {
      let row = await loadInvoice(idParam(req.params.id));
      if (!row) {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      row = await reconcileInvoice(row);
      const [related, audit, emails, attempts] = await Promise.all([
        loadLinesAndPayments(row.id),
        pool.query("SELECT * FROM invoice_audit_records WHERE invoice_id = $1 ORDER BY created_at, id", [row.id]),
        pool.query(`SELECT id,kind,recipient_email,status,payload->>'publicUrl' AS "publicUrl",
          scheduled_at,attempt_count,accepted_at,last_error,created_at
          FROM invoice_email_outbox WHERE invoice_id=$1 ORDER BY created_at DESC,id DESC`, [row.id]),
        pool.query("SELECT id,outbox_id,attempt_number,status,provider_message_id,error,started_at,completed_at FROM invoice_email_delivery_attempts WHERE invoice_id=$1 ORDER BY started_at DESC,id DESC LIMIT 100", [row.id]),
      ]);
      res.json({
        ...ownerInvoice(row),
        publicUrl: emails.rows.find((email) => email.kind === "invoice")?.publicUrl ?? null,
        lineItems: related.lines,
        payments: related.payments,
        audit: audit.rows,
        stripeDocumentIncidents: stripeDocumentIncidents(audit.rows),
        emailDeliveries: emails.rows,
        emailAttempts: attempts.rows,
      });
    } catch (error: any) {
      res.status(error.message === "Invalid invoice id" ? 400 : 500).json({ error: error.message || "Unable to load invoice" });
    }
  });

  app.post("/api/invoices", ...admin, async (req, res): Promise<void> => {
    const client = await pool.connect();
    try {
      const settings = await getInvoiceSettings();
      const body = applyInvoiceDefaultsToOmittedFields(
        req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {},
        settings,
      );
      const origin = invoiceOriginSchema.safeParse(body);
      if (!origin.success) {
        res.status(400).json({ error: origin.error.issues[0]?.message || "Invalid invoice origin" });
        return;
      }
      const input = invoicePayload(body);
      await client.query("BEGIN");
      const correctionOfInvoiceId = origin.data.correctionOfInvoiceId;
      let linkedInquiryId = origin.data.originInquiryId;
      let inquiry: DbInvoice | undefined;
      if (linkedInquiryId) {
        inquiry = (
          await client.query("SELECT id, crm_contact_id, invoice_id FROM catalog_inquiries WHERE id=$1 FOR UPDATE", [linkedInquiryId])
        ).rows[0];
        if (!inquiry) {
          await client.query("ROLLBACK");
          res.status(404).json({ error: "Catalog inquiry not found" });
          return;
        }
      } else if (correctionOfInvoiceId !== undefined) {
        const linked = await client.query(
          `SELECT id, crm_contact_id, invoice_id
             FROM catalog_inquiries
            WHERE invoice_id=$1
               OR id::text IN (
                    SELECT details->>'originInquiryId'
                      FROM invoice_audit_records
                     WHERE invoice_id=$1
                       AND action='created'
                       AND details->>'originInquiryId' IS NOT NULL
                  )
            ORDER BY created_at DESC, id
            LIMIT 2
            FOR UPDATE`,
          [correctionOfInvoiceId],
        );
        if (linked.rows.length !== 1) {
          await client.query("ROLLBACK");
          res.status(409).json({
            error: "Correction target is not the current invoice for one catalog inquiry",
            invoiceId: linked.rows.length ? correctionOfInvoiceId : null,
          });
          return;
        }
        inquiry = linked.rows[0];
        linkedInquiryId = linked.rows[0].id;
      }

      if (inquiry) {
        const currentInvoiceId = inquiry.invoice_id == null ? null : Number(inquiry.invoice_id);
        if (
          (currentInvoiceId !== null && correctionOfInvoiceId !== currentInvoiceId) ||
          (correctionOfInvoiceId !== undefined && correctionOfInvoiceId !== currentInvoiceId)
        ) {
          await client.query("ROLLBACK");
          res.status(409).json({
            error: currentInvoiceId === null
              ? "The catalog inquiry has no current invoice to correct"
              : correctionOfInvoiceId === undefined
                ? "The catalog inquiry is already linked to an invoice"
                : "The catalog inquiry is linked to a different invoice",
            invoiceId: currentInvoiceId,
          });
          return;
        }
        if (inquiry.crm_contact_id == null) {
          await client.query("ROLLBACK");
          res.status(409).json({ error: "Catalog inquiry must be linked to a CRM contact before invoicing" });
          return;
        }
      }

      const { contact, account, job, address, createdContact, createdAccount } = await resolveInvoiceParty(client, input);
      if (inquiry && Number(contact.id) !== Number(inquiry.crm_contact_id)) {
        throw new Error("Invoice recipient must match the CRM contact linked to this catalog inquiry");
      }
      const inserted = await client.query(
        `INSERT INTO invoices (
            invoice_number, client_id, contact_id, job_id, client_name, client_email, client_address, job_number,
           due_date, notes, paypal_checkout_url, subtotal_cents, tax_rate_bps, tax_cents, discount_cents, total_cents,
           service_date
         ) VALUES (
           'INV-' || to_char(CURRENT_DATE, 'YYYY') || '-' || lpad(nextval('invoice_number_seq')::text, 6, '0'),
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
         ) RETURNING *`,
         [account.id, contact.id, input.jobId, account.name, contact.email, address, job?.job_number ?? null,
          input.dueDate, input.notes, input.paypalCheckoutUrl, input.totals.subtotalCents, input.totals.taxRateBps,
          input.totals.taxCents, input.totals.discountCents, input.totals.totalCents,
          input.serviceDate === undefined ? jobServiceDate(job) : input.serviceDate],
      );
      const invoice = inserted.rows[0];
      for (let position = 0; position < input.totals.lines.length; position++) {
        const line = input.totals.lines[position];
        await client.query(
          `INSERT INTO invoice_line_items (invoice_id, position, description, quantity, unit_amount_cents, amount_cents)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [invoice.id, position, line.description, line.quantity, line.unitAmountCents, line.amountCents],
        );
      }
      await recordAudit(client, invoice.id, actor(req), "created", {
        recipientKind: input.recipient.kind,
        contactId: contact.id,
        clientId: account.id,
        createdContact,
        createdAccount,
        ...(linkedInquiryId ? { originInquiryId: linkedInquiryId } : {}),
        ...(correctionOfInvoiceId !== undefined ? { correctionOfInvoiceId } : {}),
      });
      if (inquiry && linkedInquiryId) {
        const linked = await client.query(
          "UPDATE catalog_inquiries SET invoice_id=$2 WHERE id=$1",
          [linkedInquiryId, invoice.id],
        );
        if (linked.rowCount !== 1) throw new Error("Catalog inquiry could not be linked to the invoice");
      }
      await client.query("COMMIT");
      res.status(201).json({ ...ownerInvoice(invoice), lineItems: input.totals.lines, createdContact, createdAccount });
    } catch (error: any) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: error.message || "Unable to create invoice" });
    } finally {
      client.release();
    }
  });

  app.put("/api/invoices/:id", ...admin, async (req, res) => {
    const client = await pool.connect();
    // Set once the old Stripe invoice/checkout has been cancelled, so a failed
    // commit can still detach the now-unusable Stripe references.
    let releasedStripe: { id: number; stripeInvoiceId: string | null; checkoutSessionId: string | null } | null = null;
    try {
      const id = idParam(req.params.id);
      await client.query("BEGIN");
      const existing = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!existing) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Invoice not found" });
        return;
      }

      // A paid invoice's amounts are settled; only record-keeping details change.
      if (existing.status === "paid") {
        const nextServiceDate = serviceDate(req.body?.serviceDate);
        const nextNotes = req.body?.notes === undefined ? existing.notes : optionalText(req.body?.notes, "notes", 10000);
        const result = await client.query(
          "UPDATE invoices SET service_date=$2, notes=$3, updated_at=now() WHERE id=$1 RETURNING *",
          [id, nextServiceDate === undefined ? existing.service_date : nextServiceDate, nextNotes],
        );
        await recordAudit(client, id, actor(req), "paid_details_updated", {
          serviceDate: { from: isoDate(existing.service_date), to: isoDate(result.rows[0].service_date) },
          notesChanged: (existing.notes ?? null) !== (nextNotes ?? null),
        });
        await client.query("COMMIT");
        const related = await loadLinesAndPayments(id);
        res.json({ ...ownerInvoice(result.rows[0]), lineItems: related.lines });
        return;
      }
      if (existing.status !== "draft" && existing.status !== "sent") {
        throw new Error("Void invoices cannot be edited");
      }

      const input = invoicePayload(req.body);
      const { contact, account, job, address } = await resolveInvoiceParty(client, input);
      const nextServiceDate = input.serviceDate === undefined
        ? (existing.service_date ?? jobServiceDate(job))
        : input.serviceDate;

      let resetStripe = false;
      if (existing.status === "sent") {
        if (existing.external_payment_pending) {
          throw new Error("External payment reconciliation is pending. Resolve it before editing this invoice.");
        }
        if (existing.checkout_creating) {
          throw new Error("Checkout creation is in progress; retry the edit after it completes");
        }
        const payments = await client.query("SELECT 1 FROM invoice_payments WHERE invoice_id=$1 LIMIT 1", [id]);
        if (payments.rows.length) throw new Error("This invoice already has a recorded payment and cannot be edited");

        const oldLines = (await client.query(
          "SELECT description, quantity, unit_amount_cents FROM invoice_line_items WHERE invoice_id=$1 ORDER BY position",
          [id],
        )).rows;
        resetStripe = sentInvoiceBillingChanged(existing, oldLines, input, contact.id, account.id);
        if (resetStripe) {
          const outcome = await releaseStripePaymentLinks(existing);
          if (outcome === "paid") {
            await client.query("ROLLBACK");
            await reconcileInvoice(existing);
            res.status(409).json({ error: "The customer paid this invoice while it was being edited, so it can no longer be changed" });
            return;
          }
          releasedStripe = {
            id,
            stripeInvoiceId: existing.stripe_invoice_id ?? null,
            checkoutSessionId: existing.stripe_checkout_session_id ?? null,
          };
        }
      }

      const result = await client.query(
         `UPDATE invoices SET client_id=$2, contact_id=$3, job_id=$4, client_name=$5, client_email=$6, client_address=$7,
            job_number=$8, due_date=$9, notes=$10, paypal_checkout_url=$11, subtotal_cents=$12,
            tax_rate_bps=$13, tax_cents=$14, discount_cents=$15, total_cents=$16,
            service_date=$17,
            stripe_customer_id = CASE WHEN client_id IS DISTINCT FROM $2 OR contact_id IS DISTINCT FROM $3
                                      THEN NULL ELSE stripe_customer_id END,
            stripe_revision = stripe_revision + CASE WHEN $18 THEN 1 ELSE 0 END,
            stripe_invoice_id = CASE WHEN $18 THEN NULL ELSE stripe_invoice_id END,
            stripe_hosted_invoice_url = CASE WHEN $18 THEN NULL ELSE stripe_hosted_invoice_url END,
            stripe_invoice_pdf_url = CASE WHEN $18 THEN NULL ELSE stripe_invoice_pdf_url END,
            stripe_checkout_session_id = CASE WHEN $18 THEN NULL ELSE stripe_checkout_session_id END,
            stripe_checkout_idempotency_key = CASE WHEN $18 THEN NULL ELSE stripe_checkout_idempotency_key END,
            stripe_price_id = CASE WHEN $18 THEN NULL ELSE stripe_price_id END,
            updated_at=now()
         WHERE id=$1 RETURNING *`,
         [id, account.id, contact.id, input.jobId, account.name, contact.email, address, job?.job_number ?? null,
          input.dueDate, input.notes, input.paypalCheckoutUrl, input.totals.subtotalCents, input.totals.taxRateBps,
          input.totals.taxCents, input.totals.discountCents, input.totals.totalCents, nextServiceDate, resetStripe],
      );
      await client.query("DELETE FROM invoice_line_items WHERE invoice_id = $1", [id]);
      for (let position = 0; position < input.totals.lines.length; position++) {
        const line = input.totals.lines[position];
        await client.query(
          "INSERT INTO invoice_line_items (invoice_id,position,description,quantity,unit_amount_cents,amount_cents) VALUES ($1,$2,$3,$4,$5,$6)",
          [id, position, line.description, line.quantity, line.unitAmountCents, line.amountCents],
        );
      }
      const updated = result.rows[0];

      let emailDelivery: DbInvoice | null = null;
      if (existing.status === "sent") {
        // Queued reminders must quote the new amount and go to the current recipient.
        if (updated.client_email) {
          await client.query(
            `UPDATE invoice_email_outbox
                SET payload = payload || jsonb_build_object('totalCents', $2::int, 'dueDate', $3::text, 'clientName', $4::text),
                    recipient_email = $5, updated_at = now()
              WHERE invoice_id = $1 AND status IN ('pending','failed')`,
            [id, updated.total_cents, isoDate(updated.due_date), updated.client_name, updated.client_email],
          );
        } else {
          await client.query(
            "UPDATE invoice_email_outbox SET status='cancelled', last_error='Invoice recipient has no email address', updated_at=now() WHERE invoice_id=$1 AND status IN ('pending','failed')",
            [id],
          );
        }
        await recordAudit(client, id, actor(req), "sent_invoice_revised", {
          totalCents: { from: existing.total_cents, to: updated.total_cents },
          taxRateBps: { from: existing.tax_rate_bps, to: updated.tax_rate_bps },
          discountCents: { from: existing.discount_cents, to: updated.discount_cents },
          serviceDate: { from: isoDate(existing.service_date), to: isoDate(updated.service_date) },
          stripeReplaced: resetStripe,
        });
        if (req.body?.notifyCustomer === true) {
          if (!updated.client_email) throw new Error("Selected CRM contact does not have an email address");
          const source = (await client.query(
            "SELECT payload FROM invoice_email_outbox WHERE invoice_id=$1 ORDER BY created_at LIMIT 1",
            [id],
          )).rows[0];
          if (!source) throw new Error("Invoice email link is unavailable");
          emailDelivery = await enqueueInvoiceEmail(client, {
            invoiceId: id,
            kind: "resend",
            recipientEmail: updated.client_email,
            payload: currentInvoiceEmailPayload(source.payload, updated),
            idempotencyKey: `invoice:${id}:revised:${new Date(updated.updated_at).getTime()}`,
          });
        }
      } else {
        await recordAudit(client, id, actor(req), "draft_updated");
      }
      await client.query("COMMIT");
      releasedStripe = null;

      let final = updated;
      let stripeWarning: string | null = null;
      if (resetStripe) {
        try {
          await ensureStripeNativeInvoice(updated);
          final = (await loadInvoice(id)) ?? updated;
        } catch (error: any) {
          stripeWarning = "Saved, but the Stripe payment page could not be rebuilt yet. Customers can still pay by card from the invoice link; use Resend to retry.";
          logger.error({ error, invoiceId: id }, "Unable to rebuild Stripe invoice after edit");
        }
      }
      if (emailDelivery) {
        void processInvoiceEmailOutbox().catch((error) => logger.error({ error, invoiceId: id }, "Revised invoice email processing failed"));
      }
      res.json({ ...ownerInvoice(final), lineItems: input.totals.lines, emailDelivery, stripeWarning });
    } catch (error: any) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (releasedStripe) {
        // Stripe objects were already cancelled; stop pointing at them so the
        // next send/resend builds fresh ones instead of reusing void links.
        await pool.query(
          `UPDATE invoices SET stripe_invoice_id=NULL, stripe_hosted_invoice_url=NULL, stripe_invoice_pdf_url=NULL,
             stripe_checkout_session_id=NULL, stripe_checkout_idempotency_key=NULL, stripe_price_id=NULL,
             stripe_revision=stripe_revision+1, updated_at=now()
           WHERE id=$1 AND stripe_invoice_id IS NOT DISTINCT FROM $2 AND stripe_checkout_session_id IS NOT DISTINCT FROM $3`,
          [releasedStripe.id, releasedStripe.stripeInvoiceId, releasedStripe.checkoutSessionId],
        ).catch((detachError) => logger.error({ detachError, invoiceId: releasedStripe?.id }, "Unable to detach cancelled Stripe invoice"));
      }
      const status = /cannot be edited|can no longer|in progress|reconciliation is pending|recorded payment/.test(error.message) ? 409 : 400;
      res.status(status).json({ error: error.message || "Unable to update invoice" });
    } finally {
      client.release();
    }
  });

  app.delete("/api/invoices/:id", ...admin, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [idParam(req.params.id)])).rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      assertDraftMutable(row.status);
      await client.query("DELETE FROM invoices WHERE id = $1", [row.id]);
      await client.query("COMMIT");
      res.status(204).send();
    } catch (error: any) {
      await client.query("ROLLBACK");
      res.status(/Only draft/.test(error.message) ? 409 : 400).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  app.post("/api/invoices/:id/send", ...admin, async (req, res) => {
    let id: number;
    let publicBaseUrl: string;
    let stripeInvoice: Awaited<ReturnType<typeof ensureStripeNativeInvoice>>;
    let candidate: DbInvoice | undefined;
    let branding: InvoiceSettings = { ...DEFAULT_INVOICE_SETTINGS };
    try {
      id = idParam(req.params.id);
      publicBaseUrl = baseUrl();
      branding = await getInvoiceSettings();
      candidate = await loadInvoice(id);
      if (!candidate) {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      if (!candidate.client_email) throw new Error("Selected CRM contact does not have an email address");
      assertInvoiceStatusTransition(candidate.status as InvoiceStatus, "sent");
      stripeInvoice = await ensureStripeNativeInvoice(candidate, branding);
      await verifyStripeInvoiceDocuments({
        crmInvoiceId: candidate.id,
        stripeInvoiceId: stripeInvoice.id,
        hostedInvoiceUrl: stripeInvoice.hosted_invoice_url ?? null,
        invoicePdfUrl: stripeInvoice.invoice_pdf ?? null,
      });
    } catch (error: any) {
      if (error instanceof StripeDocumentVerificationError) {
        try {
          await recordStripeDocumentFailure(error);
        } catch (auditError) {
          logger.error({ auditError, invoiceId: candidate?.id }, "Failed to record Stripe document incident");
        }
      }
      const status = /cannot transition/.test(error.message) ? 409 : 400;
      const message = String(error.message || "Unable to create Stripe invoice")
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted URL]")
        .slice(0, 500);
      res.status(status).json({ error: message });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      if (!row.client_email) throw new Error("Selected CRM contact does not have an email address");
      assertInvoiceStatusTransition(row.status as InvoiceStatus, "sent");
      const token = generatePublicInvoiceToken();
      const hash = hashPublicInvoiceToken(token);
      const updated = (await client.query(
        `UPDATE invoices SET status='sent', public_token_hash=$2, branding_snapshot=$3::jsonb, sent_at=now(), updated_at=now()
         WHERE id=$1 AND public_token_hash IS NULL RETURNING *`,
        [row.id, hash, JSON.stringify(invoiceBrandingSnapshot(branding))],
      )).rows[0];
      if (!updated) throw new Error("Invoice public token already exists");
      const publicUrl = `${publicBaseUrl}/invoice/${encodeURIComponent(token)}`;
      const outbox = await enqueueInvoiceEmail(client, {
        invoiceId: row.id,
        kind: "invoice",
        recipientEmail: row.client_email,
        payload: { publicUrl, invoiceNumber: row.invoice_number, clientName: row.client_name, totalCents: row.total_cents, dueDate: row.due_date },
        idempotencyKey: `invoice:${row.id}:initial`,
      });
      await resolveStripeDocumentFailure(client, row.id);
      await recordAudit(client, row.id, actor(req), "sent", { emailOutboxId: outbox.id });
      await client.query("COMMIT");
      void processInvoiceEmailOutbox().catch((error) => logger.error({ error, invoiceId: row.id }, "Immediate invoice email processing failed"));
      let final = updated;
      if (stripeInvoice.status === "paid") final = await reconcileInvoice(updated);
      res.json({
        ...ownerInvoice(final),
        publicUrl,
        stripeHostedInvoiceUrl: stripeInvoice.hosted_invoice_url,
        stripeInvoicePdfUrl: stripeInvoice.invoice_pdf,
        emailDelivery: outbox,
      });
    } catch (error: any) {
      await client.query("ROLLBACK");
      res.status(/cannot transition|already exists/.test(error.message) ? 409 : 400).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  app.post("/api/invoices/:id/resend-email", ...admin, async (req, res) => {
    let id: number;
    let candidate: DbInvoice | undefined;
    try {
      id = idParam(req.params.id);
      candidate = await loadInvoice(id);
      if (!candidate) {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      if (candidate.status !== "sent") throw new Error("Only unpaid sent invoices can be emailed");
      if (!candidate.client_email) throw new Error("Selected CRM contact does not have an email address");
      if (!candidate.stripe_invoice_id && !candidate.external_payment_pending) {
        // An edit replaced the Stripe invoice but couldn't build the new one; do it now.
        await ensureStripeNativeInvoice(candidate);
        candidate = (await loadInvoice(id)) ?? candidate;
      }
      await verifyCurrentStripeInvoiceDocuments(candidate);
    } catch (error: any) {
      if (error instanceof StripeDocumentVerificationError) {
        try {
          await recordStripeDocumentFailure(error);
        } catch (auditError) {
          logger.error({ auditError, invoiceId: candidate?.id }, "Failed to record Stripe document incident");
        }
      }
      res.status(/Only unpaid|unavailable/.test(error.message) ? 409 : 400).json({ error: error.message });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query("SELECT * FROM invoices WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!row) { await client.query("ROLLBACK"); res.status(404).json({ error: "Invoice not found" }); return; }
      if (row.status !== "sent") throw new Error("Only unpaid sent invoices can be emailed");
      if (!row.client_email) throw new Error("Selected CRM contact does not have an email address");
      const requestKey = typeof req.body?.requestKey === "string" && /^[A-Za-z0-9_-]{16,100}$/.test(req.body.requestKey)
        ? req.body.requestKey
        : null;
      if (!requestKey) throw new Error("A valid resend request key is required");
      const source = (await client.query("SELECT payload FROM invoice_email_outbox WHERE invoice_id=$1 ORDER BY created_at LIMIT 1", [row.id])).rows[0];
      if (!source) throw new Error("Invoice email link is unavailable");
      const outbox = await enqueueInvoiceEmail(client, { invoiceId: row.id, kind: "resend", recipientEmail: row.client_email, payload: currentInvoiceEmailPayload(source.payload, row), idempotencyKey: `invoice:${row.id}:resend:${requestKey}` });
      await resolveStripeDocumentFailure(client, row.id);
      await recordAudit(client, row.id, actor(req), "email_resent", { emailOutboxId: outbox.id });
      await client.query("COMMIT");
      void processInvoiceEmailOutbox().catch((error) => logger.error({ error, invoiceId: row.id }, "Immediate invoice resend processing failed"));
      res.status(202).json(outbox);
    } catch (error: any) {
      await client.query("ROLLBACK");
      res.status(/Only unpaid|unavailable/.test(error.message) ? 409 : 400).json({ error: error.message });
    } finally { client.release(); }
  });

  app.post("/api/invoices/:id/reminders", ...admin, async (req, res) => {
    const days: number[] = Array.isArray(req.body?.daysAfterDue) ? [...new Set<number>(req.body.daysAfterDue.map(Number))] : [];
    if (!days.length || days.length > 12 || days.some((day) => !Number.isInteger(day) || day < 1 || day > 365)) {
      res.status(400).json({ error: "daysAfterDue must contain 1 to 12 unique whole days between 1 and 365" });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query("SELECT * FROM invoices WHERE id=$1 FOR UPDATE", [idParam(req.params.id)])).rows[0];
      if (!row) { await client.query("ROLLBACK"); res.status(404).json({ error: "Invoice not found" }); return; }
      if (row.status !== "sent" || !row.due_date) throw new Error("A sent invoice with a due date is required");
      if (!row.client_email) throw new Error("Selected CRM contact does not have an email address");
      const source = (await client.query("SELECT payload FROM invoice_email_outbox WHERE invoice_id=$1 ORDER BY created_at LIMIT 1", [row.id])).rows[0];
      if (!source) throw new Error("Invoice email link is unavailable");
      const scheduled = [];
      for (const day of days as number[]) {
        const scheduledAt = reminderScheduledAt(String(row.due_date), day);
        scheduled.push(await enqueueInvoiceEmail(client, {
          invoiceId: row.id, kind: "reminder", recipientEmail: row.client_email, payload: currentInvoiceEmailPayload(source.payload, row),
          scheduledAt, idempotencyKey: `invoice:${row.id}:reminder:${day}`,
        }));
      }
      await recordAudit(client, row.id, actor(req), "reminders_scheduled", { daysAfterDue: days });
      await client.query("COMMIT");
      res.status(201).json(scheduled);
    } catch (error: any) {
      await client.query("ROLLBACK");
      res.status(/required|unavailable/.test(error.message) ? 409 : 400).json({ error: error.message });
    } finally { client.release(); }
  });

  app.post("/api/invoices/:id/email-deliveries/:deliveryId/retry", ...admin, async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE invoice_email_outbox SET status='pending', attempt_count=0, next_attempt_at=now(), last_error=NULL, updated_at=now()
         WHERE id=$1 AND invoice_id=$2 AND status='failed' RETURNING *`,
        [idParam(req.params.deliveryId), idParam(req.params.id)],
      );
      if (!result.rows[0]) {
        res.status(409).json({ error: "Only retryable failed deliveries can be retried" });
        return;
      }
      void processInvoiceEmailOutbox().catch((error) => logger.error({ error }, "Manual invoice email retry failed"));
      res.status(202).json(result.rows[0]);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/invoices/:id/void", ...admin, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = idParam(req.params.id);
      await client.query("BEGIN");
      const row = (await client.query("SELECT * FROM invoices WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      assertNoPendingExternalPayment(row);
      if (row.checkout_creating) throw new Error("Checkout creation is in progress; retry void after it completes");
      if (row.stripe_invoice_id) {
        const stripe = await getUncachableStripeClient();
        let stripeInvoice = await stripe.invoices.retrieve(row.stripe_invoice_id);
        if (stripeInvoice.status === "paid") {
          await client.query("ROLLBACK");
          await reconcileInvoice(row);
          res.status(409).json({ error: "Invoice was paid and cannot be voided" });
          return;
        }
        if (stripeInvoice.status === "draft") {
          await stripe.invoices.del(stripeInvoice.id);
        } else if (stripeInvoice.status === "open") {
          stripeInvoice = await stripe.invoices.voidInvoice(stripeInvoice.id);
        }
      }
      if (row.status === "sent" && row.stripe_checkout_session_id) {
        const stripe = await getUncachableStripeClient();
        let session = await stripe.checkout.sessions.retrieve(row.stripe_checkout_session_id);
        if (session.status === "open") session = await stripe.checkout.sessions.expire(session.id);
        if (session.status === "complete" && session.payment_status === "paid") {
          await client.query("ROLLBACK");
          await reconcileInvoice(row);
          res.status(409).json({ error: "Invoice was paid and cannot be voided" });
          return;
        }
      }
      assertInvoiceStatusTransition(row.status as InvoiceStatus, "void");
      const updated = (await client.query("UPDATE invoices SET status='void', voided_at=now(), updated_at=now() WHERE id=$1 RETURNING *", [row.id])).rows[0];
      await client.query(
        "UPDATE invoice_email_outbox SET status='cancelled', last_error='Invoice is void', updated_at=now() WHERE invoice_id=$1 AND status IN ('pending','failed')",
        [row.id],
      );
      await recordAudit(client, row.id, actor(req), "voided");
      await client.query("COMMIT");
      res.json(ownerInvoice(updated));
    } catch (error: any) {
      await client.query("ROLLBACK");
      res.status(/cannot transition|in progress|reconciliation is pending/.test(error.message) ? 409 : 400).json({ error: error.message });
    } finally {
      client.release();
    }
  });

  app.post("/api/invoices/:id/manual-mark-paid", ...admin, async (req, res) => {
    const client = await pool.connect();
    try {
      const provider = req.body?.provider === "paypal" ? "paypal" : req.body?.provider === "manual" ? "manual" : null;
      const reference = optionalText(req.body?.reference, "reference", 500);
      if (!provider || !reference) throw new Error("provider (manual or paypal) and reference are required");
      await client.query("BEGIN");
      const row = (await client.query("SELECT * FROM invoices WHERE id=$1 FOR UPDATE", [idParam(req.params.id)])).rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      assertInvoiceStatusTransition(row.status as InvoiceStatus, "paid");
      if (row.external_payment_pending && (row.external_payment_provider !== provider || row.external_payment_reference !== reference)) {
        throw new Error("A different external payment is being reconciled. Retry with the original provider and reference.");
      }
      if (row.checkout_creating) throw new Error("Stripe Checkout creation is in progress. Retry shortly.");
      if (!row.external_payment_pending) {
        await client.query(
          "UPDATE invoices SET external_payment_pending=true, external_payment_provider=$2, external_payment_reference=$3, updated_at=now() WHERE id=$1",
          [row.id, provider, reference],
        );
      }
      await client.query("COMMIT");
      // The claim is durable before the remote call. Other reconciliations
      // cannot turn an ambiguous out-of-band payment into a Stripe receipt.
      await client.query("BEGIN");
      const current = (await client.query("SELECT * FROM invoices WHERE id=$1 FOR UPDATE", [row.id])).rows[0];
      if (current.status !== "sent" || !current.external_payment_pending ||
          current.external_payment_provider !== provider || current.external_payment_reference !== reference) {
        throw new Error("Invoice payment changed. Refresh the invoice before retrying.");
      }
      const stripe = await getUncachableStripeClient();
      if (current.stripe_checkout_session_id) {
        let session = await stripe.checkout.sessions.retrieve(current.stripe_checkout_session_id);
        if (session.status === "complete") throw new Error("Stripe Checkout has completed or a payment may still be processing. Review before recording an external payment.");
        if (session.status === "open") session = await stripe.checkout.sessions.expire(session.id);
        if (session.status !== "expired") {
          throw new Error("Stripe Checkout could not be closed. Retry reconciliation before marking paid.");
        }
      }
      if (!current.stripe_invoice_id && !current.stripe_checkout_session_id) {
        throw new Error("Stripe payment binding is missing. Review before recording external payment.");
      }
      if (current.stripe_invoice_id) {
        try {
          await closeStripeForExternalPayment(stripe, current.stripe_invoice_id, row.id, provider, reference, !!row.external_payment_pending);
        } catch (error) {
          if (!row.external_payment_pending && error instanceof Error && error.message === "Stripe invoice was already paid") {
            await client.query("UPDATE invoices SET external_payment_pending=false, external_payment_provider=NULL, external_payment_reference=NULL WHERE id=$1", [row.id]);
            await client.query("COMMIT");
            await reconcileInvoice((await loadInvoice(row.id))!);
            res.status(409).json({ error: "Stripe already shows this invoice paid. CSD did not record the external payment. Review both payments before taking further action." });
            return;
          }
          throw error;
        }
      }
      await client.query(
        `INSERT INTO invoice_payments
           (invoice_id,provider,provider_payment_id,amount_cents,currency,verified,recorded_by)
         VALUES ($1,$2,$3,$4,'USD',true,$5)`,
        [row.id, provider, reference, row.total_cents, actor(req)],
      );
      const updated = (await client.query("UPDATE invoices SET status='paid', paid_at=now(), external_payment_pending=false, external_payment_provider=NULL, external_payment_reference=NULL, updated_at=now() WHERE id=$1 RETURNING *", [row.id])).rows[0];
      await client.query(
        "UPDATE invoice_email_outbox SET status='cancelled', last_error='Invoice is paid', updated_at=now() WHERE invoice_id=$1 AND status IN ('pending','failed')",
        [row.id],
      );
      await recordAudit(client, row.id, actor(req), "manually_marked_paid", { provider, reference });
      await client.query("COMMIT");
      res.json(ownerInvoice(updated));
    } catch (error: any) {
      await client.query("ROLLBACK");
      req.log.warn({ invoiceId: req.params.id }, "External invoice payment reconciliation did not complete");
      res.status(409).json({ error: "CSD has not marked this invoice paid. Check Stripe for a customer payment and confirm the external payment, then retry using the same provider and reference. If Stripe already shows paid or the retry remains blocked, review the payment with support before recording anything else." });
    } finally {
      client.release();
    }
  });

  app.post("/api/invoices/:id/create-stripe-checkout", ...admin, async (req, res) => {
    try {
      const row = await loadInvoice(idParam(req.params.id));
      if (!row) {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }
      if (row.status !== "sent" || row.external_payment_pending) {
        res.status(409).json({ error: "Stripe invoice is unavailable while payment is being reconciled" });
        return;
      }
      const stripeInvoice = await ensureStripeNativeInvoice(row);
      if (!stripeInvoice.hosted_invoice_url) throw new Error("Stripe hosted invoice URL is unavailable");
      res.json({
        url: stripeInvoice.hosted_invoice_url,
        stripeInvoiceId: stripeInvoice.id,
        pdfUrl: stripeInvoice.invoice_pdf,
      });
    } catch (error: any) {
      const status = /only for sent/.test(error.message) ? 409 : /Invalid invoice/.test(error.message) ? 400 : 500;
      res.status(status).json({ error: status === 500 ? "Unable to open Stripe invoice" : error.message });
    }
  });
}