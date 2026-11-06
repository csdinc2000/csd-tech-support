import type { Express, Request, Response } from "express";
import { z } from "zod/v4";
import { pool } from "./db";
import { decodeImageUpload } from "./image-upload";
import { getStaffAccess } from "./staff-access";
import { logger } from "./lib/logger";

// Browsers resize to ~160 KB before upload (compressPhoto); this cap only
// bounds what a hand-crafted request can store.
export const STAFF_PHOTO_MAX_BYTES = 1_000_000;

const photoInputSchema = z.object({ dataBase64: z.string().min(1).max(1_500_000) });

export type StaffAvatarSummary = { url: string; updatedAt: Date };

export async function getStaffAvatarSummary(userId: string): Promise<StaffAvatarSummary | null> {
  const result = await pool.query(`SELECT updated_at FROM staff_avatars WHERE user_id = $1`, [userId]);
  const row = result.rows[0];
  if (!row) return null;
  const updatedAt = new Date(row.updated_at);
  return {
    url: `/api/staff-profile/${encodeURIComponent(userId)}/avatar?v=${updatedAt.getTime()}`,
    updatedAt,
  };
}

function currentUserId(req: Request): string | null {
  return req.dbUser?.id ?? null;
}

// Every route here sits behind the API boundary (signed in + approved staff).
// Staff may only change their own picture; any approved staff member can view
// a colleague's so it can appear on boards and directories.
export function registerStaffProfileRoutes(app: Express): void {
  app.get("/api/staff-profile/me", async (req: Request, res: Response) => {
    try {
      const userId = currentUserId(req);
      if (!userId) { res.status(401).json({ error: "Not signed in" }); return; }
      const [profile, access, avatar] = await Promise.all([
        pool.query(
          `SELECT u.id, u.email, u.first_name, u.last_name, d.phone, d.job_title, d.department
           FROM auth_users u
           LEFT JOIN staff_directory_details d ON d.user_id = u.id
           WHERE u.id = $1`,
          [userId],
        ),
        getStaffAccess(req),
        getStaffAvatarSummary(userId),
      ]);
      const row = profile.rows[0];
      if (!row) { res.status(404).json({ error: "Profile not found" }); return; }
      res.json({
        id: row.id,
        email: row.email ?? null,
        firstName: row.first_name ?? null,
        lastName: row.last_name ?? null,
        phone: row.phone ?? null,
        jobTitle: row.job_title ?? null,
        department: row.department ?? null,
        role: access.role,
        avatar,
      });
    } catch (error) {
      logger.error({ error }, "Staff profile read failed");
      res.status(500).json({ error: "Failed to load profile" });
    }
  });

  app.put("/api/staff-profile/me/avatar", async (req: Request, res: Response) => {
    try {
      const userId = currentUserId(req);
      if (!userId) { res.status(401).json({ error: "Not signed in" }); return; }
      const parsed = photoInputSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: "A photo is required" }); return; }
      let photo;
      try {
        photo = decodeImageUpload(parsed.data.dataBase64, STAFF_PHOTO_MAX_BYTES);
      } catch (error) {
        res.status(400).json({ error: (error as Error).message });
        return;
      }
      await pool.query(
        `INSERT INTO staff_avatars (user_id, mime_type, size_bytes, data, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           mime_type = EXCLUDED.mime_type, size_bytes = EXCLUDED.size_bytes,
           data = EXCLUDED.data, updated_at = NOW()`,
        [userId, photo.mimeType, photo.buffer.length, photo.buffer],
      );
      res.json({ avatar: await getStaffAvatarSummary(userId) });
    } catch (error) {
      logger.error({ error }, "Staff avatar upload failed");
      res.status(500).json({ error: "Failed to save photo" });
    }
  });

  app.delete("/api/staff-profile/me/avatar", async (req: Request, res: Response) => {
    try {
      const userId = currentUserId(req);
      if (!userId) { res.status(401).json({ error: "Not signed in" }); return; }
      await pool.query(`DELETE FROM staff_avatars WHERE user_id = $1`, [userId]);
      res.json({ avatar: null });
    } catch (error) {
      logger.error({ error }, "Staff avatar delete failed");
      res.status(500).json({ error: "Failed to remove photo" });
    }
  });

  app.get("/api/staff-profile/:userId/avatar", async (req: Request, res: Response) => {
    try {
      const userId = String(req.params.userId || "");
      if (!userId || userId.length > 200) { res.status(404).end(); return; }
      const result = await pool.query(`SELECT mime_type, data FROM staff_avatars WHERE user_id = $1`, [userId]);
      const row = result.rows[0];
      if (!row) { res.status(404).end(); return; }
      res.setHeader("Content-Type", row.mime_type);
      // URLs carry ?v=<updated_at>, so a long private cache is safe.
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(row.data);
    } catch (error) {
      logger.error({ error }, "Staff avatar read failed");
      res.status(500).end();
    }
  });
}
