import { pool } from "../db";

// Customer referral program.
//  - referral_program_settings: one row; the rewards and terms customers see.
//  - referrers: customers who joined. No accounts — each gets an emailed
//    dashboard link (token hashed at rest, same model as marketplace sellers).
//  - referrals: one row per service request that arrived with a referral code.
export async function applyReferralsMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referral_program_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      referrer_reward TEXT NOT NULL DEFAULT '$25 service credit',
      friend_reward TEXT NOT NULL DEFAULT '$10 off your first repair',
      terms TEXT NOT NULL DEFAULT 'Your reward is issued after your friend''s first paid service is completed. Friends must be new customers. One reward per new customer; you cannot refer yourself. Rewards have no cash value and may change at any time.',
      updated_by_user_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO referral_program_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS referrers (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
      token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
      enrolled_by_user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS referrers_email_key ON referrers (email);

    CREATE TABLE IF NOT EXISTS referrals (
      id SERIAL PRIMARY KEY,
      referrer_id INTEGER NOT NULL REFERENCES referrers(id) ON DELETE CASCADE,
      intake_record_id INTEGER UNIQUE REFERENCES csd_intake_records(id) ON DELETE SET NULL,
      lead_id INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL,
      contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
      friend_name TEXT NOT NULL,
      friend_email TEXT,
      friend_phone TEXT,
      -- The intake matched a contact that already existed: likely not a new customer.
      existing_customer BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'qualified', 'rewarded', 'declined')),
      staff_note TEXT,
      qualified_at TIMESTAMPTZ,
      rewarded_at TIMESTAMPTZ,
      reviewed_by_user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals (referrer_id, created_at DESC);
  `);
}
