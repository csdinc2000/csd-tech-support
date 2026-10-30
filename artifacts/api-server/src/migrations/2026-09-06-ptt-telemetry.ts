import { pool } from "../db";

export async function applyPttTelemetryMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ptt_rtc_telemetry (
      id BIGSERIAL PRIMARY KEY,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      channel_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('connected', 'failed')),
      path TEXT NOT NULL CHECK (path IN ('relay', 'direct', 'unknown')),
      failure_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS ptt_rtc_telemetry_recorded_at_idx
      ON ptt_rtc_telemetry (recorded_at DESC);
    CREATE INDEX IF NOT EXISTS ptt_rtc_telemetry_channel_recorded_idx
      ON ptt_rtc_telemetry (channel_id, recorded_at DESC);
  `);
}