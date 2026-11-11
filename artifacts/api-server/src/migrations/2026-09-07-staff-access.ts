import { pool } from "../db";

export async function applyStaffAccessMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_access_profiles (
      user_id VARCHAR PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
      role VARCHAR NOT NULL DEFAULT 'technician',
      can_view_voicemails BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT staff_access_profiles_role_check CHECK (role IN ('staff', 'technician'))
    );

    CREATE TABLE IF NOT EXISTS staff_directory_details (
      user_id VARCHAR PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
      phone VARCHAR(32),
      job_title VARCHAR(100),
      department VARCHAR(100),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE staff_access_profiles
      ADD COLUMN IF NOT EXISTS approval_status VARCHAR,
      ADD COLUMN IF NOT EXISTS feature_permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS approved_by VARCHAR;

    UPDATE staff_access_profiles
      SET approval_status = 'approved', approved_at = COALESCE(approved_at, NOW())
      WHERE approval_status IS NULL;

    ALTER TABLE staff_access_profiles
      ALTER COLUMN approval_status SET DEFAULT 'pending',
      ALTER COLUMN approval_status SET NOT NULL;

    ALTER TABLE staff_access_profiles
      DROP CONSTRAINT IF EXISTS staff_access_profiles_role_check;

    UPDATE staff_access_profiles SET role = CASE role
      WHEN 'admin' THEN 'administrator'
      WHEN 'manager' THEN 'it_manager'
      WHEN 'staff' THEN 'secretary'
      WHEN 'technician' THEN 'field_technician'
      WHEN 'viewer' THEN 'legal_team'
      ELSE role
    END;

    ALTER TABLE staff_access_profiles
      ALTER COLUMN role SET DEFAULT 'field_technician';
    ALTER TABLE staff_access_profiles
      ADD CONSTRAINT staff_access_profiles_role_check
      CHECK (role IN (
        'administrator', 'field_technician', 'software_developer', 'accounting',
        'it_manager', 'legal_team', 'secretary'
      ));

    ALTER TABLE staff_access_profiles
      DROP CONSTRAINT IF EXISTS staff_access_profiles_approval_check;
    ALTER TABLE staff_access_profiles
      ADD CONSTRAINT staff_access_profiles_approval_check
      CHECK (approval_status IN ('pending', 'approved', 'suspended'));

    CREATE TABLE IF NOT EXISTS staff_access_audit (
      id BIGSERIAL PRIMARY KEY,
      target_user_id VARCHAR NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      actor_user_id VARCHAR REFERENCES auth_users(id) ON DELETE SET NULL,
      action VARCHAR NOT NULL DEFAULT 'access_updated',
      previous_access JSONB NOT NULL,
      new_access JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS staff_access_audit_target_idx
      ON staff_access_audit (target_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS staff_access_audit_created_idx
      ON staff_access_audit (created_at DESC);

    CREATE TABLE IF NOT EXISTS staff_client_assignments (
      user_id VARCHAR NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      assigned_by VARCHAR REFERENCES auth_users(id) ON DELETE SET NULL,
      PRIMARY KEY (user_id, client_id)
    );
    CREATE INDEX IF NOT EXISTS staff_client_assignments_client_idx
      ON staff_client_assignments (client_id, user_id);

    CREATE TABLE IF NOT EXISTS staff_job_assignments (
      user_id VARCHAR NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL REFERENCES crm_jobs(id) ON DELETE CASCADE,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      assigned_by VARCHAR REFERENCES auth_users(id) ON DELETE SET NULL,
      PRIMARY KEY (user_id, job_id)
    );
    CREATE INDEX IF NOT EXISTS staff_job_assignments_job_idx
      ON staff_job_assignments (job_id, user_id);

    CREATE TABLE IF NOT EXISTS staff_contact_assignments (
      user_id VARCHAR NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      contact_id INTEGER NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
      can_edit BOOLEAN NOT NULL DEFAULT FALSE,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      assigned_by VARCHAR REFERENCES auth_users(id) ON DELETE SET NULL,
      PRIMARY KEY (user_id, contact_id)
    );
    CREATE INDEX IF NOT EXISTS staff_contact_assignments_contact_idx
      ON staff_contact_assignments (contact_id, user_id);
  `);
}