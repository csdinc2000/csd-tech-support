import type { Express, Request, Response } from "express";
import { z } from "zod/v4";
import { pool } from "./db";
import { decodeImageUpload } from "./image-upload";
import { getStaffAssignmentScope } from "./staff-access";
import { logger } from "./lib/logger";

// Browsers resize to ~160 KB before upload (compressPhoto); this cap only
// bounds what a hand-crafted request can store.
export const CUSTOMER_PHOTO_MAX_BYTES = 1_000_000;

export const customerPhotoInputSchema = z.object({ dataBase64: z.string().min(1).max(1_500_000) });

type StaffScope = Awaited<ReturnType<typeof getStaffAssignmentScope>>;
type Queryable = { query: typeof pool.query };

export type CustomerPhotoRouteOptions = {
  canSeeClient: (scope: StaffScope, clientId: number | null | undefined) => boolean;
};

export function decodeCustomerPhoto(input: { dataBase64: string }) {
  return decodeImageUpload(input.dataBase64, CUSTOMER_PHOTO_MAX_BYTES);
}

// Runs inside the public intake transaction. The photo always stays with the
// intake record; it becomes the account avatar only when the account has none,
// so anonymous intake can never replace a picture staff already chose.
export async function saveIntakeDevicePhoto(
  db: Queryable,
  input: { intakeRecordId: number; clientId: number | null; photo: { buffer: Buffer; mimeType: string } },
): Promise<void> {
  const { intakeRecordId, clientId, photo } = input;
  await db.query(
    `INSERT INTO csd_intake_device_photos (intake_record_id, mime_type, size_bytes, data) VALUES ($1, $2, $3, $4)`,
    [intakeRecordId, photo.mimeType, photo.buffer.length, photo.buffer],
  );
  if (clientId) {
    await db.query(
      `INSERT INTO client_avatars (client_id, mime_type, size_bytes, data, source, intake_record_id)
       VALUES ($1, $2, $3, $4, 'intake', $5) ON CONFLICT (client_id) DO NOTHING`,
      [clientId, photo.mimeType, photo.buffer.length, photo.buffer, intakeRecordId],
    );
  }
}

export async function getClientAvatarSummary(clientId: number) {
  const result = await pool.query(
    `SELECT source, updated_at FROM client_avatars WHERE client_id = $1`,
    [clientId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const updatedAt = new Date(row.updated_at);
  return {
    url: `/api/clients/${clientId}/avatar?v=${updatedAt.getTime()}`,
    source: row.source as "intake" | "staff",
    updatedAt,
  };
}

function sendImage(res: Response, row: { mime_type: string; data: Buffer }) {
  res.setHeader("Content-Type", row.mime_type);
  // Avatar URLs carry ?v=<updated_at>, so a long private cache is safe.
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(row.data);
}

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function registerCustomerPhotoRoutes(app: Express, options: CustomerPhotoRouteOptions): void {
  const visibleClientId = async (req: Request, raw: string) => {
    const clientId = parseId(raw);
    if (!clientId) return null;
    const scope = await getStaffAssignmentScope(req);
    if (!options.canSeeClient(scope, clientId)) return null;
    const exists = await pool.query(`SELECT 1 FROM clients WHERE id = $1`, [clientId]);
    return exists.rowCount ? clientId : null;
  };

  app.get("/api/clients/:id/avatar", async (req, res) => {
    try {
      const clientId = await visibleClientId(req, req.params.id);
      if (!clientId) { res.status(404).end(); return; }
      const result = await pool.query(`SELECT mime_type, data FROM client_avatars WHERE client_id = $1`, [clientId]);
      if (!result.rowCount) { res.status(404).end(); return; }
      sendImage(res, result.rows[0]);
    } catch (error) {
      logger.error({ error }, "Client avatar read failed");
      res.status(500).end();
    }
  });

  app.put("/api/clients/:id/avatar", async (req, res) => {
    try {
      const clientId = await visibleClientId(req, req.params.id);
      if (!clientId) { res.status(404).json({ error: "Client not found" }); return; }
      const parsed = customerPhotoInputSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: "A photo is required" }); return; }
      let photo;
      try {
        photo = decodeCustomerPhoto(parsed.data);
      } catch (error) {
        { res.status(400).json({ error: (error as Error).message }); return; }
      }
      await pool.query(
        `INSERT INTO client_avatars (client_id, mime_type, size_bytes, data, source, intake_record_id, uploaded_by_user_id, updated_at)
         VALUES ($1, $2, $3, $4, 'staff', NULL, $5, NOW())
         ON CONFLICT (client_id) DO UPDATE SET
           mime_type = EXCLUDED.mime_type, size_bytes = EXCLUDED.size_bytes, data = EXCLUDED.data,
           source = 'staff', intake_record_id = NULL, uploaded_by_user_id = EXCLUDED.uploaded_by_user_id, updated_at = NOW()`,
        [clientId, photo.mimeType, photo.buffer.length, photo.buffer, req.dbUser?.id ?? null],
      );
      res.json({ avatar: await getClientAvatarSummary(clientId) });
    } catch (error) {
      logger.error({ error }, "Client avatar upload failed");
      res.status(500).json({ error: "Failed to save photo" });
    }
  });

  app.delete("/api/clients/:id/avatar", async (req, res) => {
    try {
      const clientId = await visibleClientId(req, req.params.id);
      if (!clientId) { res.status(404).json({ error: "Client not found" }); return; }
      await pool.query(`DELETE FROM client_avatars WHERE client_id = $1`, [clientId]);
      res.json({ avatar: null });
    } catch (error) {
      logger.error({ error }, "Client avatar delete failed");
      res.status(500).json({ error: "Failed to remove photo" });
    }
  });

  // The photo attached to one intake. Assignment-restricted staff only see it
  // when the intake landed on an account they can see.
  app.get("/api/intake/:id/device-photo", async (req, res) => {
    try {
      const intakeRecordId = parseId(req.params.id);
      if (!intakeRecordId) { res.status(404).end(); return; }
      const result = await pool.query(
        `SELECT p.mime_type, p.data, s.client_id
         FROM csd_intake_device_photos p
         LEFT JOIN intake_submissions s ON s.intake_record_id = p.intake_record_id
         WHERE p.intake_record_id = $1`,
        [intakeRecordId],
      );
      const row = result.rows[0];
      if (!row) { res.status(404).end(); return; }
      const scope = await getStaffAssignmentScope(req);
      if (!scope.unrestricted && !options.canSeeClient(scope, row.client_id == null ? null : Number(row.client_id))) {
        { res.status(404).end(); return; }
      }
      sendImage(res, row);
    } catch (error) {
      logger.error({ error }, "Intake device photo read failed");
      res.status(500).end();
    }
  });
}
