/**
 * Adds `error_code` to `sms_messages` so the Twilio delivery-status webhook can
 * persist carrier error codes (e.g. 30034 = unregistered A2P sender) and the
 * Messages UI can explain *why* a text failed.
 * Idempotent — safe to re-run on every boot.
 */
import { pool } from "../db";

export const SMS_ERROR_CODE_MIGRATION_SQL = `
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS error_code text;
`;

export async function applySmsErrorCodeMigration() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(SMS_ERROR_CODE_MIGRATION_SQL);
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
    await applySmsErrorCodeMigration();
    console.log("✓ SMS error_code migration applied");
  } catch (err) {
    console.error("✗ Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1]?.endsWith("2026-06-17-sms-error-code.ts") ?? false;
if (isDirectRun) {
  run();
}
