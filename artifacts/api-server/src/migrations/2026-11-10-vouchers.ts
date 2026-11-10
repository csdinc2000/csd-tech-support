import { pool } from "../db";

// Discount vouchers staff email to customers. One row per voucher; each is
// single-use. `percent_off` stays editable while the voucher is active (the
// code doesn't encode it), and expiry is a calendar date in business time.
export async function applyVouchersMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vouchers (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      percent_off INTEGER NOT NULL CHECK (percent_off BETWEEN 1 AND 100),
      max_discount_cents INTEGER CHECK (max_discount_cents IS NULL OR max_discount_cents > 0),
      expires_on DATE,
      recipient_name TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'redeemed', 'void')),
      redeemed_at TIMESTAMPTZ,
      redemption_note TEXT,
      redeemed_by_user_id TEXT,
      last_emailed_at TIMESTAMPTZ,
      email_count INTEGER NOT NULL DEFAULT 0,
      created_by_user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS vouchers_created_idx ON vouchers (created_at DESC);
    CREATE INDEX IF NOT EXISTS vouchers_email_idx ON vouchers (LOWER(recipient_email));
  `);
}
