import { pool } from "../db";

export async function applyEmailCapacitySettingsMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_capacity_settings (
      id integer PRIMARY KEY CHECK (id = 1),
      warning_mode text NOT NULL DEFAULT 'default'
        CHECK (warning_mode IN ('default', 'percentage', 'remainingCredits')),
      warning_value integer,
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      CHECK (
        (warning_mode = 'default' AND warning_value IS NULL)
        OR (warning_mode = 'percentage' AND warning_value BETWEEN 1 AND 100)
        OR (warning_mode = 'remainingCredits' AND warning_value BETWEEN 1 AND 1000000000)
      )
    );

    CREATE TABLE IF NOT EXISTS email_capacity_settings_audit (
      id bigserial PRIMARY KEY,
      actor_user_id text REFERENCES auth_users(id) ON DELETE SET NULL,
      actor_email text,
      previous_mode text NOT NULL
        CHECK (previous_mode IN ('default', 'percentage', 'remainingCredits')),
      previous_value integer,
      new_mode text NOT NULL
        CHECK (new_mode IN ('default', 'percentage', 'remainingCredits')),
      new_value integer,
      changed_at timestamptz NOT NULL DEFAULT NOW(),
      CHECK (
        (previous_mode = 'default' AND previous_value IS NULL)
        OR (previous_mode = 'percentage' AND previous_value BETWEEN 1 AND 100)
        OR (previous_mode = 'remainingCredits' AND previous_value BETWEEN 1 AND 1000000000)
      ),
      CHECK (
        (new_mode = 'default' AND new_value IS NULL)
        OR (new_mode = 'percentage' AND new_value BETWEEN 1 AND 100)
        OR (new_mode = 'remainingCredits' AND new_value BETWEEN 1 AND 1000000000)
      )
    );

    CREATE INDEX IF NOT EXISTS email_capacity_settings_audit_changed_at_idx
      ON email_capacity_settings_audit (changed_at DESC, id DESC)
  `);
}