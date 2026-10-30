/**
 * CRM pipeline expansion: adds the `crm_deals` table (sales pipeline with MRR
 * tracking) and links the existing communication tables (tickets, call_log,
 * voicemails) to deals via an `associated_deal_id` column, so a deal can show
 * one 360° interaction timeline. Also creates the partial/composite indexes
 * the pipeline dashboard queries rely on so they stay index-backed as call
 * and ticket volume grows.
 * Idempotent — safe to re-run on every boot.
 */
import { pool } from "../db";

export const CRM_PIPELINE_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS crm_deals (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  company_name TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'lead'
    CONSTRAINT crm_deals_stage_check CHECK (stage IN ('lead', 'discovery', 'proposal', 'won', 'lost')),
  estimated_mrr NUMERIC(10, 2) NOT NULL DEFAULT 0,
  one_time_fee NUMERIC(10, 2) NOT NULL DEFAULT 0,
  primary_contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL,
  assigned_technician_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS associated_deal_id INTEGER REFERENCES crm_deals(id) ON DELETE SET NULL;
ALTER TABLE call_log ADD COLUMN IF NOT EXISTS associated_deal_id INTEGER REFERENCES crm_deals(id) ON DELETE SET NULL;
ALTER TABLE voicemails ADD COLUMN IF NOT EXISTS associated_deal_id INTEGER REFERENCES crm_deals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tickets_associated_deal ON tickets(associated_deal_id) WHERE associated_deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_call_log_associated_deal ON call_log(associated_deal_id) WHERE associated_deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_voicemails_associated_deal ON voicemails(associated_deal_id) WHERE associated_deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_status_open ON tickets(status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_crm_deals_stage_active ON crm_deals(stage) WHERE stage IN ('lead', 'discovery', 'proposal');
CREATE INDEX IF NOT EXISTS idx_crm_deals_won_date ON crm_deals(stage, updated_at) WHERE stage = 'won';
CREATE INDEX IF NOT EXISTS idx_crm_deals_contact_lookup ON crm_deals(primary_contact_id, stage);
`;

export async function applyCrmPipelineMigration() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(CRM_PIPELINE_MIGRATION_SQL);
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
    await applyCrmPipelineMigration();
    console.log("✓ CRM pipeline migration applied");
  } catch (err) {
    console.error("✗ Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1]?.endsWith("2026-07-16-crm-pipeline.ts") ?? false;
if (isDirectRun) {
  run();
}
