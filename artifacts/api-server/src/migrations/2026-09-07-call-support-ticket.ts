import { pool } from "../db";

const SQL = `
ALTER TABLE call_log
  ADD COLUMN IF NOT EXISTS support_ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS call_log_support_ticket_idx
  ON call_log(support_ticket_id)
  WHERE support_ticket_id IS NOT NULL;
`;

export async function applyCallSupportTicketMigration(): Promise<void> {
  await pool.query(SQL);
}
