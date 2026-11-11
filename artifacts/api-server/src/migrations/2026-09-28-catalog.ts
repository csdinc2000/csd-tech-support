import { pool } from "../db";

export async function applyCatalogMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS catalog_inquiries (
      id UUID PRIMARY KEY,
      stripe_product_id TEXT NOT NULL,
      offer_name TEXT NOT NULL,
      unit_amount_cents INTEGER NOT NULL,
      requester_name TEXT NOT NULL,
      requester_email TEXT NOT NULL,
      requester_phone TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      crm_contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
      crm_interaction_id INTEGER REFERENCES crm_interactions(id) ON DELETE SET NULL,
      invoice_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE catalog_inquiries ADD COLUMN IF NOT EXISTS crm_interaction_id INTEGER REFERENCES crm_interactions(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE catalog_inquiries ADD COLUMN IF NOT EXISTS invoice_id INTEGER`);
  await pool.query(`CREATE INDEX IF NOT EXISTS catalog_inquiries_contact_idx ON catalog_inquiries (crm_contact_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS catalog_inquiries_created_idx ON catalog_inquiries (created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS catalog_inquiries_invoice_idx ON catalog_inquiries (invoice_id) WHERE invoice_id IS NOT NULL`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS catalog_purchases (
      id UUID PRIMARY KEY,
      stripe_checkout_session_id TEXT UNIQUE,
      stripe_product_id TEXT NOT NULL,
      stripe_price_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'paid', 'expired', 'failed', 'checkout_failed')),
      customer_email TEXT,
      customer_name TEXT,
      amount_total_cents INTEGER,
      currency TEXT,
      crm_contact_id INTEGER,
      crm_account_id INTEGER,
      paid_at TIMESTAMPTZ,
      reconciliation_attempts BIGINT NOT NULL DEFAULT 0,
      last_reconciled_at TIMESTAMPTZ,
      next_reconcile_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE catalog_purchases
      ADD COLUMN IF NOT EXISTS reconciliation_attempts BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS next_reconcile_at TIMESTAMPTZ DEFAULT NOW()
  `);
  await pool.query(`
    ALTER TABLE catalog_purchases
      ALTER COLUMN reconciliation_attempts TYPE BIGINT
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS catalog_purchases_created_at_idx
      ON catalog_purchases (created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS catalog_purchases_status_idx
      ON catalog_purchases (status, created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS catalog_purchases_reconciliation_idx
      ON catalog_purchases (next_reconcile_at, created_at)
      WHERE status IN ('pending', 'failed', 'expired')
        AND stripe_checkout_session_id IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS catalog_purchases_reconciliation_all_idx
      ON catalog_purchases (next_reconcile_at, created_at)
      WHERE status <> 'paid' AND stripe_checkout_session_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE catalog_purchases
       SET next_reconcile_at=NOW()
     WHERE status <> 'paid'
       AND stripe_checkout_session_id IS NOT NULL
       AND next_reconcile_at IS NULL
  `);
}

/**
 * Invoices are initialized by ensureInvoiceSchema during route registration,
 * after the catalog tables are created during startup. Install this FK only
 * after that schema exists.
 */
export async function applyCatalogInvoiceLinkMigration(): Promise<void> {
  await pool.query(`ALTER TABLE catalog_inquiries ADD COLUMN IF NOT EXISTS invoice_id INTEGER`);
  await pool.query(`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'catalog_inquiries_invoice_id_fkey'
           AND conrelid = 'catalog_inquiries'::regclass
      ) THEN
        ALTER TABLE catalog_inquiries
          ADD CONSTRAINT catalog_inquiries_invoice_id_fkey
          FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;
      END IF;
    END
    $migration$;
  `);
}