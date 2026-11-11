import { pool } from "../db";

// Popup ads shown on the customer portal. Images are stored as bytea after
// client-side resize (same approach as marketplace photos). Impression,
// dismissal and click counts are simple counters for the staff list.
export async function applyPortalAdsMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS portal_ads (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      image BYTEA,
      image_mime TEXT,
      image_alt TEXT NOT NULL DEFAULT '',
      link_url TEXT,
      link_label TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
      delay_seconds INTEGER NOT NULL DEFAULT 3 CHECK (delay_seconds BETWEEN 0 AND 120),
      suppress_hours INTEGER NOT NULL DEFAULT 24 CHECK (suppress_hours BETWEEN 0 AND 8760),
      impressions INTEGER NOT NULL DEFAULT 0,
      dismissals INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      created_by_user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
    );
    CREATE INDEX IF NOT EXISTS portal_ads_live_idx ON portal_ads (is_active, priority DESC, created_at DESC);
  `);
}
