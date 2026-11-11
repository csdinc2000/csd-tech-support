import type { Express, Request, Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod/v4";
import { pool } from "./db";
import { decodeImageUpload } from "./image-upload";
import { rateLimit } from "./security";
import { sendEmail } from "./helpdesk-email";
import { logger } from "./lib/logger";
import { claudeTextReader, claudeVisionReader, isVisionConfigured, lookupHardwareText, scanHardwareImage, type TextReader, type VisionReader } from "./marketplace-scan";

// ---------------------------------------------------------------------------
// Community Marketplace — free peer-to-peer listings for customers' computers,
// laptops and parts. Customers have no accounts, so a seller manages their
// listing through a secret link (token hashed at rest, same model as the
// contract signing link). Staff review every portal submission before it goes
// live and can also post on behalf of a customer who calls in.
// ---------------------------------------------------------------------------

export const MARKETPLACE_CATEGORIES = ["gaming_pc", "desktop", "laptop", "parts", "monitor", "accessories", "other"] as const;
export const MARKETPLACE_CONDITIONS = ["new", "like_new", "good", "fair", "for_parts"] as const;
export const MARKETPLACE_STATUSES = ["pending", "active", "sold", "rejected", "removed"] as const;
export const MARKETPLACE_MAX_IMAGES = 8;
export const MARKETPLACE_MAX_IMAGE_BYTES = 1_500_000;

type ListingStatus = (typeof MARKETPLACE_STATUSES)[number];

const ADMIN_EMAIL = process.env.CSD_ADMIN_EMAIL || "support@computersystemsdepot.com";

function appBaseUrl(): string {
  const configured = process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:5000";
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ipFrom(req: Request) {
  return String(req.ip || req.socket.remoteAddress || "").slice(0, 120);
}

// ---------- validation ----------

const optionalText = (max: number) => z.string().trim().max(max).optional().default("");

const specsSchema = z.object({
  cpu: optionalText(120),
  gpu: optionalText(120),
  ram: optionalText(120),
  storage: optionalText(120),
  os: optionalText(120),
}).default({ cpu: "", gpu: "", ram: "", storage: "", os: "" });

const imageInputSchema = z.object({
  dataBase64: z.string().min(1),
  mimeType: z.string().optional(),
});

const listingFields = {
  title: z.string().trim().min(4, "Title must be at least 4 characters").max(120, "Title is too long"),
  description: z.string().trim().min(10, "Description must be at least 10 characters").max(4000, "Description is too long"),
  category: z.enum(MARKETPLACE_CATEGORIES),
  condition: z.enum(MARKETPLACE_CONDITIONS),
  price: z.coerce.number().min(0, "Price cannot be negative").max(100_000, "Price is too high"),
  specs: specsSchema,
  location: optionalText(80),
};

const sellerFields = {
  sellerName: z.string().trim().min(2, "Seller name is required").max(100),
  sellerEmail: z.string().trim().email("A valid email is required").max(200),
  sellerPhone: optionalText(40),
  showPhone: z.boolean().optional().default(false),
};

const portalCreateSchema = z.object({
  ...listingFields,
  ...sellerFields,
  images: z.array(imageInputSchema).min(1, "Add at least one photo").max(MARKETPLACE_MAX_IMAGES, `Up to ${MARKETPLACE_MAX_IMAGES} photos`),
});

const staffCreateSchema = z.object({
  ...listingFields,
  ...sellerFields,
  images: z.array(imageInputSchema).max(MARKETPLACE_MAX_IMAGES).optional().default([]),
});

const updateSchema = z.object({
  ...listingFields,
  ...sellerFields,
}).partial().extend({
  addImages: z.array(imageInputSchema).max(MARKETPLACE_MAX_IMAGES).optional().default([]),
  removeImageIds: z.array(z.coerce.number().int().positive()).max(MARKETPLACE_MAX_IMAGES).optional().default([]),
  imageOrder: z.array(z.coerce.number().int().positive()).max(MARKETPLACE_MAX_IMAGES).optional(),
});

const contactSchema = z.object({
  buyerName: z.string().trim().min(2, "Your name is required").max(100),
  buyerEmail: z.string().trim().email("A valid email is required").max(200),
  buyerPhone: optionalText(40),
  message: z.string().trim().min(10, "Tell the seller a little more").max(2000),
});

const sellerStatusSchema = z.object({ status: z.enum(["active", "sold", "removed"]) });
const staffStatusSchema = z.object({
  status: z.enum(MARKETPLACE_STATUSES),
  note: optionalText(1000),
});

function decodeImage(input: { dataBase64: string }): { buffer: Buffer; mimeType: string } {
  return decodeImageUpload(input.dataBase64, MARKETPLACE_MAX_IMAGE_BYTES);
}

// ---------- row mapping ----------

const LISTING_SELECT = `
  SELECT l.id, l.title, l.description, l.category, l.condition, l.price_cents, l.specs, l.location,
         l.seller_name, l.seller_email, l.seller_phone, l.show_phone, l.status, l.source,
         l.created_by_user_id, l.review_note, l.reviewed_by_user_id, l.reviewed_at, l.published_at, l.sold_at,
         l.view_count, l.created_at, l.updated_at,
         COALESCE((SELECT json_agg(i.id ORDER BY i.position, i.id) FROM marketplace_images i WHERE i.listing_id = l.id), '[]'::json) AS image_ids,
         (SELECT COUNT(*)::int FROM marketplace_inquiries q WHERE q.listing_id = l.id) AS inquiry_count
  FROM marketplace_listings l`;

type ListingRow = {
  id: number; title: string; description: string; category: string; condition: string; price_cents: number;
  specs: Record<string, string>; location: string | null; seller_name: string; seller_email: string;
  seller_phone: string | null; show_phone: boolean; status: ListingStatus; source: string;
  created_by_user_id: string | null; review_note: string | null; reviewed_by_user_id: string | null;
  reviewed_at: Date | null; published_at: Date | null; sold_at: Date | null; view_count: number;
  created_at: Date; updated_at: Date; image_ids: number[]; inquiry_count: number;
};

// "Marcus Thompson" -> "Marcus T." — buyers never see a seller's full name or
// email; contact goes through the relay form (or the phone if the seller opted in).
export function publicSellerName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] || "Seller";
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

function publicListing(row: ListingRow) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    condition: row.condition,
    priceCents: row.price_cents,
    specs: row.specs || {},
    location: row.location || "",
    sellerName: publicSellerName(row.seller_name),
    sellerPhone: row.show_phone && row.seller_phone ? row.seller_phone : null,
    status: row.status,
    // Staff-posted listings are ones CSD handled directly for the seller.
    verified: row.source === "staff",
    imageIds: row.image_ids || [],
    coverImageId: row.image_ids?.[0] ?? null,
    publishedAt: row.published_at,
    soldAt: row.sold_at,
    createdAt: row.created_at,
    viewCount: row.view_count,
  };
}

