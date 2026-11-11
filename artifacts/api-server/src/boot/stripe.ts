import express, { type Express } from "express";
import type Stripe from "stripe";
import { logger } from "../lib/logger";
import { WebhookHandlers } from "../webhookHandlers";
import { isStripeConfigured, getStripeSync, getUncachableStripeClient } from "../stripeClient";
import { handleInvoiceStripeWebhookEvent } from "../invoice-routes";
import { handleCatalogStripeWebhookEvent } from "../catalog";
import { missingCatalogWebhookEvents } from "../catalog-webhook-events";

// Must be registered BEFORE express.json() so the raw body is available for
// signature verification.
export function registerStripeWebhook(app: Express): void {
  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) {
      res.status(400).json({ error: "Missing stripe-signature" });
      return;
    }
    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      // stripe-replit-sync has verified the signature and processed its own
      // sync before these invoice/catalog finality hooks run.
      const event = JSON.parse(req.body.toString("utf8"));
      await handleInvoiceStripeWebhookEvent(event);
      await handleCatalogStripeWebhookEvent(event);
      res.status(200).json({ received: true });
    } catch (error: any) {
      logger.error({ message: error?.message ?? String(error) }, "Stripe webhook error");
      res.status(400).json({ error: "Webhook processing error" });
    }
  });
}

export async function initStripe(): Promise<void> {
  try {
    if (!(await isStripeConfigured())) {
      logger.info("Stripe integration not connected; skipping initialization.");
      return;
    }
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      logger.info("DATABASE_URL not set; skipping Stripe initialization.");
      return;
    }
    const { runMigrations } = await import("stripe-replit-sync");
    await runMigrations({ databaseUrl });
    const stripeSync = await getStripeSync();
    const webhookBaseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;
    if (process.env.REPLIT_DOMAINS) {
      try {
        const webhook = await stripeSync.findOrCreateManagedWebhook(`${webhookBaseUrl}/api/stripe/webhook`);
        const missing = missingCatalogWebhookEvents(webhook.enabled_events);
        if (missing.length) {
          const stripe = await getUncachableStripeClient();
          await stripe.webhookEndpoints.update(webhook.id, {
            enabled_events: [...new Set([...webhook.enabled_events, ...missing])] as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
          });
          logger.info({ eventCount: missing.length }, "Enabled missing catalog webhook events");
        }
      } catch (err: any) {
        logger.warn(
          { errorType: err?.type ?? "unknown", statusCode: err?.statusCode },
          "Stripe webhook setup warning; catalog purchase reconciliation remains active",
        );
      }
    }
    void (async () => {
      try {
        await stripeSync.syncBackfill();
      } catch (err: any) {
        logger.error({ message: err?.message ?? String(err) }, "Stripe syncBackfill error");
      }
      // Explicitly sync the entities the Billing page needs, in case the
      // backfill above silently skipped them.
      try {
        await stripeSync.syncProducts();
        await stripeSync.syncPrices();
      } catch (err: any) {
        logger.error({ message: err?.message ?? String(err) }, "Stripe products/prices sync error");
      }
    })();
    logger.info("Stripe initialized.");
  } catch (err: any) {
    logger.error({ message: err?.message ?? String(err) }, "Stripe initialization failed");
  }
}
