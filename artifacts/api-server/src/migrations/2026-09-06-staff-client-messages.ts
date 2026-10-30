import { pool } from "../db";

const SQL = `
CREATE TABLE IF NOT EXISTS staff_dispatch_recipients (
  id SERIAL PRIMARY KEY,
  display_name TEXT NOT NULL,
  recipient_role TEXT NOT NULL DEFAULT 'staff',
  phone TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  on_duty BOOLEAN NOT NULL DEFAULT TRUE,
  receive_calls BOOLEAN NOT NULL DEFAULT FALSE,
  receive_messages BOOLEAN NOT NULL DEFAULT TRUE,
  can_use_commands BOOLEAN NOT NULL DEFAULT TRUE,
  linked_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staff_dispatch_client_messages (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  inbound_message_sid TEXT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  recipient_id INTEGER REFERENCES staff_dispatch_recipients(id) ON DELETE SET NULL,
  recipient_phone TEXT NOT NULL,
  requester_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed')),
  provider_message_sid TEXT,
  error TEXT,
  history_saved BOOLEAN NOT NULL DEFAULT FALSE,
  ticket_message_id INTEGER REFERENCES ticket_messages(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE staff_dispatch_client_messages
  ADD COLUMN IF NOT EXISTS ticket_message_id INTEGER REFERENCES ticket_messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS staff_dispatch_client_messages_ticket_idx
  ON staff_dispatch_client_messages(ticket_id, created_at DESC);
`;

export async function applyStaffClientMessagesMigration(): Promise<void> {
  await pool.query(SQL);
}