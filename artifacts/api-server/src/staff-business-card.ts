import { randomBytes } from "node:crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod/v4";
import { pool } from "./db";
import { getInvoiceSettings } from "./invoice-settings";
import { isSmtpConfigured, sendSmtpMail } from "./mail-transport";
import { rateLimit } from "./security";
import { getStaffAccessForUserId } from "./staff-access";
import { logger } from "./lib/logger";

const CARD_FROM = "support@computersystemsdepot.com";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  administrator: "Administrator",
  field_technician: "Field Technician",
  software_developer: "Software Developer",
  accounting: "Accounting",
  it_manager: "IT Manager",
  legal_team: "Legal Team",
  secretary: "Secretary",
};

export type PublicBusinessCard = {
  name: string;
  firstName: string | null;
  lastName: string | null;
  title: string;
  headline: string | null;
  email: string | null;
  directPhone: string | null;
  photoUrl: string | null;
  company: { name: string; phone: string | null; email: string | null; website: string; accentColor: "red" | "navy" };
  cardUrl: string;
  vcardUrl: string;
  bookingUrl: string;
};

type CardRow = {
  user_id: string;
  token: string;
  headline: string | null;
  show_email: boolean;
  show_direct_phone: boolean;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  job_title: string | null;
  has_photo: boolean;
  photo_updated_at: Date | null;
};

const cardSelect = `SELECT c.user_id, c.token, c.headline, c.show_email, c.show_direct_phone,
    u.email, u.first_name, u.last_name, d.phone, d.job_title,
    (a.user_id IS NOT NULL) AS has_photo, a.updated_at AS photo_updated_at
  FROM staff_business_cards c
  JOIN auth_users u ON u.id = c.user_id
  LEFT JOIN staff_directory_details d ON d.user_id = c.user_id
  LEFT JOIN staff_avatars a ON a.user_id = c.user_id`;

export function publicBaseUrl(): string {
  const configured = process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:5000";
}

