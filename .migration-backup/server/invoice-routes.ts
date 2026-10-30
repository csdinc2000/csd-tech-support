import type { Express, NextFunction, Request, Response } from "express";
import { pool } from "./db";
import { getUncachableStripeClient } from "./stripeClient";
import { isAuthenticated } from "./replit_integrations/auth";
import { isAdminUser, rateLimit } from "./security";
import {
  assertDraftMutable,
  assertInvoiceStatusTransition,
  calculateInvoiceTotals,
  generatePublicInvoiceToken,
  hashPublicInvoiceToken,
  getCanonicalInvoiceAppBaseUrl,
  isInvoicePaymentWebhookType,
  isValidInvoiceCheckoutPayment,
  isValidPublicInvoiceToken,
  normalizePayPalCheckoutUrl,
  verifyPublicInvoiceToken,
  type InvoiceLineInput,
  type InvoiceStatus,
} from "./invoice-core";

type DbInvoice = Record<string, any>;

const publicInvoiceLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: "Too many invoice requests. Please wait and try again.",
  // Single-process limiter: tokens must not make its cardinality unbounded.
  key: (req) => `${req.ip || req.socket.remoteAddress || "unknown"}:public-invoice`,
  maxEntries: 2000,
});

function requireInvoiceAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isAdminUser(req)) return res.status(403).json({ error: "Administrator access required" });
  next();
}

function actor(req: Request): string {
  const claims = (req.user as any)?.claims;
  return String(claims?.email || claims?.sub || "admin");
}

function baseUrl(): string {
  return getCanonicalInvoiceAppBaseUrl();
}

function idParam(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid invoice id");
  return id;
}

function optionalText(value: unknown, name: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > max) throw new Error(`${name} is invalid`);
  return value.trim();
}

