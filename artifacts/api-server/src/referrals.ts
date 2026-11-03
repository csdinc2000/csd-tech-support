import type { Express, Request, Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod/v4";
import { pool } from "./db";
import { rateLimit } from "./security";
import { getStaffAssignmentScope, type StaffAssignmentScope } from "./staff-access";
import { sendEmail } from "./helpdesk-email";
import { logger } from "./lib/logger";
import {
  REFERRAL_STATUSES,
  firstName,
  isSelfReferral,
  makeReferralCode,
  maskedFriendName,
  normalizeReferralCode,
  statusTimestamps,
  summarizeReferrals,
} from "./referral-core";

// ---------------------------------------------------------------------------
// Customer referral program.
//
// Customers have no accounts, so a referrer joins with name + email and gets
// a private dashboard link by email (token hashed at rest — same model as
// marketplace sellers). The join response never says whether the email was
// already enrolled, and never returns the code: only the inbox owner sees it.
//
// Friends use the referrer's share link (`/intake?ref=CODE`). When a service
// request arrives with a code, `recordIntakeReferral` (called after the intake
// commits) adds a pending referral. Staff qualify it once the friend's first
// paid job is done and mark it rewarded when the reward is issued — rewards
// cost money, so nothing is automatic.
//
// Public: /api/portal/referrals/*   Staff: /api/crm/referrals/* (crm feature)
// ---------------------------------------------------------------------------

function appBaseUrl(): string {
  const configured = process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:5000";
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
export const shareUrlFor = (code: string) => `${appBaseUrl()}/intake?ref=${encodeURIComponent(code)}`;
const dashboardUrlFor = (token: string) => `${appBaseUrl()}/portal/referrals/r/${token}`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------- email ----------

export type ReferralMailer = (
  to: string,
  subject: string,
  text: string,
  options: { html: string; operation: "referrals" },
) => Promise<unknown>;

// Swapped out by tests so no real email leaves the process.
let mailer: ReferralMailer = (to, subject, text, options) => sendEmail(to, subject, text, options);

async function safeSend(to: string, subject: string, text: string, html: string): Promise<boolean> {
  try {
    await mailer(to, subject, text, { html, operation: "referrals" });
    return true;
  } catch (error) {
    logger.warn({ error, subject }, "Referral email could not be sent");
    return false;
  }
}

function emailShell(title: string, bodyHtml: string) {
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">
    <div style="background:#111;padding:16px 20px;border-top:4px solid #e60000">
      <span style="color:#fff;font-weight:700;font-size:16px">Computer Systems Depot</span>
      <span style="color:#bbb;font-size:13px;margin-left:8px">Refer a Friend</span>
    </div>
    <div style="padding:20px;border:1px solid #e5e5e5;border-top:0">
      <h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(title)}</h2>
      ${bodyHtml}
    </div>
  </div>`;
}

function button(href: string, label: string) {
  return `<p style="margin:20px 0"><a href="${escapeHtml(href)}" style="background:#e60000;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;display:inline-block">${escapeHtml(label)}</a></p>`;
}

async function emailDashboardLink(referrer: ReferrerRow, token: string, settings: ProgramSettings): Promise<boolean> {
  const url = dashboardUrlFor(token);
  const share = shareUrlFor(referrer.code);
  const subject = "Your Computer Systems Depot referral link";
  const text = `Hi ${firstName(referrer.full_name)},\n\nThanks for spreading the word! Share this link with friends and family:\n${share}\n\nYour code: ${referrer.code}\nThey get: ${settings.friend_reward}\nYou get: ${settings.referrer_reward} after their first service is completed.\n\nTrack your referrals here (keep this link private):\n${url}`;
  const html = emailShell(subject, `
    <p>Hi ${escapeHtml(firstName(referrer.full_name))}, thanks for spreading the word!</p>
    <p>Your code: <strong style="font-size:18px;letter-spacing:1px">${escapeHtml(referrer.code)}</strong></p>
    <p>Friends get <strong>${escapeHtml(settings.friend_reward)}</strong>. You get <strong>${escapeHtml(settings.referrer_reward)}</strong> after their first service is completed.</p>
    <p>Share this link:<br><a href="${escapeHtml(share)}">${escapeHtml(share)}</a></p>
    ${button(url, "Open my referral dashboard")}
    <p style="font-size:13px;color:#444">Keep the dashboard link private. If you didn't ask for this, you can ignore this email.</p>
  `);
  return safeSend(referrer.email, subject, text, html);
}

async function emailFriendJoined(referrer: ReferrerRow, friendName: string) {
  const subject = `${maskedFriendName(friendName)} used your referral code`;
  const text = `Good news! ${maskedFriendName(friendName)} just requested service with your referral code ${referrer.code}. We'll let you know when your reward is ready.`;
  const html = emailShell(subject, `<p>Good news! <strong>${escapeHtml(maskedFriendName(friendName))}</strong> just requested service with your code <strong>${escapeHtml(referrer.code)}</strong>.</p><p>We'll email you when your reward is ready.</p>`);
  return safeSend(referrer.email, subject, text, html);
}

async function emailRewardReady(referrer: { full_name: string; email: string }, friendName: string, settings: ProgramSettings) {
  const subject = "Your referral reward is ready";
  const text = `Hi ${firstName(referrer.full_name)},\n\nThank you for referring ${maskedFriendName(friendName)}! Your reward (${settings.referrer_reward}) has been added. Mention it on your next visit or call us at 954-637-7300 with any questions.`;
  const html = emailShell(subject, `<p>Hi ${escapeHtml(firstName(referrer.full_name))},</p><p>Thank you for referring <strong>${escapeHtml(maskedFriendName(friendName))}</strong>! Your reward — <strong>${escapeHtml(settings.referrer_reward)}</strong> — has been added to your account.</p><p>Questions? Call us at 954-637-7300.</p>`);
  return safeSend(referrer.email, subject, text, html);
}

// ---------- storage ----------

type ProgramSettings = { active: boolean; referrer_reward: string; friend_reward: string; terms: string; updated_at: Date };
type ReferrerRow = {
  id: number; code: string; full_name: string; email: string; phone: string | null;
  contact_id: number | null; status: "active" | "paused"; created_at: Date;
};

type Queryable = { query: typeof pool.query };

async function loadSettings(db: Queryable = pool): Promise<ProgramSettings> {
  const { rows } = await db.query(`SELECT active, referrer_reward, friend_reward, terms, updated_at FROM referral_program_settings WHERE id = 1`);
  if (rows[0]) return rows[0];
  // Migration seeds the row; this only covers a database where it was deleted.
  await db.query(`INSERT INTO referral_program_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  return loadSettings(db);
}

const publicSettings = (s: ProgramSettings) => ({ active: s.active, referrerReward: s.referrer_reward, friendReward: s.friend_reward, terms: s.terms });

const REFERRER_COLUMNS = "id, code, full_name, email, phone, contact_id, status, created_at";

/**
 * Enrolls a customer, or — if the email is already enrolled — issues a fresh
 * dashboard token (the old link stops working) without touching their name,
 * so a stranger can't rename someone else's referrer record.
 */
async function enrollReferrer(input: { fullName: string; email: string; phone?: string | null; enrolledBy?: string | null; retried?: boolean }): Promise<{ referrer: ReferrerRow; token: string; created: boolean }> {
  const email = input.email.trim().toLowerCase();
  const token = newToken();
  const client = await pool.connect();
  let released = false;
  try {
    await client.query("BEGIN");
    const existing = await client.query(`SELECT ${REFERRER_COLUMNS} FROM referrers WHERE email = $1 FOR UPDATE`, [email]);
    if (existing.rows[0]) {
      await client.query(`UPDATE referrers SET token_hash = $2, updated_at = NOW() WHERE id = $1`, [existing.rows[0].id, tokenHash(token)]);
      await client.query("COMMIT");
      return { referrer: existing.rows[0], token, created: false };
    }
    const contact = await client.query(`SELECT id FROM crm_contacts WHERE LOWER(email) = $1 ORDER BY id LIMIT 1`, [email]);
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = makeReferralCode(input.fullName, randomBytes);
      await client.query("SAVEPOINT referrer_code");
      try {
        const inserted = await client.query(
          `INSERT INTO referrers (code, full_name, email, phone, contact_id, token_hash, enrolled_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${REFERRER_COLUMNS}`,
          [code, input.fullName.trim(), email, input.phone?.trim() || null, contact.rows[0]?.id ?? null, tokenHash(token), input.enrolledBy ?? null],
        );
        await client.query("COMMIT");
        return { referrer: inserted.rows[0], token, created: true };
      } catch (error: any) {
        // Only a code collision is retried; anything else is a real failure.
        if (error?.code === "23505" && String(error?.constraint ?? "").includes("code")) {
          await client.query("ROLLBACK TO SAVEPOINT referrer_code");
          continue;
        }
        throw error;
      }
    }
    throw new Error("Could not generate a unique referral code");
  } catch (error: any) {
    await client.query("ROLLBACK").catch(() => {});
    // Two sign-ups for the same new email raced: the other one created the
    // row, so take the "already enrolled" path (which rotates the token).
    if (error?.code === "23505" && String(error?.constraint ?? "").includes("email") && !input.retried) {
      client.release();
      released = true;
      return enrollReferrer({ ...input, retried: true });
    }
    throw error;
  } finally {
    if (!released) client.release();
  }
}

/**
 * Called by POST /api/intake after the CRM rows commit. Best effort: it logs
 * and returns null instead of throwing, so a referral problem can never fail
 * a customer's service request. Idempotent per intake record.
 */
export async function recordIntakeReferral(input: {
  code: unknown;
  intakeRecordId: number;
  leadId: number | null;
  contactId: number | null;
  existingCustomer: boolean;
  friendName: string;
  friendEmail: string | null;
  friendPhone: string | null;
}): Promise<{ referralId: number } | null> {
  const code = normalizeReferralCode(input.code);
  if (!code) return null;
  try {
    const settings = await loadSettings();
    if (!settings.active) return null;
    const { rows } = await pool.query(`SELECT ${REFERRER_COLUMNS} FROM referrers WHERE code = $1 AND status = 'active'`, [code]);
    const referrer: ReferrerRow | undefined = rows[0];
    if (!referrer) return null;
    if (isSelfReferral(referrer, { email: input.friendEmail, phone: input.friendPhone })) return null;
    if (referrer.contact_id != null && referrer.contact_id === input.contactId) return null;
    const inserted = await pool.query(
      `INSERT INTO referrals (referrer_id, intake_record_id, lead_id, contact_id, friend_name, friend_email, friend_phone, existing_customer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (intake_record_id) DO NOTHING RETURNING id`,
      [referrer.id, input.intakeRecordId, input.leadId, input.contactId, input.friendName.trim(), input.friendEmail, input.friendPhone, input.existingCustomer],
    );
    if (!inserted.rows[0]) return null;
    void emailFriendJoined(referrer, input.friendName);
    return { referralId: Number(inserted.rows[0].id) };
  } catch (error) {
    logger.warn({ error, intakeRecordId: input.intakeRecordId }, "Could not record intake referral");
    return null;
  }
}

async function referralsForReferrer(referrerId: number) {
  const { rows } = await pool.query(
    `SELECT friend_name, status, created_at, rewarded_at FROM referrals WHERE referrer_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [referrerId],
  );
  return rows as Array<{ friend_name: string; status: string; created_at: Date; rewarded_at: Date | null }>;
}

// ---------- validation ----------

const joinSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your name").max(120),
  email: z.string().trim().email("Enter a valid email").max(200),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
});

const settingsSchema = z.object({
  active: z.boolean(),
  referrerReward: z.string().trim().min(1, "Describe the referrer reward").max(120),
  friendReward: z.string().trim().min(1, "Describe the friend reward").max(120),
  terms: z.string().trim().min(1, "Terms are required").max(2000),
});

const updateReferralSchema = z.object({
  status: z.enum(REFERRAL_STATUSES).optional(),
  note: z.string().trim().max(1000).optional(),
});

function handleError(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) { res.status(400).json({ message: error.issues[0]?.message || "Invalid input" }); return; }
  logger.error({ error }, "Referral request failed");
  res.status(500).json({ message: "Something went wrong. Please try again." });
}

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const staffId = (req: Request) => req.dbUser?.id ?? null;

