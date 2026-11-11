/**
 * Opt-in, test-mode-only catalog integration exercise.
 * Uses a disposable PostgreSQL schema and four real Stripe test Checkout sessions.
 * The normal application and its public CRM tables are never written by this script.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import express from "express";
import { Pool } from "@neondatabase/serverless";
import type Stripe from "stripe";

if (process.env.RUN_CATALOG_STRIPE_SANDBOX_TEST !== "1" || process.env.REPLIT_DEPLOYMENT === "1") {
  throw new Error("Catalog Stripe sandbox test must be explicitly enabled in development");
}
if (!process.env.DATABASE_URL) throw new Error("Catalog Stripe sandbox test requires DATABASE_URL");

const originalDatabaseUrl = process.env.DATABASE_URL;
const schema = `catalog_test_${randomUUID().replaceAll("-", "")}`;
const bootstrap = new Pool({ connectionString: originalDatabaseUrl });
let isolatedPool: typeof import("../src/db.ts").pool | undefined;
let stripe: Stripe | undefined;
let productId: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

async function completeCheckout(url: string, email: string): Promise<void> {
  assert(browser);
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator('input[name="email"]').fill(email);
    await page.waitForTimeout(2_000);
    // Stripe Checkout can place its payment fields in either the main frame or an iframe.
    const fields = ["cardNumber", "cardExpiry", "cardCvc"];
    for (const [index, value] of ["4242424242424242", "1234", "123"].entries()) {
      const name = fields[index];
      // Probe the frames rather than relying on Stripe's presentation-specific iframe title.
      let filled = false;
      for (const candidate of page.frames()) {
        if (await candidate.locator(`input[name="${name}"]`).count()) {
          await candidate.locator(`input[name="${name}"]`).fill(value);
          filled = true;
          break;
        }
      }
      if (!filled) {
        const inputs = (await Promise.all(page.frames().map(async (candidate) =>
          candidate.locator("input").evaluateAll((elements) => elements.map((element) => ({
            name: element.getAttribute("name"), placeholder: element.getAttribute("placeholder"),
          }))),
        ))).flat();
        throw new Error(`Stripe test Checkout field ${name} was not available; inputs: ${JSON.stringify(inputs)}`);
      }
    }
    await page.locator('input[name="billingName"]').fill("Catalog Test Buyer");
    await page.locator('input[name="billingPostalCode"]').fill("10001");
    const saveForLater = page.locator('input[name="enableStripePass"]');
    if (await saveForLater.isVisible() && await saveForLater.isChecked()) {
      await saveForLater.uncheck();
    }
    await page.locator('button[type="submit"]').last().click();
    try {
      await page.waitForURL((target) => target.hostname === "example.com" && target.pathname === "/catalog-test-success", {
        timeout: 20_000, waitUntil: "commit",
      });
    } catch {
      const messages = await page.locator('[role="alert"], [aria-invalid="true"]').allTextContents();
      const invalid = await page.locator('[aria-invalid="true"]').evaluateAll((elements) =>
        elements.map((element) => ({
          name: element.getAttribute("name"),
          placeholder: element.getAttribute("placeholder"),
          context: element.parentElement?.parentElement?.textContent?.trim().slice(0, 80),
        })),
      );
      throw new Error(`Stripe test Checkout did not redirect; validation messages: ${JSON.stringify(messages)} invalid: ${JSON.stringify(invalid)}`);
    }
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  await bootstrap.query(`CREATE SCHEMA "${schema}"`);
  const isolatedUrl = new URL(originalDatabaseUrl);
  isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = isolatedUrl.toString();
  const { pool } = await import("../src/db.ts");
  isolatedPool = pool;
  assert.equal((await pool.query("SHOW search_path")).rows[0].search_path, schema);
  // The client imports db.ts; only import it after routing the pool to the disposable schema.
  const { getUncachableStripeClient } = await import("../src/stripeClient.ts");
  stripe = await getUncachableStripeClient();
  assert.equal((await stripe.balance.retrieve()).livemode, false, "Refusing a live Stripe account");
  await pool.query("CREATE TABLE clients (id INTEGER PRIMARY KEY, contact_email TEXT)");
  await pool.query("CREATE TABLE crm_contacts (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, full_name TEXT, email TEXT, client_id INTEGER REFERENCES clients(id))");
  await pool.query("CREATE TABLE crm_interactions (id INTEGER PRIMARY KEY)");
  const { applyCatalogMigration } = await import("../src/migrations/2026-09-28-catalog.ts");
  await applyCatalogMigration();
  const { handleCatalogStripeWebhookEvent, reconcileCatalogPurchases, registerCatalogRoutes } = await import("../src/catalog.ts");

  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const uniqueEmail = `catalog-${suffix}@example.com`;
  const ambiguousEmail = `catalog-ambiguous-${suffix}@example.com`;
  await pool.query("INSERT INTO clients (id, contact_email) VALUES (1, $1)", [uniqueEmail]);
  await pool.query("INSERT INTO crm_contacts (full_name, email, client_id) VALUES ('Existing', $1, 1)", [uniqueEmail]);
  await pool.query("INSERT INTO crm_contacts (full_name, email) VALUES ('A', $1), ('B', $1)", [ambiguousEmail]);
  productId = (await stripe.products.create({
    name: `Catalog verification ${suffix}`,
    metadata: { csd_catalog: "true" },
  })).id;
  const price = await stripe.prices.create({ product: productId, unit_amount: 100, currency: "usd" });
  browser = await chromium.launch({ headless: true, executablePath: "/repl/tools/bin/chromium", args: ["--no-sandbox"] });

  const cases = [
    { label: "valid", email: uniqueEmail },
    { label: "delayed", email: uniqueEmail },
    { label: "missed", email: uniqueEmail },
    { label: "ambiguous", email: ambiguousEmail },
  ] as const;
  const purchases: Array<{ label: string; id: string; sessionId: string }> = [];
  async function paidEvent(sessionId: string): Promise<Stripe.Event> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const events = await stripe!.events.list({ type: "checkout.session.completed", limit: 100 });
      const event = events.data.find((candidate) => (candidate.data.object as Stripe.Checkout.Session).id === sessionId);
      if (event) return event;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error("Stripe did not expose the test-mode Checkout completion event");
  }
  async function deliver(event: Stripe.Event): Promise<void> {
    const payload = JSON.stringify(event);
    const secret = "whsec_catalog_isolated_test";
    const signature = stripe!.webhooks.generateTestHeaderString({ payload, secret });
    const verified = stripe!.webhooks.constructEvent(payload, signature, secret);
    assert.equal(verified.livemode, false);
    await handleCatalogStripeWebhookEvent(verified);
  }
  for (const scenario of cases) {
    const id = randomUUID();
    await pool.query("INSERT INTO catalog_purchases (id, stripe_product_id, stripe_price_id) VALUES ($1, $2, $3)", [id, productId, price.id]);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: "https://example.com/catalog-test-success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://example.com/catalog-test-cancel",
      metadata: { catalogPurchaseId: id, productId, priceId: price.id },
      payment_intent_data: { metadata: { catalogPurchaseId: id, productId } },
    });
    assert(session.url);
    await pool.query("UPDATE catalog_purchases SET stripe_checkout_session_id=$2 WHERE id=$1", [id, session.id]);
    await completeCheckout(session.url, scenario.email);
    const paid = await stripe.checkout.sessions.retrieve(session.id);
    assert.equal(paid.payment_status, "paid", `${scenario.label}: Stripe did not verify payment`);
    assert.equal((await pool.query("SELECT status FROM catalog_purchases WHERE id=$1", [id])).rows[0].status, "pending",
      `${scenario.label}: webhook arrived in isolated schema before test delivery`);
    purchases.push({ label: scenario.label, id, sessionId: session.id });

    if (scenario.label === "valid" || scenario.label === "ambiguous") {
      await deliver(await paidEvent(session.id));
    } else if (scenario.label === "delayed") {
      // An older failure arriving after payment must not override Stripe's current paid state.
      await handleCatalogStripeWebhookEvent({ type: "checkout.session.async_payment_failed", data: { object: { id: session.id } } });
      await deliver(await paidEvent(session.id));
    }
  }
  // Missed webhook: only the reconciliation worker is allowed to discover payment.
  assert.equal((await pool.query("SELECT status FROM catalog_purchases WHERE id=$1", [purchases[2].id])).rows[0].status, "pending");
  await reconcileCatalogPurchases(stripe);
  await handleCatalogStripeWebhookEvent({ type: "checkout.session.expired", data: { object: { id: purchases[1].sessionId } } });

  // Exercise the staff history route, including its on-read reconciliation.
  const app = express();
  registerCatalogRoutes(app);
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/catalog/orders`);
  assert.equal(response.status, 200);
  const history = (await response.json()) as { orders: Array<Record<string, unknown>> };
  for (const purchase of purchases) {
    const order = history.orders.find((candidate) => candidate.id === purchase.id);
    assert(order, `${purchase.label}: paid order missing from staff history`);
    assert.equal(order.status, "paid", `${purchase.label}: staff history differs from Stripe`);
    assert.equal(order.checkoutSessionId, purchase.sessionId);
    assert.equal(order.amountTotalCents, 100);
    assert.equal(order.currency, "usd");
    const contact = await pool.query("SELECT id, client_id FROM crm_contacts WHERE id=$1", [order.crmContactId]);
    if (purchase.label === "ambiguous") {
      assert.equal(order.crmContactId, null, "Ambiguous email must not attach to either contact");
      assert.equal(order.crmAccountId, null);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM crm_contacts WHERE lower(email)=$1", [ambiguousEmail])).rows[0].count, 2);
    } else {
      assert.equal(contact.rows.length, 1, `${purchase.label}: linked contact missing`);
      assert.equal(Number(contact.rows[0].client_id), Number(order.crmAccountId));
      assert.equal(Number(order.crmAccountId), 1);
    }
  }
  console.log("Four Stripe test-mode catalog payments reconciled in isolated CRM history: valid, delayed, missed, ambiguous.");
}

try {
  await main();
} finally {
  await new Promise<void>((resolve, reject) => server ? server.close((error) => error ? reject(error) : resolve()) : resolve());
  await browser?.close();
  await isolatedPool?.end();
  process.env.DATABASE_URL = originalDatabaseUrl;
  if (productId && stripe) await stripe.products.update(productId, { active: false });
  await bootstrap.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await bootstrap.end();
}