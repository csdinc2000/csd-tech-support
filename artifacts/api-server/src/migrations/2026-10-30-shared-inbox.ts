import { pool } from "../db";

/**
 * Shared SMS inbox: one conversation per customer number (keyed like the
 * Messages thread list — digits without the US leading 1), with an owner,
 * open/done state, per-staff read markers and team-only notes.
 *
 * `sms_messages.sent_by_*` records which technician sent an outbound text.
 * They are written with raw SQL after the normal insert, so the Drizzle
 * schema (and every existing insert) is unaffected if this migration fails.
 */
export async function applySharedInboxMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sms_conversations (
      id SERIAL PRIMARY KEY,
      thread_key TEXT NOT NULL UNIQUE,
      customer_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
      assigned_user_id VARCHAR REFERENCES auth_users(id) ON DELETE SET NULL,
      assigned_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      closed_by_user_id VARCHAR REFERENCES auth_users(id) ON DELETE SET NULL,
      last_inbound_at TIMESTAMPTZ,
      -- Set when a row is backfilled from existing history so old texts don't
      -- show as unread for every technician on first rollout.
      read_baseline_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS sms_conversations_assignee_idx
      ON sms_conversations (assigned_user_id, status);

    CREATE TABLE IF NOT EXISTS sms_conversation_reads (
      conversation_id INTEGER NOT NULL REFERENCES sms_conversations(id) ON DELETE CASCADE,
      user_id VARCHAR NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (conversation_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS sms_conversation_notes (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES sms_conversations(id) ON DELETE CASCADE,
      author_user_id VARCHAR REFERENCES auth_users(id) ON DELETE SET NULL,
      author_name TEXT NOT NULL,
      body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS sms_conversation_notes_conversation_idx
      ON sms_conversation_notes (conversation_id, created_at);

    ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS sent_by_user_id VARCHAR;
    ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS sent_by_name TEXT;
  `);
}
