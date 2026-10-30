/**
 * One-shot migration: add Stripe billing columns to auth_users.
 * Idempotent — safe to re-run.
 * Run with: tsx server/migrations/2026-05-13-billing.ts
 */
import { pool } from "../db";

export const BILLING_MIGRATION_SQL = `
ALTER TABLE auth_users
  ADD COLUMN IF NOT EXISTS stripe_customer_id varchar,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id varchar;
`;

export async function applyBillingMigration() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(BILLING_MIGRATION_SQL);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function run() {
  try {
    await applyBillingMigration();
    console.log("✓ Billing migration applied");
  } catch (err) {
    console.error("✗ Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1]?.endsWith("2026-05-13-billing.ts") ?? false;
if (isDirectRun) {
  run();
}
