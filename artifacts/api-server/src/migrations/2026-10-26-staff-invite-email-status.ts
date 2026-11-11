import { pool } from "../db";

export async function applyStaffInviteEmailStatusMigration(): Promise<void> {
  await pool.query(`
    ALTER TABLE staff_invites
      ADD COLUMN IF NOT EXISTS email_delivery_status text,
      ADD COLUMN IF NOT EXISTS email_delivery_at timestamptz,
      ADD COLUMN IF NOT EXISTS email_provider_event_at timestamptz;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'staff_invites_email_delivery_status_check'
      ) THEN
        ALTER TABLE staff_invites
          ADD CONSTRAINT staff_invites_email_delivery_status_check
          CHECK (
            email_delivery_status IS NULL OR
            email_delivery_status IN ('pending', 'accepted', 'delivered', 'bounced', 'failed')
          );
      END IF;
    END
    $$;
  `);
}
