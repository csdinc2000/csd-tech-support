import { pool } from "../db";

export async function applyOutboundCallOutcomesMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outbound_call_outcomes (
      call_id UUID PRIMARY KEY,
      user_id TEXT NOT NULL,
      contact_id INTEGER,
      customer_number TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('callback', 'browser')),
      status TEXT NOT NULL,
      parent_call_sid TEXT,
      child_call_sid TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS outbound_call_outcomes_user_created_idx
      ON outbound_call_outcomes (user_id, created_at DESC);
  `);
}
