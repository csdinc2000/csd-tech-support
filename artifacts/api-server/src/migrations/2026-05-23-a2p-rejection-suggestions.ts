/**
 * Adds `a2p_rejection_suggestions` table for staff-submitted plain-English
 * remediation suggestions for Twilio A2P rejection reasons that don't match
 * the curated knowledge base in `client/src/lib/a2p-rejections.ts`.
 * Idempotent — safe to re-run on every boot.
 */
import { pool } from "../db";

export const A2P_REJECTION_SUGGESTIONS_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS a2p_rejection_suggestions (
  id serial PRIMARY KEY,
  reason_text text NOT NULL,
  suggested_title text NOT NULL,
  suggested_remediation text NOT NULL,
  doc_url text,
  submitted_by text,
  status text NOT NULL DEFAULT 'pending',
  reviewer_notes text,
  created_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS a2p_rejection_suggestions_status_idx
  ON a2p_rejection_suggestions(status);
`;

export async function applyA2pRejectionSuggestionsMigration() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(A2P_REJECTION_SUGGESTIONS_MIGRATION_SQL);
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
    await applyA2pRejectionSuggestionsMigration();
    console.log("✓ A2P rejection suggestions migration applied");
  } catch (err) {
    console.error("✗ Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1]?.endsWith("2026-05-23-a2p-rejection-suggestions.ts") ?? false;
if (isDirectRun) {
  run();
}
