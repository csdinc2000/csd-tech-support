import type { Express, NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { pool } from "./db";
import { getUncachableStripeClient } from "./stripeClient";
import { isAdminUser, rateLimit } from "./security";
import { sendEmail } from "./helpdesk-email";
import { logger } from "./lib/logger";
import { toValidE164 } from "./phone-validation";
import {
  CATALOG_RECONCILIATION_BASE_DELAY_MINUTES,
  CATALOG_RECONCILIATION_MAX_DELAY_MINUTES,
  isValidPaidCatalogCheckout,
  nextCatalogPurchaseStatus,
  planCatalogCrmLinks,
} from "./catalog-core";

const catalogMetadataKey = "csd_catalog";
const inquiryLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  message: "Too many inquiries. Please wait a minute and try again.",
  key: (req) => `${req.ip || req.socket.remoteAddress || "unknown"}:catalog-inquiry`,
});
const checkoutLimiter = rateLimit({
  windowMs: 60_000,
  max: 8,
  message: "Too many checkout requests. Please wait a minute and try again.",
  key: (req) => `${req.ip || req.socket.remoteAddress || "unknown"}:catalog-checkout`,
});

const createItemSchema = z.object({
  name: z.string().trim().min(1).max(250),
  description: z.string().trim().max(5000).optional().default(""),
  kind: z.enum(["product", "service"]),
  unitAmountCents: z.number().int().min(1).max(99_999_999),
  published: z.boolean().optional().default(false),
});