// Full record — returned to staff and to the seller through their manage link.
function fullListing(row: ListingRow) {
  return {
    ...publicListing(row),
    sellerName: row.seller_name,
    sellerEmail: row.seller_email,
    sellerPhone: row.seller_phone || "",
    showPhone: row.show_phone,
    source: row.source,
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at,
    createdByUserId: row.created_by_user_id,
    updatedAt: row.updated_at,
    inquiryCount: row.inquiry_count,
  };
}

async function loadListing(where: string, params: unknown[]): Promise<ListingRow | null> {
  const result = await pool.query(`${LISTING_SELECT} WHERE ${where} LIMIT 1`, params);
  return (result.rows[0] as ListingRow | undefined) ?? null;
}

async function loadInquiries(listingId: number) {
  const result = await pool.query(
    `SELECT id, buyer_name AS "buyerName", buyer_email AS "buyerEmail", buyer_phone AS "buyerPhone", message, created_at AS "createdAt"
     FROM marketplace_inquiries WHERE listing_id = $1 ORDER BY created_at DESC`,
    [listingId],
  );
  return result.rows;
}

async function insertImages(client: { query: typeof pool.query }, listingId: number, images: Array<{ dataBase64: string }>, startPosition: number) {
  let position = startPosition;
  for (const image of images) {
    const decoded = decodeImage(image);
    await client.query(
      `INSERT INTO marketplace_images (listing_id, position, mime_type, size_bytes, data) VALUES ($1, $2, $3, $4, $5)`,
      [listingId, position++, decoded.mimeType, decoded.buffer.length, decoded.buffer],
    );
  }
}

function toCents(price: number) {
  return Math.round(price * 100);
}

// ---------- email ----------

