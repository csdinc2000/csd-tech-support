import { pool } from "../db";

export async function applyCommunicationEmailMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS communication_email_send_attempts (
      id BIGSERIAL PRIMARY KEY,
      request_id UUID NOT NULL,
      sender_id TEXT NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      recipient_count INTEGER NOT NULL CHECK (recipient_count BETWEEN 1 AND 20),
      provider TEXT NOT NULL CHECK (provider IN ('smtp', 'sendgrid')),
      message_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('submitting', 'accepted', 'rejected', 'unknown')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (sender_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS communication_email_attempts_history_idx
      ON communication_email_send_attempts (sender_id, created_at DESC);
  `);
}
