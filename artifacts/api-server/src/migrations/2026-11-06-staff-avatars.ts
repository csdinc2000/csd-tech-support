import { pool } from "../db";

// Technician / staff profile pictures, stored as bytea like client_avatars
// (autoscale deployments have no persistent disk or object-storage bucket).
// Keyed by the local auth_users identity so the photo follows the staff member.
export async function applyStaffAvatarsMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_avatars (
      user_id VARCHAR PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      data BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