// Same visibility rule as the rest of the CRM: owners and staff admins see
// every contact; other staff only contacts assigned to them. Referrals follow
// the friend's contact, referrers their own contact.
const canSeeContact = (scope: StaffAssignmentScope, contactId: number | null | undefined) =>
  scope.unrestricted || (contactId != null && scope.contactIds.has(Number(contactId)));

// ---------- routes ----------

const joinLimiter = rateLimit({ windowMs: 10 * 60_000, max: 5, message: "Too many requests. Please wait a few minutes and try again." });
const readLimiter = rateLimit({ windowMs: 60_000, max: 60, message: "Too many requests. Please wait a minute and try again." });

export function registerReferralRoutes(app: Express, options: { mailer?: ReferralMailer } = {}) {
  if (options.mailer) mailer = options.mailer;

  // ===== Public =====
  app.get("/api/portal/referrals/program", readLimiter, async (_req, res) => {
    try { res.json(publicSettings(await loadSettings())); } catch (error) { handleError(res, error); }
  });

  app.post("/api/portal/referrals/join", joinLimiter, async (req, res) => {
    try {
      const input = joinSchema.parse(req.body);
      const settings = await loadSettings();
      if (!settings.active) { res.status(409).json({ message: "The referral program is paused right now. Please check back soon." }); return; }
      const { referrer, token } = await enrollReferrer(input);
      const sent = await emailDashboardLink(referrer, token, settings);
      if (!sent) { res.status(502).json({ message: "We couldn't send the email right now. Please try again later or call 954-637-7300." }); return; }
      // Same answer whether or not the email was already enrolled.
      res.json({ ok: true, message: "Check your email for your referral link." });
    } catch (error) { handleError(res, error); }
  });

  app.get("/api/portal/referrals/r/:token", readLimiter, async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT ${REFERRER_COLUMNS} FROM referrers WHERE token_hash = $1`, [tokenHash(String(req.params.token))]);
      const referrer: ReferrerRow | undefined = rows[0];
      if (!referrer) { res.status(404).json({ message: "This link is no longer valid. Request a new one from the referral page." }); return; }
      const [settings, referrals] = await Promise.all([loadSettings(), referralsForReferrer(referrer.id)]);
      res.json({
        referrer: { firstName: firstName(referrer.full_name), code: referrer.code, shareUrl: shareUrlFor(referrer.code), status: referrer.status },
        program: publicSettings(settings),
        summary: summarizeReferrals(referrals),
        // Referrers only ever see a first name and last initial.
        referrals: referrals.map((r) => ({ friendName: maskedFriendName(r.friend_name), status: r.status, createdAt: r.created_at, rewardedAt: r.rewarded_at })),
      });
    } catch (error) { handleError(res, error); }
  });

  // Lets the intake form greet a referred friend. Reveals only a first name.
  app.get("/api/portal/referrals/code/:code", readLimiter, async (req, res) => {
    try {
      const code = normalizeReferralCode(req.params.code);
      const settings = await loadSettings();
      if (!code || !settings.active) { res.json({ valid: false }); return; }
      const { rows } = await pool.query(`SELECT full_name FROM referrers WHERE code = $1 AND status = 'active'`, [code]);
      if (!rows[0]) { res.json({ valid: false }); return; }
      res.json({ valid: true, code, referrerFirstName: firstName(rows[0].full_name), friendReward: settings.friend_reward });
    } catch (error) { handleError(res, error); }
  });

  // ===== Staff (crm feature, enforced by the path gate in security.ts) =====
  app.get("/api/crm/referrals", async (req, res) => {
    try {
      const scope = await getStaffAssignmentScope(req);
      const [settings, allReferrals, allReferrers] = await Promise.all([
        loadSettings(),
        pool.query(`
          SELECT r.id, r.status, r.friend_name, r.friend_email, r.friend_phone, r.existing_customer, r.staff_note,
                 r.intake_record_id, r.lead_id, r.contact_id, r.created_at, r.qualified_at, r.rewarded_at,
                 ref.id AS referrer_id, ref.full_name AS referrer_name, ref.email AS referrer_email, ref.code AS referrer_code,
                 l.status AS lead_status,
                 EXISTS (SELECT 1 FROM crm_jobs j WHERE j.lead_id = r.lead_id AND j.status = 'completed') AS job_completed
            FROM referrals r
            JOIN referrers ref ON ref.id = r.referrer_id
            LEFT JOIN crm_leads l ON l.id = r.lead_id
           ORDER BY r.created_at DESC
           LIMIT 500`),
        pool.query(`
          SELECT ref.id, ref.code, ref.full_name, ref.email, ref.phone, ref.contact_id, ref.status, ref.created_at,
                 COUNT(r.id)::int AS referral_count,
                 COUNT(r.id) FILTER (WHERE r.status = 'rewarded')::int AS rewarded_count
            FROM referrers ref
            LEFT JOIN referrals r ON r.referrer_id = ref.id
           GROUP BY ref.id
           ORDER BY ref.created_at DESC
           LIMIT 500`),
      ]);
      const referrals = { rows: allReferrals.rows.filter((r) => canSeeContact(scope, r.contact_id)) };
      const referrers = { rows: allReferrers.rows.filter((r) => canSeeContact(scope, r.contact_id)) };
      res.json({
        settings: publicSettings(settings),
        summary: summarizeReferrals(referrals.rows),
        referrals: referrals.rows.map((r) => ({
          id: r.id, status: r.status, friendName: r.friend_name, friendEmail: r.friend_email, friendPhone: r.friend_phone,
          existingCustomer: r.existing_customer, note: r.staff_note, intakeRecordId: r.intake_record_id, leadId: r.lead_id,
          contactId: r.contact_id, createdAt: r.created_at, qualifiedAt: r.qualified_at, rewardedAt: r.rewarded_at,
          referrer: { id: r.referrer_id, name: r.referrer_name, email: r.referrer_email, code: r.referrer_code },
          leadStatus: r.lead_status, jobCompleted: r.job_completed,
        })),
        referrers: referrers.rows.map((r) => ({
          id: r.id, code: r.code, fullName: r.full_name, email: r.email, phone: r.phone, contactId: r.contact_id,
          status: r.status, createdAt: r.created_at, referralCount: r.referral_count, rewardedCount: r.rewarded_count,
          shareUrl: shareUrlFor(r.code),
        })),
      });
    } catch (error) { handleError(res, error); }
  });

  app.put("/api/crm/referrals/settings", async (req, res) => {
    try {
      const input = settingsSchema.parse(req.body);
      await pool.query(
        `UPDATE referral_program_settings
            SET active = $1, referrer_reward = $2, friend_reward = $3, terms = $4, updated_by_user_id = $5, updated_at = NOW()
          WHERE id = 1`,
        [input.active, input.referrerReward, input.friendReward, input.terms, staffId(req)],
      );
      res.json(publicSettings(await loadSettings()));
    } catch (error) { handleError(res, error); }
  });

  app.patch("/api/crm/referrals/:id", async (req, res) => {
    try {
      const id = parseId(String(req.params.id));
      if (!id) { res.status(400).json({ message: "Invalid referral" }); return; }
      const input = updateReferralSchema.parse(req.body);
      const current = await pool.query(
        `SELECT r.status, r.friend_name, r.contact_id, ref.full_name, ref.email FROM referrals r JOIN referrers ref ON ref.id = r.referrer_id WHERE r.id = $1`,
        [id],
      );
      if (!current.rows[0] || !canSeeContact(await getStaffAssignmentScope(req), current.rows[0].contact_id)) {
        res.status(404).json({ message: "Referral not found" });
        return;
      }
      const sets: string[] = ["updated_at = NOW()", "reviewed_by_user_id = $2"];
      const params: unknown[] = [id, staffId(req)];
      if (input.status) {
        params.push(input.status);
        sets.push(`status = $${params.length}`);
        const stamps = statusTimestamps(input.status);
        if (stamps.qualifiedAt === "now") sets.push("qualified_at = COALESCE(qualified_at, NOW())");
        if (stamps.qualifiedAt === "clear") sets.push("qualified_at = NULL");
        if (stamps.rewardedAt === "now") sets.push("rewarded_at = COALESCE(rewarded_at, NOW())");
        if (stamps.rewardedAt === "clear") sets.push("rewarded_at = NULL");
      }
      if (input.note !== undefined) {
        params.push(input.note || null);
        sets.push(`staff_note = $${params.length}`);
      }
      await pool.query(`UPDATE referrals SET ${sets.join(", ")} WHERE id = $1`, params);
      let emailed = false;
      if (input.status === "rewarded" && current.rows[0].status !== "rewarded") {
        emailed = await emailRewardReady(current.rows[0], current.rows[0].friend_name, await loadSettings());
      }
      res.json({ ok: true, emailed });
    } catch (error) { handleError(res, error); }
  });

  // Staff enroll a customer at the counter or on the phone.
  app.post("/api/crm/referrals/referrers", async (req, res) => {
    try {
      const input = joinSchema.parse(req.body);
      const { referrer, token, created } = await enrollReferrer({ ...input, enrolledBy: staffId(req) });
      const emailed = await emailDashboardLink(referrer, token, await loadSettings());
      res.status(created ? 201 : 200).json({ referrer: { id: referrer.id, code: referrer.code, shareUrl: shareUrlFor(referrer.code) }, created, emailed });
    } catch (error) { handleError(res, error); }
  });

  app.post("/api/crm/referrals/referrers/:id/resend", async (req, res) => {
    try {
      const id = parseId(String(req.params.id));
      const { rows } = await pool.query(`SELECT ${REFERRER_COLUMNS} FROM referrers WHERE id = $1`, [id]);
      if (!rows[0] || !canSeeContact(await getStaffAssignmentScope(req), rows[0].contact_id)) {
        res.status(404).json({ message: "Referrer not found" });
        return;
      }
      const token = newToken();
      await pool.query(`UPDATE referrers SET token_hash = $2, updated_at = NOW() WHERE id = $1`, [id, tokenHash(token)]);
      res.json({ emailed: await emailDashboardLink(rows[0], token, await loadSettings()) });
    } catch (error) { handleError(res, error); }
  });

  app.patch("/api/crm/referrals/referrers/:id", async (req, res) => {
    try {
      const id = parseId(String(req.params.id));
      const { status } = z.object({ status: z.enum(["active", "paused"]) }).parse(req.body);
      const existing = await pool.query(`SELECT contact_id FROM referrers WHERE id = $1`, [id]);
      if (!existing.rows[0] || !canSeeContact(await getStaffAssignmentScope(req), existing.rows[0].contact_id)) {
        res.status(404).json({ message: "Referrer not found" });
        return;
      }
      await pool.query(`UPDATE referrers SET status = $2, updated_at = NOW() WHERE id = $1`, [id, status]);
      res.json({ ok: true });
    } catch (error) { handleError(res, error); }
  });
}
