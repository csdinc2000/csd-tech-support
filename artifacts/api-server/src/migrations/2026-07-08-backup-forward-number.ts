/**
 * Adds the fallback forward-number columns to `twilio_settings` so inbound
 * calls can ring up to three backup numbers before falling through to voicemail.
 * Idempotent — safe to re-run on every boot.
 */
import { pool } from "../db";

export const BACKUP_FORWARD_NUMBER_MIGRATION_SQL = `
ALTER TABLE twilio_settings ADD COLUMN IF NOT EXISTS backup_forward_number text NOT NULL DEFAULT '';
ALTER TABLE twilio_settings ADD COLUMN IF NOT EXISTS backup_forward_number_2 text NOT NULL DEFAULT '';
ALTER TABLE twilio_settings ADD COLUMN IF NOT EXISTS backup_forward_number_3 text NOT NULL DEFAULT '';
`;

export async function applyBackupForwardNumberMigration() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(BACKUP_FORWARD_NUMBER_MIGRATION_SQL);
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
    await applyBackupForwardNumberMigration();
    console.log("✓ Backup forward number migration applied");
  } catch (err) {
    console.error("✗ Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1]?.endsWith("2026-07-08-backup-forward-number.ts") ?? false;
if (isDirectRun) {
  run();
}
