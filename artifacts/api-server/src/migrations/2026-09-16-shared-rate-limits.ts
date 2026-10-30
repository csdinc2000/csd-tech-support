import { pool } from "../db";

export async function applySharedRateLimitsMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shared_rate_limits (
      rate_key text PRIMARY KEY,
      hit_count integer NOT NULL CHECK (hit_count > 0),
      reset_at timestamptz NOT NULL
    );

    CREATE INDEX IF NOT EXISTS shared_rate_limits_reset_at_idx
      ON shared_rate_limits (reset_at)
  `);
}