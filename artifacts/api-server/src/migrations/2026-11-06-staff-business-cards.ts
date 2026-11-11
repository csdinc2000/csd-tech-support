import { pool } from "../db";

// Digital business cards. One per staff member, reachable publicly only via an
// unguessable token (never the auth_users id). Rotating the token kills old
// links; the card stops resolving when the staff member is not approved.
export async function applyStaffBusinessCardsMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_business_cards (
      user_id VARCHAR PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      headline TEXT,
      show_email BOOLEAN NOT NULL DEFAULT TRUE,
      show_direct_phone BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
