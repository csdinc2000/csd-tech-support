import type { Express, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import { pool } from "./db";
import { getStaffAssignmentScope, type StaffAssignmentScope } from "./staff-access";
import { sendEmail } from "./helpdesk-email";
import { logger } from "./lib/logger";
import { firstName } from "./referral-core";
import {
  MAX_PERCENT_OFF,
  MIN_PERCENT_OFF,
  businessDate,
  describeVoucher,
  formatDateOnly,
  formatUsd,
  makeVoucherCode,
  normalizeVoucherCode,
  summarizeVouchers,
  voucherDiscountCents,
  voucherState,
  type VoucherStatus,
} from "./voucher-core";

// ---------------------------------------------------------------------------
// Discount vouchers.
//
// Staff pick a percentage (1–100, optionally capped at a dollar amount and
// given an expiry date) and email a single-use code to a customer. While a
// voucher is active its percentage, cap, expiry and message can be adjusted
// and the email re-sent; the code stays the same. At checkout staff look the
// code up, see the discount for the bill, and redeem it — redemption is
// atomic, so a code can't be used twice.
//
// Nothing here touches invoices automatically: staff apply the discount on
// the invoice and can note the invoice number on the redemption.
//
// Staff only: /api/crm/vouchers/* (crm feature, path gate in security.ts).
// ---------------------------------------------------------------------------

const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || "America/New_York";
const today = () => businessDate(new Date(), BUSINESS_TIMEZONE);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------- storage ----------

type VoucherRow = {
  id: number; code: string; percent_off: number; max_discount_cents: number | null; expires_on: string | null;
  recipient_name: string; recipient_email: string; contact_id: number | null; message: string | null;
  status: VoucherStatus; redeemed_at: Date | null; redemption_note: string | null;
  last_emailed_at: Date | null; email_count: number; created_by_user_id: string | null; created_at: Date; updated_at: Date;
};

// expires_on comes back as text so a DATE never shifts across time zones.
const VOUCHER_COLUMNS = `id, code, percent_off, max_discount_cents, expires_on::text AS expires_on, recipient_name, recipient_email,
  contact_id, message, status, redeemed_at, redemption_note, last_emailed_at, email_count, created_by_user_id, created_at, updated_at`;

function toApi(row: VoucherRow, now = today()) {
  return {
    id: row.id,
    code: row.code,
    percentOff: row.percent_off,
    maxDiscountCents: row.max_discount_cents,
    expiresOn: row.expires_on,
    recipientName: row.recipient_name,
    recipientEmail: row.recipient_email,
    contactId: row.contact_id,
    message: row.message,
    status: row.status,
    state: voucherState({ status: row.status, expiresOn: row.expires_on }, now),
    redeemedAt: row.redeemed_at,
    redemptionNote: row.redemption_note,
    lastEmailedAt: row.last_emailed_at,
    emailCount: row.email_count,
    createdAt: row.created_at,
  };
}

async function loadVoucher(id: number): Promise<VoucherRow | undefined> {
  const { rows } = await pool.query(`SELECT ${VOUCHER_COLUMNS} FROM vouchers WHERE id = $1`, [id]);
  return rows[0];
}

// ---------- email ----------

export type VoucherMailer = (
  to: string,
  subject: string,
  text: string,
  options: { html: string; operation: "vouchers" },
) => Promise<unknown>;

// Swapped out by tests so no real email leaves the process.
let mailer: VoucherMailer = (to, subject, text, options) => sendEmail(to, subject, text, options);

export function voucherEmail(voucher: VoucherRow): { subject: string; text: string; html: string } {
  const offer = describeVoucher({ percentOff: voucher.percent_off, maxDiscountCents: voucher.max_discount_cents });
  const expiry = voucher.expires_on ? `Valid through ${formatDateOnly(voucher.expires_on)}.` : "No expiry date.";
  const subject = `Your ${voucher.percent_off}% off voucher from Computer Systems Depot`;
  const terms = "One use per voucher. Show this email or tell us the code when you book or pay. Applies to service and parts before tax; can't be combined with other offers or exchanged for cash.";
  const text = [
    `Hi ${firstName(voucher.recipient_name)},`,
    "",
    ...(voucher.message ? [voucher.message, ""] : []),
    `Here's ${offer}.`,
    `Voucher code: ${voucher.code}`,
    expiry,
    "",
    terms,
    "",
    "Book or ask a question: 954-637-7300",
  ].join("\n");
  const html = `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">
    <div style="background:#111;padding:16px 20px;border-top:4px solid #e60000">
      <span style="color:#fff;font-weight:700;font-size:16px">Computer Systems Depot</span>
      <span style="color:#bbb;font-size:13px;margin-left:8px">Discount voucher</span>
    </div>
    <div style="padding:20px;border:1px solid #e5e5e5;border-top:0">
      <p>Hi ${escapeHtml(firstName(voucher.recipient_name))},</p>
      ${voucher.message ? `<p>${escapeHtml(voucher.message).replace(/\n/g, "<br>")}</p>` : ""}
      <div style="margin:20px 0;padding:20px;border:2px dashed #e60000;border-radius:10px;text-align:center">
        <div style="font-size:40px;font-weight:800;color:#e60000;line-height:1">${voucher.percent_off}% OFF</div>
        <div style="margin-top:6px;font-size:14px;color:#333">${escapeHtml(offer)}</div>
        <div style="margin-top:14px;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:1px">Voucher code</div>
        <div style="font-family:Menlo,Consolas,monospace;font-size:24px;font-weight:700;letter-spacing:2px">${escapeHtml(voucher.code)}</div>
        <div style="margin-top:10px;font-size:13px;color:#444">${escapeHtml(expiry)}</div>
      </div>
      <p style="font-size:12px;color:#555">${escapeHtml(terms)}</p>
      <p>Book or ask a question: <a href="tel:+19546377300">954-637-7300</a></p>
    </div>
  </div>`;
  return { subject, text, html };
}

/** Sends the voucher email and records it. Returns false (and logs) instead of throwing. */
async function emailVoucher(voucher: VoucherRow): Promise<boolean> {
  const { subject, text, html } = voucherEmail(voucher);
  try {
    await mailer(voucher.recipient_email, subject, text, { html, operation: "vouchers" });
  } catch (error) {
    logger.warn({ error, voucherId: voucher.id }, "Voucher email could not be sent");
    return false;
  }
  await pool.query(`UPDATE vouchers SET last_emailed_at = NOW(), email_count = email_count + 1 WHERE id = $1`, [voucher.id]);
  return true;
}

// ---------- validation ----------

const percentSchema = z.number().int("Use a whole-number percentage")
  .min(MIN_PERCENT_OFF, `Discount must be at least ${MIN_PERCENT_OFF}%`)
  .max(MAX_PERCENT_OFF, `Discount can't be more than ${MAX_PERCENT_OFF}%`);
const capSchema = z.number().int().positive("Max discount must be more than $0").max(10_000_000).nullable();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD expiry date")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "Use a real expiry date")
  .nullable();
const messageSchema = z.string().trim().max(1000).nullable();

const createSchema = z.object({
  recipientName: z.string().trim().min(2, "Enter the customer's name").max(120),
  recipientEmail: z.string().trim().email("Enter a valid email").max(200),
  contactId: z.number().int().positive().nullable().optional(),
  percentOff: percentSchema,
  maxDiscountCents: capSchema.optional(),
  expiresOn: dateSchema.optional(),
  message: messageSchema.optional(),
  send: z.boolean().optional(),
});

const updateSchema = z.object({
  percentOff: percentSchema.optional(),
  maxDiscountCents: capSchema.optional(),
  expiresOn: dateSchema.optional(),
  message: messageSchema.optional(),
  // "active" undoes a redemption or a void.
  status: z.enum(["active", "void"]).optional(),
  resend: z.boolean().optional(),
});

const redeemSchema = z.object({
  code: z.string().optional(),
  note: z.string().trim().max(500).optional(),
});

function handleError(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) { res.status(400).json({ message: error.issues[0]?.message || "Invalid input" }); return; }
  logger.error({ error }, "Voucher request failed");
  res.status(500).json({ message: "Something went wrong. Please try again." });
}

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const staffId = (req: Request) => req.dbUser?.id ?? null;

