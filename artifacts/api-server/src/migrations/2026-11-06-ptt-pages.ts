import { pool } from "../db";

// "Ring" requests from the PTT console: one row per person rung, sharing a
// group_id when several people (or everyone) are rung at once. Stored in the
// database rather than memory so a ring survives a server restart and every
// browser tab polling for it sees the same state.
export async function applyPttPagesMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ptt_pages (
      id BIGSERIAL PRIMARY KEY,
      group_id UUID NOT NULL,
      caller_user_id VARCHAR NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      caller_name TEXT NOT NULL,
      target_user_id VARCHAR NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ringing'
        CHECK (status IN ('ringing', 'answered', 'declined', 'cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      responded_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS ptt_pages_target_ringing_idx
      ON ptt_pages (target_user_id, expires_at) WHERE status = 'ringing';
    CREATE INDEX IF NOT EXISTS ptt_pages_group_idx ON ptt_pages (group_id);
  `);
}