function formatPrice(cents: number) {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export type MarketplaceMailer = (
  to: string,
  subject: string,
  text: string,
  options: { html: string; replyTo?: string; operation: "marketplace" },
) => Promise<unknown>;

// Swapped out by tests so no real email leaves the process.
let mailer: MarketplaceMailer = (to, subject, text, options) => sendEmail(to, subject, text, options);

async function safeSend(to: string, subject: string, text: string, html: string, replyTo?: string): Promise<boolean> {
  try {
    await mailer(to, subject, text, { html, replyTo, operation: "marketplace" });
    return true;
  } catch (error) {
    logger.warn({ error, to, subject }, "Marketplace email could not be sent");
    return false;
  }
}

function emailShell(title: string, bodyHtml: string) {
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">
    <div style="background:#111;padding:16px 20px;border-top:4px solid #e60000">
      <span style="color:#fff;font-weight:700;font-size:16px">Computer Systems Depot</span>
      <span style="color:#bbb;font-size:13px;margin-left:8px">Community Marketplace</span>
    </div>
    <div style="padding:20px;border:1px solid #e5e5e5;border-top:0">
      <h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(title)}</h2>
      ${bodyHtml}
      <p style="margin-top:24px;font-size:12px;color:#666">The marketplace is a free service for our customers. Computer Systems Depot is not a party to any sale — please inspect items in person before paying.</p>
    </div>
  </div>`;
}

function button(href: string, label: string) {
  return `<p style="margin:20px 0"><a href="${escapeHtml(href)}" style="background:#e60000;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;display:inline-block">${escapeHtml(label)}</a></p>`;
}

async function emailSellerManageLink(row: ListingRow, token: string, kind: "submitted" | "staff_posted" | "resend") {
  const manageUrl = `${appBaseUrl()}/portal/marketplace/manage/${token}`;
  const subject = kind === "submitted"
    ? `We received your listing: ${row.title}`
    : kind === "staff_posted"
      ? `Your listing is live: ${row.title}`
      : `Your marketplace listing link: ${row.title}`;
  const intro = kind === "submitted"
    ? "Thanks for listing with us. Our team reviews every listing before it goes live — usually within one business day. We'll email you as soon as it's published."
    : kind === "staff_posted"
      ? "Our team has posted your item on the Computer Systems Depot Community Marketplace. Buyers can now find it and contact you."
      : "Here is the private link to manage your marketplace listing.";
  const text = `${intro}\n\nListing: ${row.title} — ${formatPrice(row.price_cents)}\n\nManage your listing (edit, mark as sold, or remove it) here:\n${manageUrl}\n\nKeep this link private — anyone with it can change your listing.`;
  const html = emailShell(subject, `
    <p>${escapeHtml(intro)}</p>
    <p><strong>${escapeHtml(row.title)}</strong> — ${escapeHtml(formatPrice(row.price_cents))}</p>
    ${button(manageUrl, "Manage my listing")}
    <p style="font-size:13px;color:#444">Use this link to edit your listing, mark it as sold, or remove it. Keep it private — anyone with the link can change your listing.</p>
  `);
  return safeSend(row.seller_email, subject, text, html);
}

async function emailStaffNewListing(row: ListingRow) {
  const reviewUrl = `${appBaseUrl()}/marketplace?listing=${row.id}`;
  const subject = `Marketplace listing awaiting review: ${row.title}`;
  const text = `A customer submitted a new marketplace listing.\n\nTitle: ${row.title}\nPrice: ${formatPrice(row.price_cents)}\nSeller: ${row.seller_name} <${row.seller_email}> ${row.seller_phone || ""}\n\nReview it here: ${reviewUrl}`;
  const html = emailShell(subject, `
    <p><strong>${escapeHtml(row.title)}</strong> — ${escapeHtml(formatPrice(row.price_cents))}</p>
    <p>Seller: ${escapeHtml(row.seller_name)} &lt;${escapeHtml(row.seller_email)}&gt; ${escapeHtml(row.seller_phone || "")}</p>
    ${button(reviewUrl, "Review listing")}
  `);
  return safeSend(ADMIN_EMAIL, subject, text, html);
}

async function emailSellerDecision(row: ListingRow, approved: boolean, note: string) {
  const listingUrl = `${appBaseUrl()}/portal/marketplace/${row.id}`;
  const subject = approved ? `Your listing is live: ${row.title}` : `Update on your listing: ${row.title}`;
  const body = approved
    ? "Good news — your listing has been approved and is now visible to other customers."
    : "Our team was not able to publish your listing as submitted." + (note ? ` Reason: ${note}` : "") + " You can update it with your manage link and it will be reviewed again.";
  const text = `${body}\n\n${row.title} — ${formatPrice(row.price_cents)}${approved ? `\n\nView it here: ${listingUrl}` : ""}`;
  const html = emailShell(subject, `
    <p>${escapeHtml(body)}</p>
    <p><strong>${escapeHtml(row.title)}</strong> — ${escapeHtml(formatPrice(row.price_cents))}</p>
    ${approved ? button(listingUrl, "View my listing") : ""}
  `);
  return safeSend(row.seller_email, subject, text, html);
}

async function emailSellerInquiry(row: ListingRow, inquiry: z.infer<typeof contactSchema>) {
  const subject = `Someone is interested in your listing: ${row.title}`;
  const text = `A buyer contacted you through the Computer Systems Depot Community Marketplace.\n\nListing: ${row.title} — ${formatPrice(row.price_cents)}\n\nFrom: ${inquiry.buyerName}\nEmail: ${inquiry.buyerEmail}\nPhone: ${inquiry.buyerPhone || "(not provided)"}\n\nMessage:\n${inquiry.message}\n\nReply to this email to respond directly to the buyer.`;
  const html = emailShell(subject, `
    <p>A buyer contacted you about <strong>${escapeHtml(row.title)}</strong> (${escapeHtml(formatPrice(row.price_cents))}).</p>
    <table style="font-size:14px;border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0;color:#666">From</td><td>${escapeHtml(inquiry.buyerName)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Email</td><td>${escapeHtml(inquiry.buyerEmail)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Phone</td><td>${escapeHtml(inquiry.buyerPhone || "(not provided)")}</td></tr>
    </table>
    <div style="margin-top:12px;padding:12px;background:#f7f7f7;border-left:3px solid #e60000;white-space:pre-wrap">${escapeHtml(inquiry.message)}</div>
    <p style="margin-top:16px">Reply to this email to respond directly to the buyer.</p>
  `);
  return safeSend(row.seller_email, subject, text, html, inquiry.buyerEmail);
}

// ---------- shared update logic ----------

async function applyUpdate(listingId: number, input: z.infer<typeof updateSchema>, extraSet: string[] = [], extraParams: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(`SELECT id FROM marketplace_listings WHERE id = $1 FOR UPDATE`, [listingId]);
    if (!current.rowCount) throw Object.assign(new Error("Listing not found"), { status: 404 });

    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, value: unknown) => { params.push(value); sets.push(`${column} = $${params.length}`); };
    if (input.title !== undefined) add("title", input.title);
    if (input.description !== undefined) add("description", input.description);
    if (input.category !== undefined) add("category", input.category);
    if (input.condition !== undefined) add("condition", input.condition);
    if (input.price !== undefined) add("price_cents", toCents(input.price));
    if (input.specs !== undefined) add("specs", JSON.stringify(input.specs));
    if (input.location !== undefined) add("location", input.location || null);
    if (input.sellerName !== undefined) add("seller_name", input.sellerName);
    if (input.sellerEmail !== undefined) add("seller_email", input.sellerEmail);
    if (input.sellerPhone !== undefined) add("seller_phone", input.sellerPhone || null);
    if (input.showPhone !== undefined) add("show_phone", input.showPhone);
    for (let i = 0; i < extraSet.length; i++) { params.push(extraParams[i]); sets.push(`${extraSet[i]} = $${params.length}`); }
    sets.push("updated_at = NOW()");
    params.push(listingId);
    await client.query(`UPDATE marketplace_listings SET ${sets.join(", ")} WHERE id = $${params.length}`, params);

    if (input.removeImageIds.length) {
      await client.query(`DELETE FROM marketplace_images WHERE listing_id = $1 AND id = ANY($2::int[])`, [listingId, input.removeImageIds]);
    }
    const count = await client.query(`SELECT COUNT(*)::int AS n, COALESCE(MAX(position), -1) AS max_pos FROM marketplace_images WHERE listing_id = $1`, [listingId]);
    const existing = count.rows[0].n as number;
    if (existing + input.addImages.length > MARKETPLACE_MAX_IMAGES) {
      throw Object.assign(new Error(`A listing can have up to ${MARKETPLACE_MAX_IMAGES} photos`), { status: 400 });
    }
    if (input.addImages.length) await insertImages(client, listingId, input.addImages, Number(count.rows[0].max_pos) + 1);
    if (input.imageOrder?.length) {
      for (let i = 0; i < input.imageOrder.length; i++) {
        await client.query(`UPDATE marketplace_images SET position = $1 WHERE listing_id = $2 AND id = $3`, [i, listingId, input.imageOrder[i]]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function handleError(res: Response, error: unknown): void {
  const status = (error as any)?.status;
  if (typeof status === "number") { res.status(status).json({ message: (error as Error).message }); return; }
  if (error instanceof z.ZodError) { res.status(400).json({ message: error.issues[0]?.message || "Invalid input" }); return; }
  const message = error instanceof Error ? error.message : "Request failed";
  if (/photo|image|Photos/i.test(message)) { res.status(400).json({ message }); return; }
  logger.error({ error }, "Marketplace request failed");
  res.status(500).json({ message: "Something went wrong. Please try again." });
}

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ---------- routes ----------

const submitLimiter = rateLimit({ windowMs: 10 * 60_000, max: 5, message: "Too many listings submitted. Please wait a few minutes and try again." });
const contactLimiter = rateLimit({ windowMs: 10 * 60_000, max: 8, message: "Too many messages sent. Please wait a few minutes and try again." });
const manageLimiter = rateLimit({ windowMs: 60_000, max: 60, message: "Too many requests. Please wait a minute and try again." });
const browseLimiter = rateLimit({ windowMs: 60_000, max: 240, message: "Too many requests. Please wait a minute and try again." });
// Each scan is a vision-model call, so keep it to a handful per listing session.
const scanLimiter = rateLimit({ windowMs: 10 * 60_000, max: 20, message: "Too many scans. Please wait a few minutes and try again." });

const scanSchema = z.object({ dataBase64: z.string().min(1) });
const lookupSchema = z.object({ query: z.string().trim().min(2, "Type a model or part number").max(200) });

export function registerMarketplaceRoutes(app: Express, options: { mailer?: MarketplaceMailer; scanReader?: VisionReader; lookupReader?: TextReader | null } = {}) {
  if (options.mailer) mailer = options.mailer;
  const scanReader = options.scanReader ?? claudeVisionReader;
  const scanEnabled = options.scanReader ? true : isVisionConfigured();
  // Text lookup always works (regex); the model only expands product codes when configured.
  const lookupReader = options.lookupReader !== undefined ? options.lookupReader : isVisionConfigured() ? claudeTextReader : null;
  // ===== Public: browse =====
  app.get("/api/portal/marketplace/listings", browseLimiter, async (req, res) => {
    try {
      const params: unknown[] = ["active"];
      const where: string[] = ["l.status = $1"];
      const category = String(req.query.category || "");
      if ((MARKETPLACE_CATEGORIES as readonly string[]).includes(category)) { params.push(category); where.push(`l.category = $${params.length}`); }
      const condition = String(req.query.condition || "");
      if ((MARKETPLACE_CONDITIONS as readonly string[]).includes(condition)) { params.push(condition); where.push(`l.condition = $${params.length}`); }
      const q = String(req.query.q || "").trim().slice(0, 80);
      if (q) { params.push(`%${q}%`); where.push(`(l.title ILIKE $${params.length} OR l.description ILIKE $${params.length} OR l.specs::text ILIKE $${params.length})`); }
      const maxPrice = Number(req.query.maxPrice);
      if (Number.isFinite(maxPrice) && maxPrice > 0) { params.push(toCents(maxPrice)); where.push(`l.price_cents <= $${params.length}`); }
      const sort = String(req.query.sort || "newest");
      const orderBy = sort === "price_asc" ? "l.price_cents ASC, l.published_at DESC"
        : sort === "price_desc" ? "l.price_cents DESC, l.published_at DESC"
        : "l.published_at DESC NULLS LAST, l.id DESC";
      const result = await pool.query(`${LISTING_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${orderBy} LIMIT 200`, params);
      res.json({ listings: (result.rows as ListingRow[]).map(publicListing) });
    } catch (error) { handleError(res, error); }
  });

  app.get("/api/portal/marketplace/listings/:id", browseLimiter, async (req, res) => {
    try {
      const id = parseId(String(req.params.id));
      if (!id) { res.status(404).json({ message: "Listing not found" }); return; }
      const row = await loadListing("l.id = $1 AND l.status IN ('active','sold')", [id]);
      if (!row) { res.status(404).json({ message: "This listing is no longer available" }); return; }
      if (row.status === "active") {
        void pool.query(`UPDATE marketplace_listings SET view_count = view_count + 1 WHERE id = $1`, [id]).catch(() => {});
      }
      res.json(publicListing(row));
    } catch (error) { handleError(res, error); }
  });

  app.get("/api/portal/marketplace/images/:id", async (req, res) => {
    try {
      const id = parseId(String(req.params.id));
      if (!id) { res.status(404).end(); return; }
      const result = await pool.query(`SELECT mime_type, data FROM marketplace_images WHERE id = $1`, [id]);
      if (!result.rowCount) { res.status(404).end(); return; }
      res.setHeader("Content-Type", result.rows[0].mime_type);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(result.rows[0].data);
    } catch (error) { handleError(res, error); }
  });

  // ===== Public: sell =====
  app.post("/api/portal/marketplace/listings", submitLimiter, async (req, res) => {
    try {
      const input = portalCreateSchema.parse(req.body);
      const token = newToken();
      const client = await pool.connect();
      let listingId: number;
      try {
        await client.query("BEGIN");
        const inserted = await client.query(
          `INSERT INTO marketplace_listings (title, description, category, condition, price_cents, specs, location, seller_name, seller_email, seller_phone, show_phone, status, source, manage_token_hash)
           VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''),$8,$9,NULLIF($10,''),$11,'pending','portal',$12) RETURNING id`,
          [input.title, input.description, input.category, input.condition, toCents(input.price), JSON.stringify(input.specs), input.location, input.sellerName, input.sellerEmail, input.sellerPhone, input.showPhone, tokenHash(token)],
        );
        listingId = inserted.rows[0].id;
        await insertImages(client, listingId, input.images, 0);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      const row = (await loadListing("l.id = $1", [listingId]))!;
      const emailed = await emailSellerManageLink(row, token, "submitted");
      void emailStaffNewListing(row);
      res.status(201).json({ id: listingId, managePath: `/portal/marketplace/manage/${token}`, emailed });
    } catch (error) { handleError(res, error); }
  });

  // ===== Public: CyberScan — read a label photo into listing suggestions =====
  app.get("/api/portal/marketplace/scan/status", browseLimiter, (_req, res) => {
    res.json({ enabled: scanEnabled });
  });

  app.post("/api/portal/marketplace/scan", scanLimiter, async (req, res) => {
    try {
      if (!scanEnabled) { res.status(503).json({ message: "Scanning isn't available right now. Fill in the details by hand." }); return; }
      const input = scanSchema.parse(req.body);
      const { buffer, mimeType } = decodeImage(input);
      const result = await scanHardwareImage({ dataBase64: buffer.toString("base64"), mimeType }, scanReader);
      res.json(result);
    } catch (error) {
      if (!(error instanceof z.ZodError) && !/photo|image/i.test((error as Error)?.message || "")) {
        logger.warn({ error }, "CyberScan failed");
        res.status(502).json({ message: "The scanner couldn't read that photo. Try a sharper, closer shot of the label." });
        return;
      }
      handleError(res, error);
    }
  });

  app.post("/api/portal/marketplace/scan/lookup", scanLimiter, async (req, res) => {
    try {
      const input = lookupSchema.parse(req.body);
      res.json(await lookupHardwareText(input.query, lookupReader));
    } catch (error) { handleError(res, error); }
  });

  app.post("/api/portal/marketplace/listings/:id/contact", contactLimiter, async (req, res) => {
    try {
      const id = parseId(String(req.params.id));
      if (!id) { res.status(404).json({ message: "Listing not found" }); return; }
      const input = contactSchema.parse(req.body);
      const row = await loadListing("l.id = $1 AND l.status = 'active'", [id]);
      if (!row) { res.status(404).json({ message: "This listing is no longer available" }); return; }
      const emailed = await emailSellerInquiry(row, input);
      await pool.query(
        `INSERT INTO marketplace_inquiries (listing_id, buyer_name, buyer_email, buyer_phone, message, ip_address, email_sent) VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7)`,
        [id, input.buyerName, input.buyerEmail, input.buyerPhone, input.message, ipFrom(req), emailed],
      );
      res.status(201).json({ ok: true, emailed });
    } catch (error) { handleError(res, error); }
  });

  // ===== Public: seller manage link =====
  const sellerByToken = async (token: string) => {
    if (!token || token.length > 128) return null;
    return loadListing("l.manage_token_hash = $1", [tokenHash(token)]);
  };

  app.get("/api/portal/marketplace/manage/:token", manageLimiter, async (req, res) => {
    try {
      const row = await sellerByToken(String(req.params.token));
      if (!row) { res.status(404).json({ message: "This link is not valid. Check your email for the latest manage link." }); return; }
      res.json({ listing: fullListing(row), inquiries: await loadInquiries(row.id) });
    } catch (error) { handleError(res, error); }
  });

  app.patch("/api/portal/marketplace/manage/:token", manageLimiter, async (req, res) => {
    try {
      const row = await sellerByToken(String(req.params.token));
      if (!row) { res.status(404).json({ message: "This link is not valid" }); return; }
      if (row.status === "removed") { res.status(409).json({ message: "This listing was removed and can no longer be edited" }); return; }
      const input = updateSchema.parse(req.body);
      // A rejected listing that the seller fixes goes back into the review queue.
      const extraSet = row.status === "rejected" ? ["status", "review_note"] : [];
      const extraParams = row.status === "rejected" ? ["pending", null] : [];
      await applyUpdate(row.id, input, extraSet, extraParams);
      const updated = (await loadListing("l.id = $1", [row.id]))!;
      if (row.status === "rejected") void emailStaffNewListing(updated);
      res.json({ listing: fullListing(updated), inquiries: await loadInquiries(row.id) });
    } catch (error) { handleError(res, error); }
  });

  app.post("/api/portal/marketplace/manage/:token/status", manageLimiter, async (req, res) => {
    try {
      const row = await sellerByToken(String(req.params.token));
      if (!row) { res.status(404).json({ message: "This link is not valid" }); return; }
      const { status } = sellerStatusSchema.parse(req.body);
      const allowed: Record<string, ListingStatus[]> = {
        sold: ["active"],
        removed: ["pending", "active", "sold", "rejected"],
        active: ["sold"],
      };
      if (!allowed[status].includes(row.status)) {
        { res.status(409).json({ message: `A ${row.status} listing cannot be marked ${status}` }); return; }
      }
      await pool.query(
        `UPDATE marketplace_listings SET status = $2, sold_at = CASE WHEN $2 = 'sold' THEN NOW() ELSE NULL END, updated_at = NOW() WHERE id = $1`,
        [row.id, status],
      );
      const updated = (await loadListing("l.id = $1", [row.id]))!;
      res.json({ listing: fullListing(updated), inquiries: await loadInquiries(row.id) });
    } catch (error) { handleError(res, error); }
  });

  // ===== Staff (gated by the "marketplace" feature in security.ts) =====
  app.get("/api/marketplace/listings", async (req, res) => {
    try {
      const status = String(req.query.status || "");
      const params: unknown[] = [];
      let where = "TRUE";
      if ((MARKETPLACE_STATUSES as readonly string[]).includes(status)) { params.push(status); where = `l.status = $1`; }
      const [rows, counts] = await Promise.all([
        pool.query(`${LISTING_SELECT} WHERE ${where} ORDER BY CASE l.status WHEN 'pending' THEN 0 ELSE 1 END, l.updated_at DESC LIMIT 500`, params),
        pool.query(`SELECT status, COUNT(*)::int AS n FROM marketplace_listings GROUP BY status`),
      ]);
      const countMap = Object.fromEntries(MARKETPLACE_STATUSES.map((s) => [s, 0])) as Record<ListingStatus, number>;
      for (const r of counts.rows) countMap[r.status as ListingStatus] = r.n;
      res.json({ listings: (rows.rows as ListingRow[]).map(fullListing), counts: countMap });
    } catch (error) { handleError(res, error); }
  });

  app.get("/api/marketplace/listings/:id", async (req, res) => {
    try {
      const id = parseId(String(req.params.id));
      if (!id) { res.status(404).json({ message: "Listing not found" }); return; }
      const row = await loadListing("l.id = $1", [id]);
      if (!row) { res.status(404).json({ message: "Listing not found" }); return; }
      res.json({ listing: fullListing(row), inquiries: await loadInquiries(id) });
    } catch (error) { handleError(res, error); }
  });

  // Staff posting on behalf of a customer who called in — goes live immediately.
  app.post("/api/marketplace/listings", async (req, res) => {
    try {
      const input = staffCreateSchema.parse(req.body);
      const token = newToken();
      const client = await pool.connect();
      let listingId: number;
      try {
        await client.query("BEGIN");
        const inserted = await client.query(
          `INSERT INTO marketplace_listings (title, description, category, condition, price_cents, specs, location, seller_name, seller_email, seller_phone, show_phone, status, source, manage_token_hash, created_by_user_id, reviewed_by_user_id, reviewed_at, published_at)
           VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,''),$8,$9,NULLIF($10,''),$11,'active','staff',$12,$13,$13,NOW(),NOW()) RETURNING id`,
          [input.title, input.description, input.category, input.condition, toCents(input.price), JSON.stringify(input.specs), input.location, input.sellerName, input.sellerEmail, input.sellerPhone, input.showPhone, tokenHash(token), req.dbUser?.id ?? null],
        );
        listingId = inserted.rows[0].id;
        await insertImages(client, listingId, input.images, 0);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      const row = (await loadListing("l.id = $1", [listingId]))!;
      const emailed = await emailSellerManageLink(row, token, "staff_posted");
      res.status(201).json({ listing: fullListing(row), managePath: `/portal/marketplace/manage/${token}`, emailed });
    } catch (error) { handleError(res, error); }
  });

  app.patch("/api/marketplace/listings/:id", async (req, res) => {
    try {
      const id = parseId(String(req.params.id));
      if (!id) { res.status(404).json({ message: "Listing not found" }); return; }
      const input = updateSchema.parse(req.body);
      await applyUpdate(id, input);
      const row = (await loadListing("l.id = $1", [id]))!;
      res.json({ listing: fullListing(row), inquiries: await loadInquiries(id) });
    } catch (error) { handleError(res, error); }
  });

  app.post("/api/marketplace/listings/:id/status", async (req, res) => {
    try {
      const id = parseId(String(req.params.id));
      if (!id) { res.status(404).json({ message: "Listing not found" }); return; }
      const { status, note } = staffStatusSchema.parse(req.body);
      const row = await loadListing("l.id = $1", [id]);
      if (!row) { res.status(404).json({ message: "Listing not found" }); return; }
      if (status === "rejected" && !note) { res.status(400).json({ message: "Add a short note so the seller knows what to fix" }); return; }
      const approving = status === "active" && row.status === "pending";
      const rejecting = status === "rejected" && row.status !== "rejected";
      await pool.query(
        `UPDATE marketplace_listings
         SET status = $2,
             review_note = CASE WHEN $2 = 'rejected' THEN $3 ELSE review_note END,
             reviewed_by_user_id = CASE WHEN $2 IN ('active','rejected') THEN $4 ELSE reviewed_by_user_id END,
             reviewed_at = CASE WHEN $2 IN ('active','rejected') THEN NOW() ELSE reviewed_at END,
             published_at = CASE WHEN $2 = 'active' AND published_at IS NULL THEN NOW() ELSE published_at END,
             sold_at = CASE WHEN $2 = 'sold' THEN COALESCE(sold_at, NOW()) WHEN $2 = 'active' THEN NULL ELSE sold_at END,
             updated_at = NOW()
         WHERE id = $1`,
        [id, status, note || null, req.dbUser?.id ?? null],
      );
      const updated = (await loadListing("l.id = $1", [id]))!;
      let emailed: boolean | null = null;
      if (approving) emailed = await emailSellerDecision(updated, true, "");
      else if (rejecting) emailed = await emailSellerDecision(updated, false, note);
      res.json({ listing: fullListing(updated), inquiries: await loadInquiries(id), emailed });
    } catch (error) { handleError(res, error); }
  });

  // Regenerate the seller's private link (e.g. the customer lost the email).
  app.post("/api/marketplace/listings/:id/resend-link", async (req, res) => {
    try {
      const id = parseId(String(req.params.id));
      if (!id) { res.status(404).json({ message: "Listing not found" }); return; }
      const token = newToken();
      const result = await pool.query(`UPDATE marketplace_listings SET manage_token_hash = $2, updated_at = NOW() WHERE id = $1 RETURNING id`, [id, tokenHash(token)]);
      if (!result.rowCount) { res.status(404).json({ message: "Listing not found" }); return; }
      const row = (await loadListing("l.id = $1", [id]))!;
      const emailed = await emailSellerManageLink(row, token, "resend");
      res.json({ managePath: `/portal/marketplace/manage/${token}`, emailed });
    } catch (error) { handleError(res, error); }
  });

  app.delete("/api/marketplace/listings/:id", async (req, res) => {
    try {
      const id = parseId(String(req.params.id));
      if (!id) { res.status(404).json({ message: "Listing not found" }); return; }
      const result = await pool.query(`DELETE FROM marketplace_listings WHERE id = $1`, [id]);
      if (!result.rowCount) { res.status(404).json({ message: "Listing not found" }); return; }
      res.json({ ok: true });
    } catch (error) { handleError(res, error); }
  });
}
