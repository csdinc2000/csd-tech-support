/**
 * Idempotent migration: patch-management tables + helpdesk_integrations
 * syncedTicketsCount column. Runs at boot from server/index.ts.
 */
import { pool } from "../db";

const SQL = `
ALTER TABLE helpdesk_integrations
  ADD COLUMN IF NOT EXISTS synced_tickets_count INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS patch_policies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  auto_install BOOLEAN DEFAULT FALSE,
  maintenance_window TEXT DEFAULT '02:00-06:00',
  severity_filter TEXT DEFAULT 'critical,important',
  exclude_patches TEXT DEFAULT '',
  test_group_percentage INTEGER DEFAULT 10,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_patches (
  id SERIAL PRIMARY KEY,
  device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
  kb_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT DEFAULT 'moderate',
  category TEXT DEFAULT 'security',
  size_bytes INTEGER DEFAULT 0,
  install_time_minutes INTEGER DEFAULT 0,
  requires_reboot BOOLEAN DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'available',
  release_date TIMESTAMP,
  installed_at TIMESTAMP,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_device_patches_device_id ON device_patches(device_id);
CREATE INDEX IF NOT EXISTS idx_device_patches_status ON device_patches(status);

CREATE TABLE IF NOT EXISTS patch_jobs (
  id SERIAL PRIMARY KEY,
  job_type TEXT NOT NULL,
  patch_ids TEXT NOT NULL,
  device_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  scheduled_for TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  progress INTEGER DEFAULT 0,
  error_message TEXT,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_patch_jobs_status ON patch_jobs(status);
`;

export async function applyPatchMgmtMigration() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(SQL);
    await client.query("COMMIT");
    console.log("✓ Patch-management migration applied");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("✗ Patch-management migration failed:", err);
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1]?.endsWith("2026-06-09-patch-mgmt.ts")) {
  applyPatchMgmtMigration()
    .then(() => pool.end())
    .catch(() => {
      pool.end();
      process.exit(1);
    });
}
