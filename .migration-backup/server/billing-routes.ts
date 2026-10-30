import type { Express, Request, Response } from "express";
import { sql, eq } from "drizzle-orm";
import { db } from "./db";
import { authUsers } from "@shared/models/auth";
import { getUncachableStripeClient, isStripeConfigured } from "./stripeClient";
import { isAuthenticated } from "./replit_integrations/auth";

function getAppBaseUrl(req: Request): string {
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0];
  if (domain) return `https://${domain}`;
  return `${req.protocol}://${req.get("host")}`;
}

async function getOrCreateCustomerId(userId: string, email: string | null | undefined): Promise<string> {
  const [user] = await db.select().from(authUsers).where(eq(authUsers.id, userId));
  if (user?.stripeCustomerId) return user.stripeCustomerId;

  const stripe = await getUncachableStripeClient();
  const customer = await stripe.customers.create({
    email: email ?? undefined,
    metadata: { userId },
  });
  await db
    .update(authUsers)
    .set({ stripeCustomerId: customer.id })
    .where(eq(authUsers.id, userId));
  return customer.id;
}

export function registerBillingRoutes(app: Express) {
  // Status: is Stripe connected at all
  app.get("/api/billing/status", async (_req, res) => {
    const configured = await isStripeConfigured();
    res.json({ configured });
  });

  // List products + prices (the available plans)
  app.get("/api/billing/plans", async (_req, res) => {
    try {
      if (!(await isStripeConfigured())) {
        return res.json({ configured: false, plans: [] });
      }
      const result = await db.execute(sql`
        SELECT
          p.id as product_id,
          p.name as product_name,
          p.description as product_description,
          p.metadata as product_metadata,
          pr.id as price_id,
          pr.unit_amount,
          pr.currency,
          pr.recurring,
          pr.active as price_active
        FROM stripe.products p
        LEFT JOIN stripe.prices pr ON pr.product = p.id AND pr.active = true
        WHERE p.active = true
        ORDER BY pr.unit_amount NULLS LAST
      `);
      const map = new Map<string, any>();
      for (const row of result.rows as any[]) {
        if (!map.has(row.product_id)) {
          map.set(row.product_id, {
            id: row.product_id,
            name: row.product_name,
            description: row.product_description,
            metadata: row.product_metadata ?? {},
            prices: [],
          });
        }
        if (row.price_id) {
          map.get(row.product_id).prices.push({
            id: row.price_id,
            unit_amount: row.unit_amount,
            currency: row.currency,
            recurring: row.recurring,
          });
        }
      }
      res.json({ configured: true, plans: Array.from(map.values()) });
    } catch (e: any) {
      console.error("Failed to list plans:", e);
      res.status(500).json({ error: e.message ?? "Failed to list plans" });
    }
  });

  // Current user subscription
  app.get("/api/billing/subscription", isAuthenticated, async (req: any, res) => {
    try {
      if (!(await isStripeConfigured())) {
        return res.json({ configured: false, subscription: null });
      }
      const userId = req.user.claims.sub;
      const [user] = await db.select().from(authUsers).where(eq(authUsers.id, userId));
      if (!user) return res.status(404).json({ error: "User not found" });

      // Try to find an active subscription via the customer id
      let customerId = user.stripeCustomerId;
      if (!customerId) {
        return res.json({ configured: true, subscription: null });
      }

      const subResult = await db.execute(sql`
        SELECT s.*, pr.unit_amount, pr.currency, pr.recurring,
               p.id as product_id, p.name as product_name, p.description as product_description
        FROM stripe.subscriptions s
        LEFT JOIN stripe.prices pr ON pr.id = s.price
        LEFT JOIN stripe.products p ON p.id = pr.product
        WHERE s.customer = ${customerId}
          AND s.status IN ('active', 'trialing', 'past_due')
        ORDER BY s.created DESC
        LIMIT 1
      `);
      const row = (subResult.rows as any[])[0];
      if (!row) return res.json({ configured: true, subscription: null });

      // Persist latest subscription id
      if (user.stripeSubscriptionId !== row.id) {
        await db
          .update(authUsers)
          .set({ stripeSubscriptionId: row.id })
          .where(eq(authUsers.id, userId));
      }

      res.json({
        configured: true,
        subscription: {
          id: row.id,
          status: row.status,
          currentPeriodEnd: row.current_period_end ?? row.currentperiodend ?? null,
          cancelAtPeriodEnd: row.cancel_at_period_end ?? row.cancelatperiodend ?? false,
          priceId: row.price,
          unitAmount: row.unit_amount,
          currency: row.currency,
          recurring: row.recurring,
          product: row.product_id
            ? {
                id: row.product_id,
                name: row.product_name,
                description: row.product_description,
              }
            : null,
        },
      });
    } catch (e: any) {
      console.error("Failed to load subscription:", e);
      res.status(500).json({ error: e.message ?? "Failed to load subscription" });
    }
  });

  // Invoices for the current user
  app.get("/api/billing/invoices", isAuthenticated, async (req: any, res) => {
    try {
      if (!(await isStripeConfigured())) {
        return res.json({ configured: false, invoices: [] });
      }
      const userId = req.user.claims.sub;
      const [user] = await db.select().from(authUsers).where(eq(authUsers.id, userId));
      if (!user?.stripeCustomerId) {
        return res.json({ configured: true, invoices: [] });
      }

      // Try local cache first
      const local = await db.execute(sql`
        SELECT id, number, status, amount_paid, amount_due, currency,
               created, hosted_invoice_url, invoice_pdf
        FROM stripe.invoices
        WHERE customer = ${user.stripeCustomerId}
        ORDER BY created DESC
        LIMIT 50
      `);
      let invoices = (local.rows as any[]).map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        amount: r.amount_paid ?? r.amount_due,
        currency: r.currency,
        created: r.created,
        hostedUrl: r.hosted_invoice_url,
        pdfUrl: r.invoice_pdf,
      }));

      // Fallback to live Stripe API if synced data is empty
      if (invoices.length === 0) {
        const stripe = await getUncachableStripeClient();
        const list = await stripe.invoices.list({
          customer: user.stripeCustomerId,
          limit: 50,
        });
        invoices = list.data.map((inv) => ({
          id: inv.id,
          number: inv.number,
          status: inv.status,
          amount: inv.amount_paid || inv.amount_due,
          currency: inv.currency,
          created: inv.created,
          hostedUrl: inv.hosted_invoice_url,
          pdfUrl: inv.invoice_pdf,
        }));
      }

      res.json({ configured: true, invoices });
    } catch (e: any) {
      console.error("Failed to load invoices:", e);
      res.status(500).json({ error: e.message ?? "Failed to load invoices" });
    }
  });

  // Start checkout for a price
  app.post("/api/billing/checkout", isAuthenticated, async (req: any, res) => {
    try {
      if (!(await isStripeConfigured())) {
        return res.status(400).json({ error: "Stripe is not configured" });
      }
      const { priceId } = req.body ?? {};
      if (!priceId || typeof priceId !== "string") {
        return res.status(400).json({ error: "priceId required" });
      }

      // Validate priceId is one of our active synced prices
      const priceCheck = await db.execute(sql`
        SELECT pr.id FROM stripe.prices pr
        JOIN stripe.products p ON p.id = pr.product
        WHERE pr.id = ${priceId} AND pr.active = true AND p.active = true
        LIMIT 1
      `);
      if ((priceCheck.rows as any[]).length === 0) {
        return res.status(400).json({ error: "Unknown or inactive price" });
      }

      const userId = req.user.claims.sub;
      const [user] = await db.select().from(authUsers).where(eq(authUsers.id, userId));
      if (!user) return res.status(404).json({ error: "User not found" });

      const customerId = await getOrCreateCustomerId(userId, user.email);
      const stripe = await getUncachableStripeClient();
      const baseUrl = getAppBaseUrl(req);
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${baseUrl}/billing?checkout=success`,
        cancel_url: `${baseUrl}/billing?checkout=cancelled`,
      });
      res.json({ url: session.url });
    } catch (e: any) {
      console.error("Checkout failed:", e);
      res.status(500).json({ error: e.message ?? "Checkout failed" });
    }
  });

  // Open Stripe customer billing portal
  app.post("/api/billing/portal", isAuthenticated, async (req: any, res) => {
    try {
      if (!(await isStripeConfigured())) {
        return res.status(400).json({ error: "Stripe is not configured" });
      }
      const userId = req.user.claims.sub;
      const [user] = await db.select().from(authUsers).where(eq(authUsers.id, userId));
      if (!user) return res.status(404).json({ error: "User not found" });

      const customerId = await getOrCreateCustomerId(userId, user.email);
      const stripe = await getUncachableStripeClient();
      const baseUrl = getAppBaseUrl(req);
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${baseUrl}/billing`,
      });
      res.json({ url: session.url });
    } catch (e: any) {
      console.error("Portal failed:", e);
      res.status(500).json({ error: e.message ?? "Portal failed" });
    }
  });
}
