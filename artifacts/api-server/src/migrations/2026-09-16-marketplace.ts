import { pool } from "../db";

export async function applyMarketplaceMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketplace_listings (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('gaming_pc','desktop','laptop','parts','monitor','accessories','other')),
      condition TEXT NOT NULL CHECK (condition IN ('new','like_new','good','fair','for_parts')),
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      specs JSONB NOT NULL DEFAULT '{}'::jsonb,
      location TEXT,
      seller_name TEXT NOT NULL,
      seller_email TEXT NOT NULL,
      seller_phone TEXT,
      show_phone BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','sold','rejected','removed')),
      source TEXT NOT NULL DEFAULT 'portal' CHECK (source IN ('portal','staff')),
      manage_token_hash TEXT NOT NULL UNIQUE,
      created_by_user_id TEXT,
      review_note TEXT,
      reviewed_by_user_id TEXT,
      reviewed_at TIMESTAMPTZ,
      published_at TIMESTAMPTZ,
      sold_at TIMESTAMPTZ,
      view_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS marketplace_listings_status_idx ON marketplace_listings(status, published_at DESC);
    CREATE INDEX IF NOT EXISTS marketplace_listings_seller_email_idx ON marketplace_listings(LOWER(seller_email));

    CREATE TABLE IF NOT EXISTS marketplace_images (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS marketplace_images_listing_idx ON marketplace_images(listing_id, position);

    CREATE TABLE IF NOT EXISTS marketplace_inquiries (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
      buyer_name TEXT NOT NULL,
      buyer_email TEXT NOT NULL,
      buyer_phone TEXT,
      message TEXT NOT NULL,
      ip_address TEXT,
      email_sent BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS marketplace_inquiries_listing_idx ON marketplace_inquiries(listing_id, created_at DESC);
  `);
}