const updateItemSchema = z.object({
  name: z.string().trim().min(1).max(250).optional(),
  description: z.string().trim().max(5000).optional(),
  kind: z.enum(["product", "service"]).optional(),
  unitAmountCents: z.number().int().min(1).max(99_999_999).optional(),
  published: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

const inquirySchema = z.object({
  requestId: z.uuid(),
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(40).optional().default(""),
  message: z.string().trim().min(5).max(3000),
});

type CatalogItem = {
  id: string;
  name: string;
  description: string;
  kind: "product" | "service";
  unitAmountCents: number;
  priceId: string;
  published: boolean;
  active: boolean;
};

function catalogProduct(product: any, price: any): CatalogItem | null {
  if (product.deleted || !price || price.deleted || price.unit_amount == null || price.recurring) return null;
  const kind = product.metadata?.kind;
  if (kind !== "product" && kind !== "service") return null;
  return {
    id: product.id,
    name: product.name,
    description: product.description || "",
    kind,
    unitAmountCents: price.unit_amount,
    priceId: price.id,
    published: product.metadata?.published === "true",
    active: Boolean(product.active && price.active),
  };
}

async function itemFromProduct(stripe: any, product: any): Promise<CatalogItem | null> {
  if (product.deleted || product.metadata?.[catalogMetadataKey] !== "true") return null;
  const defaultPrice = product.default_price;
  const priceId = typeof defaultPrice === "string" ? defaultPrice : defaultPrice?.id;
  if (!priceId) return null;
  const price = typeof defaultPrice === "object" && defaultPrice?.id
    ? defaultPrice
    : await stripe.prices.retrieve(priceId);
  return catalogProduct(product, price);
}

async function getCatalogItem(stripe: any, productId: string): Promise<CatalogItem | null> {
  const product = await stripe.products.retrieve(productId, { expand: ["default_price"] });
  if (product.deleted || product.metadata?.[catalogMetadataKey] !== "true") return null;
  return itemFromProduct(stripe, product);
}

async function listProducts(stripe: any, options: { active?: boolean } = {}): Promise<any[]> {
  const products: any[] = [];
  await stripe.products.list({ ...options, limit: 100 }).autoPagingEach((product: any) => {
    products.push(product);
  });
  return products;
}

async function activeCatalogItem(stripe: any, productId: string): Promise<CatalogItem | null> {
  const item = await getCatalogItem(stripe, productId);
  return item?.active && item.published ? item : null;
}

/** Server-authoritative price source for staff proposal drafts. */
export async function getCsdApprovedCatalogService(productId: string): Promise<Pick<CatalogItem, "id" | "name" | "unitAmountCents"> | null> {
  const stripe = await getUncachableStripeClient();
  const item = await getCatalogItem(stripe, productId);
  if (!item?.active || item.kind !== "service" || !Number.isSafeInteger(item.unitAmountCents) || item.unitAmountCents < 1) {
    return null;
  }
  return { id: item.id, name: item.name, unitAmountCents: item.unitAmountCents };
}

function sendRouteError(res: Response, error: unknown, message: string): void {
  logger.warn({ error }, message);
  res.status(500).json({ error: message });
}

function requireCatalogOwner(req: Request, res: Response, next: NextFunction) {
  if (!isAdminUser(req)) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  next();
}

function publicBaseUrl(): string {
  const configured = process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:5000";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function crmIdentity(email: string): string {
  return email.trim().toLowerCase();
}

async function resolveCatalogCrmIdentity(
  client: any,
  email: string,
  name: string,
): Promise<{ contactId: number | null; accountId: number | null }> {
  const identity = crmIdentity(email);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [identity]);
  const contacts = await client.query(
    `SELECT id, client_id FROM crm_contacts WHERE lower(btrim(email))=$1 LIMIT 2`,
    [identity],
  );
  const contactRows = contacts.rows.map((contact: any) => ({
    id: Number(contact.id),
    clientId: contact.client_id == null ? null : Number(contact.client_id),
  }));
  let uniqueAccountId: number | null = null;
  let associatedAccountId: number | null = null;
  if (contactRows.length === 1 && contactRows[0].clientId != null) {
    const associated = await client.query(
      "SELECT id FROM clients WHERE id=$1 LIMIT 1",
      [contactRows[0].clientId],
    );
    if (associated.rows.length === 1) associatedAccountId = Number(associated.rows[0].id);
  } else if (contactRows.length <= 1) {
    const accounts = await client.query(
      `SELECT id FROM clients WHERE lower(btrim(contact_email))=$1 LIMIT 2`,
      [identity],
    );
    if (accounts.rows.length === 1) uniqueAccountId = Number(accounts.rows[0].id);
  }
  const plan = planCatalogCrmLinks({ contacts: contactRows, uniqueAccountId, associatedAccountId });
  if (!plan.createContact) return { contactId: plan.contactId, accountId: plan.accountId };

  const createdContact = await client.query(
    `INSERT INTO crm_contacts (full_name, email, client_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [name, email, plan.accountId],
  );
  return { contactId: Number(createdContact.rows[0].id), accountId: plan.accountId };
}

async function updatePurchaseFromSession(stripe: any, sessionId: string, eventType?: string): Promise<void> {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (!session?.id) return;
  let current = await pool.query(
    `SELECT id, status, stripe_checkout_session_id, stripe_product_id, stripe_price_id
       FROM catalog_purchases WHERE stripe_checkout_session_id=$1 LIMIT 1`,
    [session.id],
  );
  if (!current.rows[0] && session.metadata?.catalogPurchaseId) {
    current = await pool.query(
      `SELECT id, status, stripe_checkout_session_id, stripe_product_id, stripe_price_id
         FROM catalog_purchases WHERE id::text=$1 LIMIT 1`,
      [session.metadata.catalogPurchaseId],
    );
  }
  const purchase = current.rows[0];
  if (!purchase) return;
  if (
    session.metadata?.catalogPurchaseId !== String(purchase.id) ||
    session.metadata?.productId !== purchase.stripe_product_id ||
    session.metadata?.priceId !== purchase.stripe_price_id ||
    (purchase.stripe_checkout_session_id && purchase.stripe_checkout_session_id !== session.id)
  ) {
    logger.warn({ sessionId: session.id, purchaseId: purchase.id }, "Catalog Checkout metadata does not match its purchase mapping");
    return;
  }

  let verifiedPaid = false;
  if (session.status === "complete" && session.payment_status === "paid") {
    const [price, product, lineItems] = await Promise.all([
      stripe.prices.retrieve(purchase.stripe_price_id),
      stripe.products.retrieve(purchase.stripe_product_id),
      stripe.checkout.sessions.listLineItems(session.id, { limit: 100 }),
    ]);
    verifiedPaid = isValidPaidCatalogCheckout({
      session,
      lineItems: lineItems.data,
      price,
      product,
      purchase,
    });
    if (!verifiedPaid) {
      logger.warn({ sessionId: session.id, purchaseId: purchase.id }, "Paid Stripe Checkout session does not match the catalog purchase");
      return;
    }
  } else if (purchase.status === "paid") {
    // A delayed failed/expired event must never mutate an already verified purchase.
    return;
  }
  const details = verifiedPaid ? session.customer_details || {} : {};
  const email = typeof details.email === "string" ? details.email.trim().toLowerCase() : null;
  const customerName = typeof details.name === "string" ? details.name.trim() : null;
  const amount = verifiedPaid && Number.isInteger(session.amount_total) ? session.amount_total : null;
  const currency = verifiedPaid && typeof session.currency === "string" ? session.currency : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lockedResult = await client.query(
      `SELECT id, status, stripe_checkout_session_id
         FROM catalog_purchases WHERE id=$1 FOR UPDATE`,
      [purchase.id],
    );
    const locked = lockedResult.rows[0];
    if (!locked || (locked.stripe_checkout_session_id && locked.stripe_checkout_session_id !== session.id)) {
      await client.query("COMMIT");
      return;
    }
    if (locked.status === "paid" && !verifiedPaid) {
      await client.query("COMMIT");
      return;
    }

    const status = nextCatalogPurchaseStatus(locked.status, session, eventType, verifiedPaid);
    const crmLinks = verifiedPaid && email
      ? await resolveCatalogCrmIdentity(client, email, customerName || email)
      : { contactId: null, accountId: null };
    await client.query(
      `UPDATE catalog_purchases
          SET status=CASE WHEN status='paid' THEN 'paid' ELSE $2 END,
              customer_email=COALESCE($3, customer_email),
              customer_name=COALESCE($4, customer_name),
              amount_total_cents=COALESCE($5, amount_total_cents),
              currency=COALESCE($6, currency),
              crm_contact_id=COALESCE(crm_contact_id, $7),
              crm_account_id=COALESCE(crm_account_id, $8),
              paid_at=CASE WHEN $2='paid' THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
              stripe_checkout_session_id=COALESCE(stripe_checkout_session_id, $9),
              updated_at=NOW()
        WHERE id=$1`,
      [purchase.id, status, email, customerName, amount, currency, crmLinks.contactId, crmLinks.accountId, session.id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function handleCatalogStripeWebhookEvent(event: any): Promise<void> {
  const type = event?.type;
  if (![
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "checkout.session.expired",
  ].includes(type)) return;
  const sessionId = event.data?.object?.id;
  if (typeof sessionId !== "string") return;
  const stripe = await getUncachableStripeClient();
  await updatePurchaseFromSession(stripe, sessionId, type);
}

const CATALOG_RECONCILIATION_BATCH_SIZE = 25;
const CATALOG_RECONCILIATION_INTERVAL_MS = 5 * 60_000;
let catalogReconciliationTimer: NodeJS.Timeout | null = null;
let catalogReconciliationRunning = false;

export async function reconcileCatalogPurchases(stripe: any, limit = CATALOG_RECONCILIATION_BATCH_SIZE): Promise<void> {
  const claimed = await pool.query(
    `WITH batch AS (
       SELECT id
         FROM catalog_purchases
        WHERE status <> 'paid'
          AND stripe_checkout_session_id IS NOT NULL
          AND next_reconcile_at <= NOW()
        ORDER BY next_reconcile_at, created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE catalog_purchases AS purchase
        SET reconciliation_attempts = reconciliation_attempts + 1,
            last_reconciled_at = NOW(),
            next_reconcile_at = NOW() +
              LEAST($2 * power(2, LEAST(reconciliation_attempts, 9)), $3) * INTERVAL '1 minute',
            updated_at = NOW()
       FROM batch
      WHERE purchase.id = batch.id
      RETURNING purchase.stripe_checkout_session_id`,
    [
      limit,
      CATALOG_RECONCILIATION_BASE_DELAY_MINUTES,
      CATALOG_RECONCILIATION_MAX_DELAY_MINUTES,
    ],
  );
  await Promise.all(claimed.rows.map(async ({ stripe_checkout_session_id }) => {
    try {
      await updatePurchaseFromSession(stripe, stripe_checkout_session_id);
    } catch (error) {
      logger.warn({ error, sessionId: stripe_checkout_session_id }, "Catalog checkout reconciliation failed");
    }
  }));
}

async function runCatalogReconciliationBatch(): Promise<void> {
  if (catalogReconciliationRunning) return;
  catalogReconciliationRunning = true;
  try {
    const stripe = await getUncachableStripeClient();
    await reconcileCatalogPurchases(stripe);
  } catch (error) {
    logger.warn({ error }, "Catalog reconciliation batch failed");
  } finally {
    catalogReconciliationRunning = false;
  }
}

export function startCatalogReconciliationWorker(): void {
  if (catalogReconciliationTimer) return;
  void runCatalogReconciliationBatch();
  catalogReconciliationTimer = setInterval(() => {
    void runCatalogReconciliationBatch();
  }, CATALOG_RECONCILIATION_INTERVAL_MS);
  catalogReconciliationTimer.unref?.();
}

export function registerCatalogRoutes(app: Express): void {
  app.get("/api/catalog/items", async (_req, res) => {
    try {
      const stripe = await getUncachableStripeClient();
      const items: CatalogItem[] = [];
      for (const product of await listProducts(stripe)) {
        if (product.metadata?.[catalogMetadataKey] !== "true") continue;
        const item = await itemFromProduct(stripe, product);
        if (item) items.push(item);
      }
      res.json({ items });
      return;
    } catch (error) {
      return sendRouteError(res, error, "Could not load catalog items");
    }
  });

  app.post("/api/catalog/items", requireCatalogOwner, async (req, res) => {
    const parsed = createItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid catalog item" });
      return;
    }
    try {
      const stripe = await getUncachableStripeClient();
      const input = parsed.data;
      const product = await stripe.products.create({
        name: input.name,
        description: input.description,
        active: true,
        metadata: {
          [catalogMetadataKey]: "true",
          kind: input.kind,
          published: String(input.published),
        },
      });
      const price = await stripe.prices.create({
        product: product.id,
        currency: "usd",
        unit_amount: input.unitAmountCents,
      });
      const updated = await stripe.products.update(product.id, { default_price: price.id });
      res.status(201).json(catalogProduct(updated, price));
      return;
    } catch (error) {
      return sendRouteError(res, error, "Could not create catalog item");
    }
  });

  app.patch("/api/catalog/items/:id", requireCatalogOwner, async (req, res) => {
    const parsed = updateItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid catalog item" });
      return;
    }
    try {
      const stripe = await getUncachableStripeClient();
      const productId = String(req.params.id);
      const current = await getCatalogItem(stripe, productId);
      if (!current) {
        res.status(404).json({ error: "Catalog item not found" });
        return;
      }

      const metadata = {
        [catalogMetadataKey]: "true",
        kind: parsed.data.kind ?? current.kind,
        published: String(parsed.data.published ?? current.published),
      };
      const product = await stripe.products.update(productId, {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        metadata,
      });
      let price: any = await stripe.prices.retrieve(current.priceId);
      if (parsed.data.unitAmountCents !== undefined && parsed.data.unitAmountCents !== current.unitAmountCents) {
        const newPrice = await stripe.prices.create({
          product: product.id,
          currency: price.currency || "usd",
          unit_amount: parsed.data.unitAmountCents,
        });
        await stripe.products.update(product.id, { default_price: newPrice.id });
        await stripe.prices.update(price.id, { active: false });
        price = newPrice;
      }
      res.json(catalogProduct(product, price));
      return;
    } catch (error) {
      if ((error as any)?.statusCode === 404) {
        res.status(404).json({ error: "Catalog item not found" });
        return;
      }
      return sendRouteError(res, error, "Could not update catalog item");
    }
  });

  app.delete("/api/catalog/items/:id", requireCatalogOwner, async (req, res) => {
    try {
      const stripe = await getUncachableStripeClient();
      const productId = String(req.params.id);
      const item = await getCatalogItem(stripe, productId);
      if (!item) {
        res.status(404).json({ error: "Catalog item not found" });
        return;
      }
      await stripe.products.update(productId, { active: false });
      res.json({ ...item, active: false });
      return;
    } catch (error) {
      if ((error as any)?.statusCode === 404) {
        res.status(404).json({ error: "Catalog item not found" });
        return;
      }
      return sendRouteError(res, error, "Could not archive catalog item");
    }
  });

  app.get("/api/portal/catalog/items", async (_req, res) => {
    try {
      const stripe = await getUncachableStripeClient();
      const items: CatalogItem[] = [];
      for (const product of await listProducts(stripe, { active: true })) {
        if (product.metadata?.[catalogMetadataKey] !== "true" || product.metadata?.published !== "true") continue;
        const item = await itemFromProduct(stripe, product);
        if (item?.active && item.published) items.push(item);
      }
      res.json({ items });
      return;
    } catch (error) {
      return sendRouteError(res, error, "Could not load catalog items");
    }
  });

  app.get("/api/portal/catalog/items/:id", async (req, res) => {
    try {
      const stripe = await getUncachableStripeClient();
      const item = await activeCatalogItem(stripe, String(req.params.id));
      if (!item) {
        res.status(404).json({ error: "Catalog item not found" });
        return;
      }
      res.json(item);
      return;
    } catch (error) {
      if ((error as any)?.statusCode === 404) {
        res.status(404).json({ error: "Catalog item not found" });
        return;
      }
      return sendRouteError(res, error, "Could not load catalog item");
    }
  });

  app.post("/api/portal/catalog/items/:id/checkout", checkoutLimiter, async (req, res) => {
    try {
      const stripe = await getUncachableStripeClient();
      const item = await activeCatalogItem(stripe, String(req.params.id));
      if (!item) {
        res.status(404).json({ error: "Catalog item not found" });
        return;
      }
      const purchaseId = randomUUID();
      const created = await pool.query(
        `INSERT INTO catalog_purchases (id, stripe_product_id, stripe_price_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [purchaseId, item.id, item.priceId],
      );
       const offerUrl = `${publicBaseUrl()}/portal/marketplace/offers/${encodeURIComponent(item.id)}`;
       const successUrl = `${offerUrl}?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
       const cancelUrl = `${offerUrl}?checkout=cancelled`;
      try {
        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          line_items: [{ price: item.priceId, quantity: 1 }],
          success_url: successUrl,
          cancel_url: cancelUrl,
          metadata: { catalogPurchaseId: created.rows[0].id, productId: item.id, priceId: item.priceId },
          payment_intent_data: {
            metadata: { catalogPurchaseId: created.rows[0].id, productId: item.id },
          },
        });
        if (!session.url) throw new Error("Stripe did not return a checkout URL");
        await pool.query(
          `UPDATE catalog_purchases
              SET stripe_checkout_session_id=$2, updated_at=NOW()
            WHERE id=$1`,
          [created.rows[0].id, session.id],
        );
        res.json({ url: session.url });
        return;
      } catch (error) {
        await pool.query(
          "UPDATE catalog_purchases SET status='checkout_failed', updated_at=NOW() WHERE id=$1",
          [created.rows[0].id],
        );
        throw error;
      }
    } catch (error) {
      if ((error as any)?.statusCode === 404) {
        res.status(404).json({ error: "Catalog item not found" });
        return;
      }
      return sendRouteError(res, error, "Could not start checkout");
    }
  });

  app.post("/api/portal/catalog/items/:id/inquire", inquiryLimiter, async (req, res) => {
    const parsed = inquirySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid inquiry" });
      return;
    }
    try {
      const input = parsed.data;
      // Check the durable request first: a retry after a lost response must not
      // repeat the notification or create a second CRM activity.
      const prior = await pool.query("SELECT stripe_product_id FROM catalog_inquiries WHERE id=$1", [input.requestId]);
      if (prior.rows[0]) {
        if (prior.rows[0].stripe_product_id !== String(req.params.id)) {
          res.status(409).json({ error: "Request ID already used" });
          return;
        }
        res.status(202).json({ received: true });
        return;
      }
      const stripe = await getUncachableStripeClient();
      const item = await activeCatalogItem(stripe, String(req.params.id));
      if (!item) {
        res.status(404).json({ error: "Catalog item not found" });
        return;
      }
      const client = await pool.connect();
      let inserted = false;
      try {
        await client.query("BEGIN");
        const existing = await client.query(
          "SELECT id FROM crm_contacts WHERE lower(btrim(email))=$1 LIMIT 2",
          [crmIdentity(input.email)],
        );
        const contactId = existing.rows.length === 1 ? Number(existing.rows[0].id) : null;
        const result = await client.query(
          `INSERT INTO catalog_inquiries
            (id, stripe_product_id, offer_name, unit_amount_cents, requester_name, requester_email, requester_phone, message, crm_contact_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO NOTHING RETURNING id`,
          [input.requestId, item.id, item.name, item.unitAmountCents, input.name, crmIdentity(input.email), input.phone, input.message, contactId],
        );
        inserted = result.rowCount === 1;
        if (inserted && contactId) {
          const interaction = await client.query(
            `INSERT INTO crm_interactions (contact_id, type, summary, details, performed_by)
             VALUES ($1, 'catalog_inquiry', $2, $3, 'Marketplace') RETURNING id`,
            [contactId, `Unverified marketplace request: ${item.name}`, input.message],
          );
          await client.query("UPDATE catalog_inquiries SET crm_interaction_id=$2 WHERE id=$1", [input.requestId, interaction.rows[0].id]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      if (!inserted) {
        res.status(202).json({ received: true });
        return;
      }
      // The CRM record is authoritative. Mail is a best-effort notification,
      // never a reason for the buyer to submit the request a second time.
      const to = process.env.CSD_ADMIN_EMAIL || "support@computersystemsdepot.com";
      try { await sendEmail(
        to,
        `Catalog inquiry: ${item.name}`,
        `Catalog inquiry for ${item.name}\n\nName: ${input.name}\nEmail: ${input.email}\nPhone: ${input.phone || "Not provided"}\n\n${input.message}`,
        {
          replyTo: input.email,
          html: `<h2>Catalog inquiry: ${escapeHtml(item.name)}</h2><p><b>Name:</b> ${escapeHtml(input.name)}<br><b>Email:</b> ${escapeHtml(input.email)}<br><b>Phone:</b> ${escapeHtml(input.phone || "Not provided")}</p><p>${escapeHtml(input.message).replace(/\n/g, "<br>")}</p>`,
          operation: "marketplace",
        },
      ); } catch (error) { logger.warn({ error: error instanceof Error ? error.name : "unknown" }, "Catalog inquiry notification failed"); }
      res.status(202).json({ received: true });
      return;
    } catch (error) {
      if ((error as any)?.statusCode === 404) {
        res.status(404).json({ error: "Catalog item not found" });
        return;
      }
      return sendRouteError(res, error, "Could not send inquiry");
    }
  });

  app.get("/api/catalog/inquiries", requireCatalogOwner, async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT q.id, q.offer_name AS "offerName", q.unit_amount_cents AS "unitAmountCents",
                q.requester_name AS "name", q.requester_email AS "email", q.requester_phone AS "phone",
                q.message, q.crm_contact_id AS "contactId", c.full_name AS "contactName",
                c.client_id AS "accountId", q.invoice_id AS "invoiceId",
                i.invoice_number AS "invoiceNumber", i.status AS "invoiceStatus",
                q.created_at AS "createdAt"
           FROM catalog_inquiries q
           LEFT JOIN crm_contacts c ON c.id=q.crm_contact_id
           LEFT JOIN invoices i ON i.id=q.invoice_id
          ORDER BY q.created_at DESC LIMIT 500`,
      );
      res.json({ inquiries: result.rows });
      return;
    } catch (error) { return sendRouteError(res, error, "Could not load inquiries"); }
  });

  app.post("/api/catalog/inquiries/:id/resolve", requireCatalogOwner, async (req, res) => {
    const parsed = z.object({
      contactId: z.number().int().positive().optional(),
      clientId: z.number().int().positive().optional(),
    }).strict().refine((value) => !(value.contactId && value.clientId)).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid contact selection" });
      return;
    }
    if (!z.uuid().safeParse(req.params.id).success) {
      res.status(400).json({ error: "Invalid inquiry ID" });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("SELECT * FROM catalog_inquiries WHERE id=$1 FOR UPDATE", [req.params.id]);
      const inquiry = result.rows[0];
      if (!inquiry) { await client.query("ROLLBACK"); res.status(404).json({ error: "Inquiry not found" }); return; }
      if (inquiry.invoice_id != null) {
        await client.query("ROLLBACK");
        res.status(409).json({
          error: "This inquiry is already linked to an invoice and cannot be relinked",
          invoiceId: Number(inquiry.invoice_id),
        });
        return;
      }
      let contactId = parsed.data.contactId;
      if (contactId) {
        const contact = await client.query("SELECT id FROM crm_contacts WHERE id=$1", [contactId]);
        if (!contact.rows[0]) { await client.query("ROLLBACK"); res.status(400).json({ error: "Contact not found" }); return; }
      } else {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [crmIdentity(inquiry.requester_email)]);
        if (parsed.data.clientId) {
          const account = await client.query("SELECT id FROM clients WHERE id=$1", [parsed.data.clientId]);
          if (!account.rows[0]) { await client.query("ROLLBACK"); res.status(400).json({ error: "Customer account not found" }); return; }
        }
        const phone = inquiry.requester_phone ? toValidE164(inquiry.requester_phone) : null;
        if (inquiry.requester_phone && !phone) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: "This phone number needs correction before creating a contact. Select an existing contact instead." });
          return;
        }
        const existing = await client.query("SELECT id FROM crm_contacts WHERE lower(btrim(email))=$1 LIMIT 2", [crmIdentity(inquiry.requester_email)]);
        if (existing.rows.length) {
          await client.query("ROLLBACK");
          res.status(409).json({ error: "A contact with this email exists. Select the correct contact instead." });
          return;
        }
        const created = await client.query(
          "INSERT INTO crm_contacts (full_name, email, mobile_phone, client_id) VALUES ($1,$2,$3,$4) RETURNING id",
          [inquiry.requester_name, inquiry.requester_email, phone, parsed.data.clientId ?? null],
        );
        contactId = Number(created.rows[0].id);
      }
      if (inquiry.crm_interaction_id) {
        await client.query("UPDATE crm_interactions SET contact_id=$2 WHERE id=$1", [inquiry.crm_interaction_id, contactId]);
      } else {
        const interaction = await client.query(
          `INSERT INTO crm_interactions (contact_id, type, summary, details, performed_by)
           VALUES ($1, 'catalog_inquiry', $2, $3, 'Marketplace') RETURNING id`,
          [contactId, `Unverified marketplace request: ${inquiry.offer_name}`, inquiry.message],
        );
        await client.query("UPDATE catalog_inquiries SET crm_interaction_id=$2 WHERE id=$1", [inquiry.id, interaction.rows[0].id]);
      }
      await client.query("UPDATE catalog_inquiries SET crm_contact_id=$2 WHERE id=$1", [inquiry.id, contactId]);
      await client.query("COMMIT");
      res.json({ contactId });
      return;
    } catch (error) {
      await client.query("ROLLBACK");
      return sendRouteError(res, error, "Could not resolve inquiry");
    } finally { client.release(); }
  });

  app.get("/api/catalog/orders", async (_req, res) => {
    try {
      const stripe = await getUncachableStripeClient();
      await reconcileCatalogPurchases(stripe, 50);
      const result = await pool.query(
        `SELECT id, stripe_checkout_session_id AS "checkoutSessionId",
                stripe_product_id AS "productId", stripe_price_id AS "priceId",
                status, customer_email AS "customerEmail", customer_name AS "customerName",
                amount_total_cents AS "amountTotalCents", currency,
                crm_contact_id AS "crmContactId", crm_account_id AS "crmAccountId",
                paid_at AS "paidAt", created_at AS "createdAt"
           FROM catalog_purchases
          ORDER BY created_at DESC
          LIMIT 500`,
      );
      res.json({ orders: result.rows });
      return;
    } catch (error) {
      return sendRouteError(res, error, "Could not load catalog orders");
    }
  });
}