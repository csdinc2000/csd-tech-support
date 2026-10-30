import { pool } from "../db";

export async function applySlackDeliveryHealthMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slack_delivery_outcomes (
      id bigserial PRIMARY KEY,
      delivered boolean NOT NULL,
      failure_category text CHECK (
        failure_category IS NULL OR failure_category IN (
          'not_configured', 'http_error', 'slack_error', 'transport_error', 'timeout'
        )
      ),
      attempted_at timestamptz NOT NULL DEFAULT now(),
      CHECK (
        (delivered = true AND failure_category IS NULL)
        OR (delivered = false AND failure_category IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS slack_delivery_outcomes_attempted_at_idx
      ON slack_delivery_outcomes (attempted_at DESC);

    CREATE TABLE IF NOT EXISTS slack_queue_outcomes (
      id bigserial PRIMARY KEY,
      queued boolean NOT NULL,
      failure_category text CHECK (
        failure_category IS NULL OR failure_category IN ('queue_write_failed', 'payload_too_large')
      ),
      attempted_at timestamptz NOT NULL,
      CHECK (
        (queued = true AND failure_category IS NULL)
        OR (queued = false AND failure_category IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS slack_queue_outcomes_attempted_at_idx
      ON slack_queue_outcomes (attempted_at DESC, id DESC)
  `);
}