// Same visibility rule as the rest of the CRM (owners and staff admins see
// everything, other staff their assigned contacts), plus staff always see the
// vouchers they sent themselves.
const canSeeVoucher = (scope: StaffAssignmentScope, row: { contact_id: number | null; created_by_user_id: string | null }, userId: string | null) =>
  scope.unrestricted
  || (row.contact_id != null && scope.contactIds.has(Number(row.contact_id)))
  || (userId != null && row.created_by_user_id === userId);

// ---------- routes ----------

export function registerVoucherRoutes(app: Express, options: { mailer?: VoucherMailer } = {}) {
  if (options.mailer) mailer = options.mailer;

  app.get("/api/crm/vouchers", async (req, res) => {
    try {
      const scope = await getStaffAssignmentScope(req);
      const userId = staffId(req);
      const { rows } = await pool.query(`SELECT ${VOUCHER_COLUMNS} FROM vouchers ORDER BY created_at DESC LIMIT 500`);
      const now = today();
      const vouchers = (rows as VoucherRow[]).filter((r) => canSeeVoucher(scope, r, userId)).map((r) => toApi(r, now));
      res.json({ today: now, summary: summarizeVouchers(vouchers.map((v) => v.state)), vouchers });
    } catch (error) { handleError(res, error); }
  });

  app.post("/api/crm/vouchers", async (req, res) => {
    try {
      const input = createSchema.parse(req.body);
      if (input.expiresOn && input.expiresOn < today()) {
        res.status(400).json({ message: "The expiry date is in the past" });
        return;
      }
      const email = input.recipientEmail.toLowerCase();
      // Link to the CRM contact so assignment-scoped staff see it on their customers.
      const contactId = input.contactId
        ?? (await pool.query(`SELECT id FROM crm_contacts WHERE LOWER(email) = $1 ORDER BY id LIMIT 1`, [email])).rows[0]?.id
        ?? null;
      let voucher: VoucherRow | undefined;
      for (let attempt = 0; attempt < 6 && !voucher; attempt++) {
        try {
          const { rows } = await pool.query(
            `INSERT INTO vouchers (code, percent_off, max_discount_cents, expires_on, recipient_name, recipient_email, contact_id, message, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${VOUCHER_COLUMNS}`,
            [makeVoucherCode(randomBytes), input.percentOff, input.maxDiscountCents ?? null, input.expiresOn ?? null,
              input.recipientName, email, contactId, input.message || null, staffId(req)],
          );
          voucher = rows[0];
        } catch (error: any) {
          // Only a code collision is retried; anything else is a real failure.
          if (error?.code === "23505" && String(error?.constraint ?? "").includes("code")) continue;
          throw error;
        }
      }
      if (!voucher) throw new Error("Could not generate a unique voucher code");
      const emailed = input.send === false ? false : await emailVoucher(voucher);
      res.status(201).json({ voucher: toApi((await loadVoucher(voucher.id)) ?? voucher), emailed });
    } catch (error) { handleError(res, error); }
  });

  // Counter lookup: anyone with the CRM feature can check a code a customer
  // hands them (holding the code is the point), with an optional bill subtotal
  // to preview the discount.
  app.get("/api/crm/vouchers/lookup/:code", async (req, res) => {
    try {
      const code = normalizeVoucherCode(req.params.code);
      if (!code) { res.status(404).json({ message: "That isn't a voucher code" }); return; }
      const { rows } = await pool.query(`SELECT ${VOUCHER_COLUMNS} FROM vouchers WHERE code = $1`, [code]);
      const row: VoucherRow | undefined = rows[0];
      if (!row) { res.status(404).json({ message: "No voucher with that code" }); return; }
      const subtotalCents = Number(req.query.subtotalCents);
      const voucher = toApi(row);
      res.json({
        voucher,
        discountCents: Number.isFinite(subtotalCents) && subtotalCents > 0 && voucher.state === "active"
          ? voucherDiscountCents(Math.round(subtotalCents), row.percent_off, row.max_discount_cents)
          : null,
      });
    } catch (error) { handleError(res, error); }
  });

  // Redeem by id (from the list) or by code (from the counter lookup).
  // Single statement with the state check in the WHERE clause, so two people
  // redeeming the same code at once can't both succeed.
  const redeem = async (req: Request, res: Response, where: { id?: number; code?: string }) => {
    const input = redeemSchema.parse(req.body ?? {});
    const { rows } = await pool.query(
      `UPDATE vouchers
          SET status = 'redeemed', redeemed_at = NOW(), redemption_note = $3, redeemed_by_user_id = $4, updated_at = NOW()
        WHERE ${where.id != null ? "id = $1" : "code = $1"}
          AND status = 'active' AND (expires_on IS NULL OR expires_on >= $2::date)
        RETURNING ${VOUCHER_COLUMNS}`,
      [where.id ?? where.code, today(), input.note || null, staffId(req)],
    );
    if (rows[0]) { res.json({ voucher: toApi(rows[0]) }); return; }
    const existing = await pool.query(`SELECT ${VOUCHER_COLUMNS} FROM vouchers WHERE ${where.id != null ? "id = $1" : "code = $1"}`, [where.id ?? where.code]);
    if (!existing.rows[0]) { res.status(404).json({ message: "Voucher not found" }); return; }
    const state = toApi(existing.rows[0]).state;
    const reason = state === "redeemed" ? "This voucher was already redeemed" : state === "void" ? "This voucher was voided" : "This voucher has expired";
    res.status(409).json({ message: reason, voucher: toApi(existing.rows[0]) });
  };

  app.post("/api/crm/vouchers/redeem", async (req, res) => {
    try {
      const code = normalizeVoucherCode(req.body?.code);
      if (!code) { res.status(400).json({ message: "Enter a voucher code" }); return; }
      await redeem(req, res, { code });
    } catch (error) { handleError(res, error); }
  });

  app.post("/api/crm/vouchers/:id/redeem", async (req, res) => {
    try {
      const id = parseId(String(req.params.id));
      const row = id ? await loadVoucher(id) : undefined;
      if (!id || !row || !canSeeVoucher(await getStaffAssignmentScope(req), row, staffId(req))) {
        res.status(404).json({ message: "Voucher not found" });
        return;
      }
      await redeem(req, res, { id });
    } catch (error) { handleError(res, error); }
  });

  // Adjust an active voucher (percentage, cap, expiry, message), void it, or
  // reactivate it. `resend: true` emails the customer the updated voucher.
  app.patch("/api/crm/vouchers/:id", async (req, res) => {
    try {
      const id = parseId(String(req.params.id));
      const row = id ? await loadVoucher(id) : undefined;
      if (!id || !row || !canSeeVoucher(await getStaffAssignmentScope(req), row, staffId(req))) {
        res.status(404).json({ message: "Voucher not found" });
        return;
      }
      const input = updateSchema.parse(req.body);
      const editsTerms = input.percentOff !== undefined || input.maxDiscountCents !== undefined || input.expiresOn !== undefined || input.message !== undefined;
      const nextStatus = input.status ?? row.status;
      if (editsTerms && nextStatus !== "active") {
        res.status(409).json({ message: row.status === "redeemed" ? "A redeemed voucher can't be changed" : "Reactivate the voucher before changing it" });
        return;
      }
      if (input.expiresOn && input.expiresOn < today()) {
        res.status(400).json({ message: "The expiry date is in the past" });
        return;
      }

      const sets: string[] = ["updated_at = NOW()"];
      const params: unknown[] = [id];
      const set = (column: string, value: unknown) => { params.push(value); sets.push(`${column} = $${params.length}`); };
      if (input.percentOff !== undefined) set("percent_off", input.percentOff);
      if (input.maxDiscountCents !== undefined) set("max_discount_cents", input.maxDiscountCents);
      if (input.expiresOn !== undefined) set("expires_on", input.expiresOn);
      if (input.message !== undefined) set("message", input.message || null);
      if (input.status !== undefined && input.status !== row.status) {
        set("status", input.status);
        // Undoing a redemption clears it so the voucher reads as never used.
        if (input.status === "active") sets.push("redeemed_at = NULL", "redemption_note = NULL", "redeemed_by_user_id = NULL");
      }
      const { rows } = await pool.query(`UPDATE vouchers SET ${sets.join(", ")} WHERE id = $1 RETURNING ${VOUCHER_COLUMNS}`, params);
      const updated: VoucherRow = rows[0];
      let emailed = false;
      if (input.resend) {
        if (voucherState({ status: updated.status, expiresOn: updated.expires_on }, today()) !== "active") {
          res.status(409).json({ message: "Only active vouchers can be emailed", voucher: toApi(updated) });
          return;
        }
        emailed = await emailVoucher(updated);
      }
      res.json({ voucher: toApi((await loadVoucher(id)) ?? updated), emailed });
    } catch (error) { handleError(res, error); }
  });
}
