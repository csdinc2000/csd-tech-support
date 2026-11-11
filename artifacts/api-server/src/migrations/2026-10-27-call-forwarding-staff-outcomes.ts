import { pool } from "../db";

export async function applyCallForwardingStaffOutcomesMigration(): Promise<void> {
  await pool.query(`
    ALTER TABLE call_forwarding_outcomes
      DROP CONSTRAINT IF EXISTS call_forwarding_outcomes_attempt_key_check;
    ALTER TABLE call_forwarding_outcomes
      ADD CONSTRAINT call_forwarding_outcomes_attempt_key_check
      CHECK (attempt_key IN ('primary', 'backup1', 'backup2', 'tracking', 'staff'));
  `);
}
