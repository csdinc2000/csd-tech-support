import { pool } from "../db";

// Customer device photos, stored as bytea like marketplace_images (autoscale
// deployments have no persistent disk and no object-storage bucket).
//  - csd_intake_device_photos: the photo the customer attached to an intake,
//    kept with the request even when the intake could not be linked to an
//    account (identity review).
//  - client_avatars: the account's profile picture. Intake fills it only
//    when empty; staff can replace it from the customer page.
export async function applyCustomerPhotosMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS csd_intake_device_photos (
      intake_record_id INTEGER PRIMARY KEY REFERENCES csd_intake_records(id) ON DELETE CASCADE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS client_avatars (
      client_id INTEGER PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      data BYTEA NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('intake', 'staff')),
      intake_record_id INTEGER REFERENCES csd_intake_records(id) ON DELETE SET NULL,
      uploaded_by_user_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
