import { pool } from "../db";

// Per-staff choice to have incoming business-line calls ring in the app
// (browser) in addition to forwarded phones.
export async function applyStaffVoicePreferencesMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_voice_preferences (
      user_id VARCHAR PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
      ring_in_app BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
