import Stripe from 'stripe';
import { StripeSync } from 'stripe-replit-sync';
import { pool } from "./db";

/** The subset of Replit's connector API response this module reads. */
interface ReplitConnectionResponse {
  items?: Array<{
    settings?: { secret?: string; secret_key?: string; webhook_secret?: string };
  }>;
}


async function getStripeCredentials(): Promise<{ secretKey: string; webhookSecret?: string }> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!hostname || !xReplitToken) {
    throw new Error(
      'Missing Replit environment variables. ' +
      'Ensure the Stripe integration is connected via the Integrations tab.'
    );
  }

  const isProduction = process.env.REPLIT_DEPLOYMENT === "1";
  const targetEnvironment = isProduction ? "production" : "development";

  const url = new URL(`https://${hostname}/api/v2/connection`);
  url.searchParams.set("include_secrets", "true");
  url.searchParams.set("connector_names", "stripe");
  url.searchParams.set("environment", targetEnvironment);

  const resp = await fetch(url.toString(), {
    headers: { Accept: "application/json", "X-Replit-Token": xReplitToken },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch Stripe credentials: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as ReplitConnectionResponse;
  const settings = data.items?.[0]?.settings;

  const secretKey = settings?.secret ?? settings?.secret_key;
  if (!secretKey) {
    throw new Error(
      'Stripe integration not connected or missing secret key. ' +
      'Connect Stripe via the Integrations tab first.'
    );
  }

  return {
    secretKey,
    webhookSecret: settings?.webhook_secret,
  };
}

export async function getUncachableStripeClient(): Promise<Stripe> {
  const { secretKey } = await getStripeCredentials();
  return new Stripe(secretKey);
}

export async function getStripeWebhookSecret(): Promise<string> {
  const { webhookSecret } = await getStripeCredentials();
  if (webhookSecret) return webhookSecret;

  const result = await pool.query(
    `SELECT secret
       FROM "stripe"."_managed_webhooks"
      ORDER BY created DESC
      LIMIT 1`,
  );
  const managedSecret = result.rows[0]?.secret;
  if (typeof managedSecret === "string" && managedSecret) {
    return managedSecret;
  }
  throw new Error(
    "Stripe webhook signing secret is unavailable. Start the API server once so the managed webhook can be configured.",
  );
}

export async function getStripeSync(): Promise<StripeSync> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const { secretKey, webhookSecret } = await getStripeCredentials();
  return new StripeSync({
    poolConfig: { connectionString: databaseUrl },
    stripeSecretKey: secretKey,
    stripeWebhookSecret: webhookSecret ?? '',
  });
}

export async function isStripeConfigured(): Promise<boolean> {
  try {
    await getStripeCredentials();
    return true;
  } catch {
    return false;
  }
}
