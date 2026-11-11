import type { Express, Request, Response } from "express";
import { z } from "zod/v4";
import { pool } from "./db";
import { decodeImageUpload } from "./image-upload";
import { rateLimit } from "./security";
import { logger } from "./lib/logger";
import { AD_EVENT_TYPES, adInputSchema, adState, safeAdLink, type AdInput } from "./portal-ad-core";

// ---------------------------------------------------------------------------
// Portal popup ads.
//
// Staff create ads in Marketing → All modules → Portal popup ads
// (/marketing/portal-ads). Each ad has a headline, text, an optional image and
// link, an on/off switch, an optional start/end window, a priority, a delay
// before it appears and how long a dismissal hides it. The customer portal
// shows the highest-priority live ad the visitor hasn't dismissed.
//
// Staff:  /api/crm/portal-ads*         (crm feature, path gate in security.ts)
// Public: /api/portal/ads/active        live ads (no counters, no drafts)
//         /api/portal/ads/:id/image     image of a live ad
//         /api/portal/ads/:id/events    impression / dismiss / click counters
// ---------------------------------------------------------------------------

// Browsers resize to ~160 KB first (compressPhoto); this only bounds what a
// hand-crafted request can store.
const AD_IMAGE_MAX_BYTES = 1_000_000;

type AdRow = {
  id: number; title: string; body: string; has_image: boolean; image_alt: string;
  link_url: string | null; link_label: string | null; is_active: boolean;
  starts_at: Date | null; ends_at: Date | null; priority: number; delay_seconds: number; suppress_hours: number;
  impressions: number; dismissals: number; clicks: number; created_at: Date; updated_at: Date;
};

const AD_COLUMNS = `id, title, body, (image IS NOT NULL) AS has_image, image_alt, link_url, link_label, is_active,
  starts_at, ends_at, priority, delay_seconds, suppress_hours, impressions, dismissals, clicks, created_at, updated_at`;

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const imagePath = (row: AdRow, scope: "portal" | "crm") =>
  row.has_image
    ? `${scope === "portal" ? "/api/portal/ads" : "/api/crm/portal-ads"}/${row.id}/image?v=${new Date(row.updated_at).getTime()}`
    : null;

/** What the portal needs to render and time an ad; nothing internal. */
function toPublic(row: AdRow) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    imageUrl: imagePath(row, "portal"),
    imageAlt: row.image_alt,
    linkUrl: row.link_url,
    linkLabel: row.link_label,
    priority: row.priority,
    delaySeconds: row.delay_seconds,
    suppressHours: row.suppress_hours,
  };
}

function toStaff(row: AdRow, now = new Date()) {
  const window = { isActive: row.is_active, startsAt: row.starts_at, endsAt: row.ends_at };
  return {
    ...toPublic(row),
    imageUrl: imagePath(row, "crm"),
    isActive: row.is_active,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    state: adState(window, now),
    impressions: row.impressions,
    dismissals: row.dismissals,
    clicks: row.clicks,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const LIVE_WHERE = `is_active AND (starts_at IS NULL OR starts_at <= NOW()) AND (ends_at IS NULL OR ends_at > NOW())`;

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(404).json({ error: "Ad not found" });
    return null;
  }
  return id;
}

function decodeImage(input: AdInput, res: Response): { buffer: Buffer; mimeType: string } | null | undefined {
  if (!input.imageBase64) return undefined;
  try {
    return decodeImageUpload(input.imageBase64, AD_IMAGE_MAX_BYTES);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return null;
  }
}

function inputError(res: Response, error: z.ZodError) {
  res.status(400).json({ error: error.issues[0]?.message || "Check the ad details and try again" });
}

const eventLimiter = rateLimit({ windowMs: 10 * 60_000, max: 120, message: "Too many requests" });
const eventSchema = z.object({ type: z.enum(AD_EVENT_TYPES) }).strict();
const EVENT_COLUMN = { impression: "impressions", dismiss: "dismissals", click: "clicks" } as const;

