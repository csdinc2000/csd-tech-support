import { pool } from "../db";

export async function applySlackNotificationOutboxMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slack_notification_outbox (
      id bigserial PRIMARY KEY,
      dedupe_key text NOT NULL UNIQUE,
      notification_type text NOT NULL CHECK (notification_type IN (
        'ticket', 'intake', 'call', 'device_alert', 'emergency', 'automation', 'meeting'
      )),
      payload jsonb,
      emergency_alert_id integer REFERENCES alerts(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'processing', 'retry', 'delivered', 'failed'
      )),
      attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_error_category text CHECK (last_error_category IS NULL OR last_error_category IN (
        'not_configured', 'http_error', 'slack_error', 'transport_error', 'timeout'
      )),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (status IN ('delivered', 'failed') OR payload IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS slack_notification_outbox_ready_idx
      ON slack_notification_outbox (status, next_attempt_at, id);
    CREATE INDEX IF NOT EXISTS slack_notification_outbox_emergency_idx
      ON slack_notification_outbox (emergency_alert_id, created_at)
      WHERE emergency_alert_id IS NOT NULL;
    ALTER TABLE slack_notification_outbox
      ADD COLUMN IF NOT EXISTS retry_of_id bigint REFERENCES slack_notification_outbox(id),
      ADD COLUMN IF NOT EXISTS retry_requested_by text,
      ADD COLUMN IF NOT EXISTS retry_requested_at timestamptz;
    CREATE UNIQUE INDEX IF NOT EXISTS slack_notification_outbox_retry_of_idx
      ON slack_notification_outbox (retry_of_id) WHERE retry_of_id IS NOT NULL;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'slack_notification_outbox'::regclass
          AND conname = 'slack_notification_outbox_notification_type_check'
          AND pg_get_constraintdef(oid) LIKE '%automation%'
          AND pg_get_constraintdef(oid) LIKE '%meeting%'
      ) THEN
        ALTER TABLE slack_notification_outbox
          DROP CONSTRAINT IF EXISTS slack_notification_outbox_notification_type_check;
        ALTER TABLE slack_notification_outbox
          ADD CONSTRAINT slack_notification_outbox_notification_type_check
          CHECK (notification_type IN (
            'ticket', 'intake', 'call', 'device_alert', 'emergency', 'automation', 'meeting'
          ));
      END IF;
    END $$;
  `);
}