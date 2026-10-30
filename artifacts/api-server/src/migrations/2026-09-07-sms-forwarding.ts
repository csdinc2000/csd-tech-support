import { pool } from "../db";

const SQL = `
ALTER TABLE twilio_settings
  ADD COLUMN IF NOT EXISTS sms_forward_numbers TEXT;

CREATE TABLE IF NOT EXISTS sms_forward_deliveries (
  id SERIAL PRIMARY KEY,
  inbound_message_sid TEXT NOT NULL,
  target_number TEXT NOT NULL,
  source_number TEXT NOT NULL,
  business_number TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_message_sid TEXT,
  last_error TEXT,
  next_attempt_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS sms_forward_delivery_message_target_unique
  ON sms_forward_deliveries(inbound_message_sid, target_number);

CREATE INDEX IF NOT EXISTS sms_forward_delivery_retry_idx
  ON sms_forward_deliveries(status, next_attempt_at);

CREATE INDEX IF NOT EXISTS sms_forward_delivery_provider_message_idx
  ON sms_forward_deliveries(provider_message_sid)
  WHERE provider_message_sid IS NOT NULL;

ALTER TABLE sms_forward_deliveries
  DROP CONSTRAINT IF EXISTS sms_forward_deliveries_status_check;
ALTER TABLE sms_forward_deliveries
  ADD CONSTRAINT sms_forward_deliveries_status_check
  CHECK (status IN (
    'pending', 'retry', 'sending', 'queued', 'accepted',
    'scheduled', 'sent', 'delivered', 'undelivered', 'failed',
    'canceled', 'receiving', 'received', 'read', 'partially_delivered'
  ));

ALTER TABLE sms_forward_deliveries
  DROP CONSTRAINT IF EXISTS sms_forward_deliveries_attempts_check;
ALTER TABLE sms_forward_deliveries
  ADD CONSTRAINT sms_forward_deliveries_attempts_check
  CHECK (attempts >= 0);
`;

export async function applySmsForwardingMigration(): Promise<void> {
  await pool.query(SQL);
}