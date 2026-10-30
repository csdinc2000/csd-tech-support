import { pool } from "../db";

const SQL = `
CREATE TABLE IF NOT EXISTS call_forwarding_outcomes (
  id SERIAL PRIMARY KEY,
  parent_call_sid TEXT NOT NULL,
  child_call_sid TEXT NOT NULL UNIQUE,
  attempt_key TEXT NOT NULL CHECK (attempt_key IN ('primary', 'backup1', 'backup2', 'tracking', 'staff')),
  destination_number TEXT NOT NULL,
  provider_status TEXT NOT NULL,
  human_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  provider_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS call_forwarding_outcomes_parent_idx
  ON call_forwarding_outcomes(parent_call_sid, created_at);
`;

export async function applyCallForwardingOutcomesMigration(): Promise<void> {
  await pool.query(SQL);
}
