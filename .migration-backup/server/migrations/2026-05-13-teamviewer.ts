/**
 * Boot migration: add TeamViewer columns to devices and remote_access_sessions.
 * Idempotent — safe to re-run (applied at boot from server/index.ts).
 * Also runnable standalone with: tsx server/migrations/2026-05-13-teamviewer.ts
 */
import { pool } from "../db";

export const TEAMVIEWER_MIGRATION_SQL = `
-- devices: TeamViewer integration columns
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS teamviewer_id TEXT,
  ADD COLUMN IF NOT EXISTS teamviewer_alias TEXT,
  ADD COLUMN IF NOT EXISTS preferred_remote_provider TEXT DEFAULT 'meshcentral';

-- remote_access_sessions: provider, source context, TeamViewer fields
ALTER TABLE remote_access_sessions
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meshcentral',
  ADD COLUMN IF NOT EXISTS teamviewer_session_code TEXT,
  ADD COLUMN IF NOT EXISTS teamviewer_launch_url TEXT,
  ADD COLUMN IF NOT EXISTS source_type TEXT,
  ADD COLUMN IF NOT EXISTS source_id INTEGER;

-- Relax not-null on user_id / client_id so non-interactive launches can persist
ALTER TABLE remote_access_sessions ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE remote_access_sessions ALTER COLUMN client_id DROP NOT NULL;
`;

export async function applyTeamviewerMigration() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(TEAMVIEWER_MIGRATION_SQL);
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
    await applyTeamviewerMigration();
    console.log("✓ TeamViewer migration applied");
  } catch (err) {
    console.error("✗ Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1]?.endsWith("2026-05-13-teamviewer.ts") ?? false;
if (isDirectRun) {
  run();
}
