import { pool } from "../db";

const SQL = `
CREATE TABLE IF NOT EXISTS intake_submissions (
  submission_id UUID PRIMARY KEY,
  payload_fingerprint TEXT NOT NULL,
  contact_id INTEGER REFERENCES crm_contacts(id),
  contact_status TEXT NOT NULL CHECK (contact_status IN ('created', 'reused', 'identity_review')),
  client_id INTEGER REFERENCES clients(id),
  client_status TEXT NOT NULL DEFAULT 'unlinked'
    CHECK (client_status IN ('created', 'reused', 'identity_review', 'unlinked')),
  intake_record_id INTEGER REFERENCES csd_intake_records(id),
  job_id INTEGER REFERENCES crm_jobs(id),
  ticket_id INTEGER REFERENCES tickets(id),
  dispatch_state TEXT NOT NULL DEFAULT 'pending',
  dispatch_error TEXT,
  lead_id INTEGER REFERENCES crm_leads(id),
  deal_id INTEGER REFERENCES crm_deals(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE intake_submissions ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id);
ALTER TABLE intake_submissions ADD COLUMN IF NOT EXISTS client_status TEXT NOT NULL DEFAULT 'unlinked';
ALTER TABLE intake_submissions ADD COLUMN IF NOT EXISTS intake_record_id INTEGER REFERENCES csd_intake_records(id);
ALTER TABLE intake_submissions ADD COLUMN IF NOT EXISTS job_id INTEGER REFERENCES crm_jobs(id);
ALTER TABLE intake_submissions ADD COLUMN IF NOT EXISTS ticket_id INTEGER REFERENCES tickets(id);
ALTER TABLE intake_submissions ADD COLUMN IF NOT EXISTS dispatch_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE intake_submissions ADD COLUMN IF NOT EXISTS dispatch_error TEXT;
`;

export async function applyIntakeIdempotencyMigration() {
  await pool.query(SQL);
}