export function registerPortalAdRoutes(app: Express): void {
  // ---------- public (customer portal) ----------

  app.get("/api/portal/ads/active", async (_req, res) => {
    try {
      const result = await pool.query<AdRow>(
        `SELECT ${AD_COLUMNS} FROM portal_ads WHERE ${LIVE_WHERE} ORDER BY priority DESC, created_at DESC LIMIT 10`,
      );
      // Short cache: staff changes reach customers within a minute.
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({ ads: result.rows.map(toPublic) });
    } catch (error) {
      logger.error({ err: error }, "Portal ads could not be loaded");
      // The portal must keep working; no ads is a safe answer.
      res.json({ ads: [] });
    }
  });

  const sendImage = (live: boolean) => async (req: Request, res: Response) => {
    const id = parseId(req, res);
    if (!id) return;
    try {
      const result = await pool.query<{ image: Buffer | null; image_mime: string | null }>(
        `SELECT image, image_mime FROM portal_ads WHERE id = $1 ${live ? `AND ${LIVE_WHERE}` : ""}`,
        [id],
      );
      const row = result.rows[0];
      if (!row?.image) {
        res.status(404).json({ error: "Image not found" });
        return;
      }
      res.setHeader("Content-Type", row.image_mime || "image/jpeg");
      res.setHeader("Cache-Control", live ? "public, max-age=86400" : "private, max-age=60");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(row.image);
    } catch (error) {
      logger.error({ err: error, id }, "Portal ad image could not be loaded");
      res.status(500).json({ error: "Image could not be loaded" });
    }
  };

  app.get("/api/portal/ads/:id/image", sendImage(true));

  app.post("/api/portal/ads/:id/events", eventLimiter, async (req, res) => {
    const id = parseId(req, res);
    if (!id) return;
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Unknown event" });
      return;
    }
    const column = EVENT_COLUMN[parsed.data.type];
    try {
      await pool.query(`UPDATE portal_ads SET ${column} = ${column} + 1 WHERE id = $1 AND ${LIVE_WHERE}`, [id]);
      res.status(204).end();
    } catch (error) {
      logger.warn({ err: error, id }, "Portal ad event could not be recorded");
      res.status(204).end();
    }
  });

  // ---------- staff (Marketing → Portal popup ads) ----------

  app.get("/api/crm/portal-ads", async (_req, res) => {
    try {
      const result = await pool.query<AdRow>(`SELECT ${AD_COLUMNS} FROM portal_ads ORDER BY priority DESC, created_at DESC`);
      const now = new Date();
      res.json({ ads: result.rows.map((row) => toStaff(row, now)) });
    } catch (error) {
      logger.error({ err: error }, "Portal ads could not be listed");
      res.status(500).json({ error: "Portal ads could not be loaded" });
    }
  });

  app.get("/api/crm/portal-ads/:id/image", sendImage(false));

  app.post("/api/crm/portal-ads", async (req, res) => {
    const parsed = adInputSchema.safeParse(req.body);
    if (!parsed.success) return inputError(res, parsed.error);
    const ad = parsed.data;
    const image = decodeImage(ad, res);
    if (image === null) return;
    try {
      const result = await pool.query<AdRow>(
        `INSERT INTO portal_ads
           (title, body, image, image_mime, image_alt, link_url, link_label, is_active, starts_at, ends_at,
            priority, delay_seconds, suppress_hours, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING ${AD_COLUMNS}`,
        [
          ad.title, ad.body, image?.buffer ?? null, image?.mimeType ?? null, ad.imageAlt,
          safeAdLink(ad.linkUrl), ad.linkLabel?.trim() || null, ad.isActive, ad.startsAt, ad.endsAt,
          ad.priority, ad.delaySeconds, ad.suppressHours, req.dbUser?.id ?? null,
        ],
      );
      res.status(201).json(toStaff(result.rows[0]));
    } catch (error) {
      logger.error({ err: error }, "Portal ad could not be created");
      res.status(500).json({ error: "The ad could not be saved" });
    }
  });

  app.put("/api/crm/portal-ads/:id", async (req, res) => {
    const id = parseId(req, res);
    if (!id) return;
    const parsed = adInputSchema.safeParse(req.body);
    if (!parsed.success) return inputError(res, parsed.error);
    const ad = parsed.data;
    const image = decodeImage(ad, res);
    if (image === null) return;
    try {
      // $14/$15: replace the image when a new one is sent, clear it on removeImage.
      const result = await pool.query<AdRow>(
        `UPDATE portal_ads SET
           title = $2, body = $3, image_alt = $4, link_url = $5, link_label = $6, is_active = $7,
           starts_at = $8, ends_at = $9, priority = $10, delay_seconds = $11, suppress_hours = $12,
           image = CASE WHEN $13::bytea IS NOT NULL THEN $13::bytea WHEN $15 THEN NULL ELSE image END,
           image_mime = CASE WHEN $13::bytea IS NOT NULL THEN $14 WHEN $15 THEN NULL ELSE image_mime END,
           updated_at = NOW()
         WHERE id = $1
         RETURNING ${AD_COLUMNS}`,
        [
          id, ad.title, ad.body, ad.imageAlt, safeAdLink(ad.linkUrl), ad.linkLabel?.trim() || null, ad.isActive,
          ad.startsAt, ad.endsAt, ad.priority, ad.delaySeconds, ad.suppressHours,
          image?.buffer ?? null, image?.mimeType ?? null, Boolean(ad.removeImage),
        ],
      );
      if (!result.rows[0]) {
        res.status(404).json({ error: "Ad not found" });
        return;
      }
      res.json(toStaff(result.rows[0]));
    } catch (error) {
      logger.error({ err: error, id }, "Portal ad could not be updated");
      res.status(500).json({ error: "The ad could not be saved" });
    }
  });

  app.delete("/api/crm/portal-ads/:id", async (req, res) => {
    const id = parseId(req, res);
    if (!id) return;
    try {
      const result = await pool.query("DELETE FROM portal_ads WHERE id = $1", [id]);
      if (!result.rowCount) {
        res.status(404).json({ error: "Ad not found" });
        return;
      }
      res.status(204).end();
    } catch (error) {
      logger.error({ err: error, id }, "Portal ad could not be deleted");
      res.status(500).json({ error: "The ad could not be deleted" });
    }
  });
}

