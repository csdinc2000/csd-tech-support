import { pool } from "../db";
import { applyStaffInviteEmailStatusMigration } from "./2026-10-26-staff-invite-email-status";

export async function applyStaffInvitesMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_invites (
      id BIGSERIAL PRIMARY KEY,
      email VARCHAR(320) NOT NULL,
      role VARCHAR NOT NULL,
      token_hash VARCHAR(64) NOT NULL UNIQUE,
      invited_by VARCHAR REFERENCES auth_users(id) ON DELETE SET NULL,
      accepted_by VARCHAR REFERENCES auth_users(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT staff_invites_role_check CHECK (role IN (
        'administrator', 'field_technician', 'software_developer', 'accounting',
        'it_manager', 'legal_team', 'secretary'
      )),
      CONSTRAINT staff_invites_terminal_state_check CHECK (
        accepted_at IS NULL OR revoked_at IS NULL
      )
    );

    CREATE INDEX IF NOT EXISTS staff_invites_email_created_idx
      ON staff_invites (LOWER(email), created_at DESC);
    CREATE INDEX IF NOT EXISTS staff_invites_pending_idx
      ON staff_invites (expires_at)
      WHERE accepted_at IS NULL AND revoked_at IS NULL;

    -- An invited, verified Clerk identity may need to use a pre-existing
    -- local account without rewriting its historical foreign-key references.
    CREATE TABLE IF NOT EXISTS auth_user_clerk_links (
      clerk_user_id VARCHAR PRIMARY KEY,
      auth_user_id VARCHAR NOT NULL UNIQUE REFERENCES auth_users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS staff_helpdesk_links (
      auth_user_id VARCHAR PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
      helpdesk_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      created_by VARCHAR REFERENCES auth_users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Remove only identityless access profiles, not accounts, tickets, or history.
    -- These were created by the former list-on-read backfill without an invite.
    WITH removed AS (
      DELETE FROM staff_access_profiles p
      USING auth_users u
      WHERE p.user_id = u.id
        AND NULLIF(TRIM(u.email), '') IS NULL
        AND NULLIF(TRIM(u.first_name), '') IS NULL
        AND NULLIF(TRIM(u.last_name), '') IS NULL
      RETURNING p.user_id, p.role, p.approval_status
    )
    INSERT INTO staff_access_audit
      (target_user_id, actor_user_id, action, previous_access, new_access)
    SELECT user_id, NULL, 'unnamed_profile_removed',
      jsonb_build_object('role', role, 'approval_status', approval_status),
      '{}'::jsonb
    FROM removed;
  `);
  await applyStaffInviteEmailStatusMigration();
}