function newToken(): string {
  return randomBytes(16).toString("base64url");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function ensureCard(userId: string): Promise<CardRow> {
  await pool.query(
    `INSERT INTO staff_business_cards (user_id, token) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
    [userId, newToken()],
  );
  const result = await pool.query<CardRow>(`${cardSelect} WHERE c.user_id = $1`, [userId]);
  return result.rows[0];
}

async function buildCard(row: CardRow, role: string): Promise<PublicBusinessCard> {
  const settings = await getInvoiceSettings();
  const base = publicBaseUrl();
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || row.email || "Technician";
  const token = encodeURIComponent(row.token);
  return {
    name,
    firstName: row.first_name,
    lastName: row.last_name,
    title: row.job_title?.trim() || ROLE_LABEL[role] || "Technician",
    headline: row.headline?.trim() || null,
    email: row.show_email ? row.email : null,
    directPhone: row.show_direct_phone ? row.phone : null,
    photoUrl: row.has_photo
      ? `/api/portal/business-card/${token}/photo?v=${new Date(row.photo_updated_at!).getTime()}`
      : null,
    company: {
      name: settings.businessName,
      phone: settings.contactPhone || null,
      email: settings.contactEmail || null,
      website: base,
      accentColor: settings.accentColor,
    },
    cardUrl: `${base}/card/${token}`,
    vcardUrl: `/api/portal/business-card/${token}/vcard`,
    bookingUrl: `${base}/intake`,
  };
}

// The card only resolves while its owner is approved staff, so suspending a
// technician (or leaving them pending) immediately turns their card off.
async function loadPublicCard(token: string): Promise<{ row: CardRow; card: PublicBusinessCard } | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const result = await pool.query<CardRow>(`${cardSelect} WHERE c.token = $1`, [token]);
  const row = result.rows[0];
  if (!row) return null;
  const access = await getStaffAccessForUserId(row.user_id);
  if (access.approvalStatus !== "approved") return null;
  return { row, card: await buildCard(row, access.role) };
}

// vCard 3.0 with lines folded at 75 octets as the spec requires.
function vcardEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
}

function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Never split a multi-byte UTF-8 character.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74; // continuation lines start with a space
  }
  return parts.join("\r\n ");
}

export function buildVCard(card: PublicBusinessCard, photo?: { mimeType: string; data: Buffer } | null): string {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${vcardEscape(card.lastName ?? "")};${vcardEscape(card.firstName ?? (card.lastName ? "" : card.name))};;;`,
    `FN:${vcardEscape(card.name)}`,
    `ORG:${vcardEscape(card.company.name)}`,
    `TITLE:${vcardEscape(card.title)}`,
  ];
  if (card.directPhone) lines.push(`TEL;TYPE=CELL,VOICE:${vcardEscape(card.directPhone)}`);
  if (card.company.phone) lines.push(`TEL;TYPE=WORK,VOICE:${vcardEscape(card.company.phone)}`);
  if (card.email) lines.push(`EMAIL;TYPE=INTERNET,WORK:${vcardEscape(card.email)}`);
  else if (card.company.email) lines.push(`EMAIL;TYPE=INTERNET,WORK:${vcardEscape(card.company.email)}`);
  lines.push(`URL:${vcardEscape(card.cardUrl)}`);
  if (card.headline) lines.push(`NOTE:${vcardEscape(card.headline)}`);
  if (photo) {
    const type = photo.mimeType === "image/png" ? "PNG" : photo.mimeType === "image/webp" ? "WEBP" : "JPEG";
    lines.push(`PHOTO;ENCODING=b;TYPE=${type}:${photo.data.toString("base64")}`);
  }
  lines.push("END:VCARD");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

function vcardFilename(name: string): string {
  return `${name.replace(/[^A-Za-z0-9 _-]/g, "").trim().replace(/\s+/g, "-") || "contact"}.vcf`;
}

const cardSettingsSchema = z.object({
  headline: z.string().trim().max(140).nullable().optional(),
  showEmail: z.boolean().optional(),
  showDirectPhone: z.boolean().optional(),
});

const emailCardSchema = z.object({
  to: z.email().max(254),
  recipientName: z.string().trim().max(120).optional(),
  message: z.string().trim().max(1000).optional(),
});

function cardEmail(card: PublicBusinessCard, input: z.infer<typeof emailCardSchema>) {
  const greeting = input.recipientName ? `Hi ${input.recipientName},` : "Hi,";
  const intro = input.message || `It was great working with you. Here's my contact card so you can reach me any time.`;
  const contactLines = [
    card.directPhone ? `Direct: ${card.directPhone}` : null,
    card.company.phone ? `${card.company.name}: ${card.company.phone}` : null,
    card.email ? `Email: ${card.email}` : null,
  ].filter(Boolean) as string[];
  const text = [
    greeting, "", intro, "",
    `${card.name}`, `${card.title}, ${card.company.name}`, ...contactLines, "",
    `View and save my card: ${card.cardUrl}`,
  ].join("\n");
  const accent = card.company.accentColor === "navy" ? "#1e3a8a" : "#b91c1c";
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">
<div style="max-width:520px;margin:0 auto;padding:24px">
  <p>${escapeHtml(greeting)}</p>
  <p style="white-space:pre-line">${escapeHtml(intro)}</p>
  <div style="background:#fff;border-radius:12px;border-top:6px solid ${accent};padding:20px;margin:20px 0">
    <div style="font-size:20px;font-weight:bold">${escapeHtml(card.name)}</div>
    <div style="color:#4b5563">${escapeHtml(card.title)} &middot; ${escapeHtml(card.company.name)}</div>
    ${contactLines.map((line) => `<div style="margin-top:6px">${escapeHtml(line)}</div>`).join("")}
    <p style="margin:20px 0 0"><a href="${escapeHtml(card.cardUrl)}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:bold">View &amp; save my contact card</a></p>
  </div>
</div></body></html>`;
  return { text, html };
}

export function registerStaffBusinessCardRoutes(app: Express): void {
  // ---- Staff (behind the API boundary: signed in + approved) ----
  app.get("/api/staff-profile/me/card", async (req: Request, res: Response) => {
    try {
      const userId = req.dbUser?.id;
      if (!userId) { res.status(401).json({ error: "Not signed in" }); return; }
      const row = await ensureCard(userId);
      const access = await getStaffAccessForUserId(userId);
      res.json({
        token: row.token,
        settings: { headline: row.headline, showEmail: row.show_email, showDirectPhone: row.show_direct_phone },
        hasDirectPhone: Boolean(row.phone),
        card: await buildCard(row, access.role),
        emailAvailable: isSmtpConfigured(),
      });
    } catch (error) {
      logger.error({ error }, "Business card read failed");
      res.status(500).json({ error: "Failed to load business card" });
    }
  });

  app.patch("/api/staff-profile/me/card", async (req: Request, res: Response) => {
    try {
      const userId = req.dbUser?.id;
      if (!userId) { res.status(401).json({ error: "Not signed in" }); return; }
      const parsed = cardSettingsSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: "Invalid card settings" }); return; }
      await ensureCard(userId);
      const { headline, showEmail, showDirectPhone } = parsed.data;
      await pool.query(
        `UPDATE staff_business_cards SET
           headline = CASE WHEN $2::boolean THEN $3 ELSE headline END,
           show_email = COALESCE($4, show_email),
           show_direct_phone = COALESCE($5, show_direct_phone),
           updated_at = NOW()
         WHERE user_id = $1`,
        [userId, headline !== undefined, headline || null, showEmail ?? null, showDirectPhone ?? null],
      );
      res.json({ ok: true });
    } catch (error) {
      logger.error({ error }, "Business card update failed");
      res.status(500).json({ error: "Failed to save card settings" });
    }
  });

  // A new link invalidates every card link and QR code shared so far.
  app.post("/api/staff-profile/me/card/rotate", async (req: Request, res: Response) => {
    try {
      const userId = req.dbUser?.id;
      if (!userId) { res.status(401).json({ error: "Not signed in" }); return; }
      await ensureCard(userId);
      await pool.query(`UPDATE staff_business_cards SET token = $2, updated_at = NOW() WHERE user_id = $1`, [userId, newToken()]);
      res.json({ ok: true });
    } catch (error) {
      logger.error({ error }, "Business card rotate failed");
      res.status(500).json({ error: "Failed to create a new link" });
    }
  });

  app.post(
    "/api/staff-profile/me/card/email",
    rateLimit({ windowMs: 60 * 60 * 1000, max: 30, key: (req) => `card-email:${req.dbUser?.id ?? req.ip}`, message: "Too many cards sent. Try again later." }),
    async (req: Request, res: Response) => {
      try {
        const userId = req.dbUser?.id;
        if (!userId) { res.status(401).json({ error: "Not signed in" }); return; }
        const parsed = emailCardSchema.safeParse(req.body);
        if (!parsed.success) { res.status(400).json({ error: "Enter a valid email address" }); return; }
        if (!isSmtpConfigured()) { res.status(503).json({ error: "Company email is not set up yet" }); return; }
        const row = await ensureCard(userId);
        const access = await getStaffAccessForUserId(userId);
        const card = await buildCard(row, access.role);
        const { text, html } = cardEmail(card, parsed.data);
        await sendSmtpMail({
          to: parsed.data.to,
          from: { email: CARD_FROM, name: `${card.name} | ${card.company.name}` },
          replyTo: row.email || CARD_FROM,
          subject: `${card.name}'s contact card - ${card.company.name}`,
          text,
          html,
        });
        res.json({ ok: true });
      } catch (error) {
        logger.error({ error }, "Business card email failed");
        res.status(502).json({ error: "The email could not be sent. Please try again." });
      }
    },
  );

  // ---- Public (under /api/portal, no session) ----
  const publicLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 240, message: "Too many requests" });

  app.get("/api/portal/business-card/:token", publicLimit, async (req: Request, res: Response) => {
    try {
      const found = await loadPublicCard(String(req.params.token));
      if (!found) { res.status(404).json({ error: "This card is no longer available" }); return; }
      res.setHeader("Cache-Control", "no-store");
      res.json(found.card);
    } catch (error) {
      logger.error({ error }, "Public business card read failed");
      res.status(500).json({ error: "Failed to load card" });
    }
  });

  app.get("/api/portal/business-card/:token/photo", publicLimit, async (req: Request, res: Response) => {
    try {
      const found = await loadPublicCard(String(req.params.token));
      if (!found) { res.status(404).end(); return; }
      const photo = await pool.query(`SELECT mime_type, data FROM staff_avatars WHERE user_id = $1`, [found.row.user_id]);
      if (!photo.rowCount) { res.status(404).end(); return; }
      res.setHeader("Content-Type", photo.rows[0].mime_type);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(photo.rows[0].data);
    } catch (error) {
      logger.error({ error }, "Public business card photo failed");
      res.status(500).end();
    }
  });

  app.get("/api/portal/business-card/:token/vcard", publicLimit, async (req: Request, res: Response) => {
    try {
      const found = await loadPublicCard(String(req.params.token));
      if (!found) { res.status(404).end(); return; }
      const photo = found.row.has_photo
        ? (await pool.query(`SELECT mime_type, data FROM staff_avatars WHERE user_id = $1`, [found.row.user_id])).rows[0]
        : null;
      const vcard = buildVCard(found.card, photo ? { mimeType: photo.mime_type, data: photo.data } : null);
      res.setHeader("Content-Type", "text/vcard; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${vcardFilename(found.card.name)}"`);
      res.setHeader("Cache-Control", "no-store");
      res.send(vcard);
    } catch (error) {
      logger.error({ error }, "Public business card vCard failed");
      res.status(500).end();
    }
  });
}