function dueDate(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("dueDate must use YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new Error("dueDate is invalid");
  return value;
}

function invoicePayload(body: any) {
  const contactId = Number(body?.contactId);
  const jobId = body?.jobId === undefined || body?.jobId === null || body?.jobId === "" ? null : Number(body.jobId);
  if (!Number.isSafeInteger(contactId) || contactId < 1) throw new Error("contactId is required");
  if (jobId !== null && (!Number.isSafeInteger(jobId) || jobId < 1)) throw new Error("jobId is invalid");
  const totals = calculateInvoiceTotals(
    body?.lineItems as InvoiceLineInput[],
    body?.taxRateBps ?? 0,
    body?.discountCents ?? 0,
  );
  return {
    contactId,
    jobId,
    dueDate: dueDate(body?.dueDate),
    notes: optionalText(body?.notes, "notes", 10000),
    paypalCheckoutUrl: normalizePayPalCheckoutUrl(body?.paypalCheckoutUrl),
    totals,
  };
}

function publicInvoice(row: DbInvoice, lines: any[], payments: any[]) {
  return {
    invoiceNumber: row.invoice_number,
    status: row.status,
    currency: row.currency,
    client: {
      name: row.client_name,
    },
    jobNumber: row.job_number,
    dueDate: row.due_date,
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
    paypalCheckoutUrl: row.paypal_checkout_url,
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

async function recordAudit(client: any, invoiceId: number, who: string, action: string, details: unknown = null) {
  await client.query(
    "INSERT INTO invoice_audit_records (invoice_id, actor, action, details) VALUES ($1, $2, $3, $4)",
    [invoiceId, who, action, details === null ? null : JSON.stringify(details)],
  );
}

async function reconcileInvoice(row: DbInvoice): Promise<DbInvoice> {
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
    if (updated.rows[0]) await recordAudit(client, row.id, "stripe", "payment_verified", { sessionId: session.id, paymentIntentId });
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
  const eventSession = event?.data?.object;
  const invoiceId = Number(eventSession?.metadata?.invoiceId);
  if (!Number.isSafeInteger(invoiceId) || invoiceId < 1 || eventSession?.mode !== "payment") return;
  const row = await loadInvoice(invoiceId);
  if (!row || row.status !== "sent" || row.stripe_checkout_session_id !== eventSession.id) return;
  await reconcileInvoice(row);
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
      stripe_product_id text,
      stripe_price_id text,
      stripe_checkout_session_id text UNIQUE,
      stripe_payment_intent_id text,
      checkout_creating boolean NOT NULL DEFAULT false,
      stripe_checkout_idempotency_key text,
      sent_at timestamptz,
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
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS checkout_creating boolean NOT NULL DEFAULT false;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_checkout_idempotency_key text;
  `);
}

export function registerInvoiceRoutes(app: Express) {
  app.get("/api/public/invoices/:token", publicInvoiceLimiter, async (req, res) => {
    try {
      if (!isValidPublicInvoiceToken(req.params.token)) return res.status(404).json({ error: "Invoice not found" });
      let row = await loadInvoiceByToken(req.params.token);
      if (!row || row.status === "draft" || row.status === "void") return res.status(404).json({ error: "Invoice not found" });
      row = await reconcileInvoice(row);
      const related = await loadLinesAndPayments(row.id);
      res.json(publicInvoice(row, related.lines, related.payments));
    } catch (error: any) {
      console.error("[invoices] public lookup failed:", error);
      res.status(500).json({ error: "Unable to load invoice" });
    }
  });

  app.post("/api/public/invoices/:token/create-stripe-checkout", publicInvoiceLimiter, async (req, res) => {
    try {
      if (!isValidPublicInvoiceToken(req.params.token)) return res.status(404).json({ error: "Invoice not found" });
      const row = await loadInvoiceByToken(req.params.token);
      if (!row || row.status === "draft" || row.status === "void") return res.status(404).json({ error: "Invoice not found" });
      const url = `${baseUrl()}/invoice/${encodeURIComponent(req.params.token)}`;
      const session = await checkoutForInvoice(row, `${url}?payment=success`, `${url}?payment=cancelled`);
      res.json({ url: session.url, sessionId: session.id });
    } catch (error: any) {
      const status = /only for sent|at least 50/.test(error.message) ? 409 : 500;
      res.status(status).json({ error: status === 500 ? "Unable to create Stripe Checkout" : error.message });
    }
  });

  const admin = [isAuthenticated, requireInvoiceAdmin];

  app.get("/api/invoices", ...admin, async (_req, res) => {
    try {
      const initial = await pool.query("SELECT * FROM invoices ORDER BY created_at DESC LIMIT 250");
      await Promise.all(initial.rows.map((row) => reconcileInvoice(row)));
      const result = await pool.query(
        `SELECT i.*, count(li.id)::integer AS line_item_count
         FROM invoices i LEFT JOIN invoice_line_items li ON li.invoice_id = i.id
         GROUP BY i.id ORDER BY i.created_at DESC LIMIT 250`,
      );
      res.json(result.rows.map(ownerInvoice));
    } catch (error) {
      console.error("[invoices] list failed:", error);
      res.status(500).json({ error: "Unable to list invoices" });
    }
  });

  app.get("/api/invoices/:id", ...admin, async (req, res) => {
    try {
      let row = await loadInvoice(idParam(req.params.id));
      if (!row) return res.status(404).json({ error: "Invoice not found" });
      row = await reconcileInvoice(row);
      const [related, audit] = await Promise.all([
        loadLinesAndPayments(row.id),
        pool.query("SELECT * FROM invoice_audit_records WHERE invoice_id = $1 ORDER BY created_at, id", [row.id]),
      ]);
      res.json({ ...ownerInvoice(row), lineItems: related.lines, payments: related.payments, audit: audit.rows });
    } catch (error: any) {
      res.status(error.message === "Invalid invoice id" ? 400 : 500).json({ error: error.message || "Unable to load invoice" });
    }
  });

  app.post("/api/invoices", ...admin, async (req, res) => {
    const client = await pool.connect();
    try {
      const input = invoicePayload(req.body);
      await client.query("BEGIN");
      const contactResult = await client.query("SELECT * FROM crm_contacts WHERE id = $1", [input.contactId]);
      const contact = contactResult.rows[0];
      if (!contact) throw new Error("CRM contact not found");
      let job: any = null;
      if (input.jobId) {
        job = (await client.query("SELECT * FROM crm_jobs WHERE id = $1", [input.jobId])).rows[0];
        if (!job) throw new Error("CRM job not found");
        if (job.contact_id && job.contact_id !== input.contactId) throw new Error("CRM job does not belong to the selected contact");
      }
      const address = [contact.address, contact.city, contact.state, contact.zip_code].filter(Boolean).join(", ") || null;
      const inserted = await client.query(
        `INSERT INTO invoices (
           invoice_number, contact_id, job_id, client_name, client_email, client_address, job_number,
           due_date, notes, paypal_checkout_url, subtotal_cents, tax_rate_bps, tax_cents, discount_cents, total_cents
         ) VALUES (
           'INV-' || to_char(CURRENT_DATE, 'YYYY') || '-' || lpad(nextval('invoice_number_seq')::text, 6, '0'),
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
         ) RETURNING *`,
        [input.contactId, input.jobId, contact.full_name, contact.email, address, job?.job_number ?? null,
          input.dueDate, input.notes, input.paypalCheckoutUrl, input.totals.subtotalCents, input.totals.taxRateBps,
          input.totals.taxCents, input.totals.discountCents, input.totals.totalCents],
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
      await recordAudit(client, invoice.id, actor(req), "created");
      await client.query("COMMIT");
      res.status(201).json({ ...ownerInvoice(invoice), lineItems: input.totals.lines });
    } catch (error: any) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: error.message || "Unable to create invoice" });
    } finally {
      client.release();
    }
  });

  app.put("/api/invoices/:id", ...admin, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = idParam(req.params.id);
      const input = invoicePayload(req.body);
      await client.query("BEGIN");
      const existing = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!existing) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Invoice not found" });
      }
      assertDraftMutable(existing.status);
      const contact = (await client.query("SELECT * FROM crm_contacts WHERE id = $1", [input.contactId])).rows[0];
      if (!contact) throw new Error("CRM contact not found");
      let job: any = null;
      if (input.jobId) {
        job = (await client.query("SELECT * FROM crm_jobs WHERE id = $1", [input.jobId])).rows[0];
        if (!job) throw new Error("CRM job not found");
        if (job.contact_id && job.contact_id !== input.contactId) throw new Error("CRM job does not belong to the selected contact");
      }
      const address = [contact.address, contact.city, contact.state, contact.zip_code].filter(Boolean).join(", ") || null;
      const result = await client.query(
        `UPDATE invoices SET contact_id=$2, job_id=$3, client_name=$4, client_email=$5, client_address=$6,
           job_number=$7, due_date=$8, notes=$9, paypal_checkout_url=$10, subtotal_cents=$11,
           tax_rate_bps=$12, tax_cents=$13, discount_cents=$14, total_cents=$15, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [id, input.contactId, input.jobId, contact.full_name, contact.email, address, job?.job_number ?? null,
          input.dueDate, input.notes, input.paypalCheckoutUrl, input.totals.subtotalCents, input.totals.taxRateBps,
          input.totals.taxCents, input.totals.discountCents, input.totals.totalCents],
      );
      await client.query("DELETE FROM invoice_line_items WHERE invoice_id = $1", [id]);
      for (let position = 0; position < input.totals.lines.length; position++) {
        const line = input.totals.lines[position];
        await client.query(
          "INSERT INTO invoice_line_items (invoice_id,position,description,quantity,unit_amount_cents,amount_cents) VALUES ($1,$2,$3,$4,$5,$6)",
          [id, position, line.description, line.quantity, line.unitAmountCents, line.amountCents],
        );
      }
      await recordAudit(client, id, actor(req), "draft_updated");
      await client.query("COMMIT");
      res.json({ ...ownerInvoice(result.rows[0]), lineItems: input.totals.lines });
    } catch (error: any) {
      await client.query("ROLLBACK");
      const status = /Only draft/.test(error.message) ? 409 : 400;
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
        return res.status(404).json({ error: "Invoice not found" });
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
    const client = await pool.connect();
    try {
      const publicBaseUrl = baseUrl();
      await client.query("BEGIN");
      const row = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [idParam(req.params.id)])).rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Invoice not found" });
      }
      assertInvoiceStatusTransition(row.status as InvoiceStatus, "sent");
      const token = generatePublicInvoiceToken();
      const hash = hashPublicInvoiceToken(token);
      const updated = (await client.query(
        `UPDATE invoices SET status='sent', public_token_hash=$2, sent_at=now(), updated_at=now()
         WHERE id=$1 AND public_token_hash IS NULL RETURNING *`,
        [row.id, hash],
      )).rows[0];
      if (!updated) throw new Error("Invoice public token already exists");
      await recordAudit(client, row.id, actor(req), "sent");
      await client.query("COMMIT");
      res.json({ ...ownerInvoice(updated), publicUrl: `${publicBaseUrl}/invoice/${encodeURIComponent(token)}` });
    } catch (error: any) {
      await client.query("ROLLBACK");
      res.status(/cannot transition|already exists/.test(error.message) ? 409 : 400).json({ error: error.message });
    } finally {
      client.release();
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
        return res.status(404).json({ error: "Invoice not found" });
      }
      if (row.checkout_creating) throw new Error("Checkout creation is in progress; retry void after it completes");
      if (row.status === "sent" && row.stripe_checkout_session_id) {
        const stripe = await getUncachableStripeClient();
        let session = await stripe.checkout.sessions.retrieve(row.stripe_checkout_session_id);
        if (session.status === "open") session = await stripe.checkout.sessions.expire(session.id);
        if (session.status === "complete" && session.payment_status === "paid") {
          await client.query("ROLLBACK");
          await reconcileInvoice(row);
          return res.status(409).json({ error: "Invoice was paid and cannot be voided" });
        }
      }
      assertInvoiceStatusTransition(row.status as InvoiceStatus, "void");
      const updated = (await client.query("UPDATE invoices SET status='void', voided_at=now(), updated_at=now() WHERE id=$1 RETURNING *", [row.id])).rows[0];
      await recordAudit(client, row.id, actor(req), "voided");
      await client.query("COMMIT");
      res.json(ownerInvoice(updated));
    } catch (error: any) {
      await client.query("ROLLBACK");
      res.status(/cannot transition|in progress/.test(error.message) ? 409 : 400).json({ error: error.message });
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
        return res.status(404).json({ error: "Invoice not found" });
      }
      assertInvoiceStatusTransition(row.status as InvoiceStatus, "paid");
      await client.query(
        `INSERT INTO invoice_payments
           (invoice_id,provider,provider_payment_id,amount_cents,currency,verified,recorded_by)
         VALUES ($1,$2,$3,$4,'USD',true,$5)`,
        [row.id, provider, reference, row.total_cents, actor(req)],
      );
      const updated = (await client.query("UPDATE invoices SET status='paid', paid_at=now(), updated_at=now() WHERE id=$1 RETURNING *", [row.id])).rows[0];
      await recordAudit(client, row.id, actor(req), "manually_marked_paid", { provider, reference });
      await client.query("COMMIT");
      res.json(ownerInvoice(updated));
    } catch (error: any) {
      await client.query("ROLLBACK");
      const status = /cannot transition|duplicate key/.test(error.message) ? 409 : 400;
      res.status(status).json({ error: error.message || "Unable to record payment" });
    } finally {
      client.release();
    }
  });

  app.post("/api/invoices/:id/create-stripe-checkout", ...admin, async (req, res) => {
    try {
      const row = await loadInvoice(idParam(req.params.id));
      if (!row) return res.status(404).json({ error: "Invoice not found" });
      const returnUrl = `${baseUrl()}/invoices/${row.id}`;
      const session = await checkoutForInvoice(row, `${returnUrl}?payment=success`, `${returnUrl}?payment=cancelled`);
      res.json({ url: session.url, sessionId: session.id });
    } catch (error: any) {
      const status = /only for sent|at least 50/.test(error.message) ? 409 : /Invalid invoice/.test(error.message) ? 400 : 500;
      res.status(status).json({ error: status === 500 ? "Unable to create Stripe Checkout" : error.message });
    }
  });
}