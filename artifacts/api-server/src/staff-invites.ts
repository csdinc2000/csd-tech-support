import { createHash, randomBytes, verify as verifySignature } from "node:crypto";
import express, { type Express, type Request, type RequestHandler } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { pool } from "./db";
import { requireAuth } from "./middlewares/clerkAuth";
import { isAdminUser } from "./security";
import { sharedRateLimit } from "./security";
import { sendEmail } from "./helpdesk-email";
import { logger } from "./lib/logger";
import type { StaffRole } from "./staff-access";
import {
  registerStaffAccountDiscoveryRoute,
  type ListClerkAccounts,
} from "./staff-account-discovery";

const INVITE_LIFETIME_DAYS = 7;
const STAFF_ROLES = new Set<StaffRole>([
  "administrator",
  "field_technician",
  "software_developer",
  "accounting",
  "it_manager",
  "legal_team",
  "secretary",
]);

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) return null;
  return email;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenFromRequest(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,100}$/.test(value) ? value : null;
}

async function verifiedClerkIdentity(req: Request) {
  const clerkUserId = getAuth(req).userId;
  if (!clerkUserId) return null;
  const user = await clerkClient.users.getUser(clerkUserId);
  const address = user.emailAddresses.find(
    (item) => item.id === user.primaryEmailAddressId && item.verification?.status === "verified",
  );
  const email = normalizeEmail(address?.emailAddress);
  return email
    ? { email, firstName: user.firstName?.trim() || null, lastName: user.lastName?.trim() || null }
    : null;
}

function requireInviteAdmin(req: Request, res: any, next: any) {
  if (!isAdminUser(req)) {
    res.status(403).json({ message: "Owner access required" });
    return;
  }
  next();
}

const limitInviteRequests = sharedRateLimit({
  windowMs: 15 * 60_000,
  max: 30,
  key: (req) => `staff-invite-public:${req.ip || req.socket.remoteAddress || "unknown"}`,
});

function publicInvite(row: any) {
  const status = row.accepted_at
    ? "accepted"
    : row.revoked_at
      ? "revoked"
      : new Date(row.expires_at).getTime() <= Date.now()
        ? "expired"
        : "pending";
  return {
    id: String(row.id),
    email: row.email,
    role: row.role,
    status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    ...(row.email_delivery_status !== undefined
      ? {
          emailDeliveryStatus: row.email_delivery_status,
          emailDeliveryAt: row.email_delivery_at,
        }
      : {}),
  };
}

function inviteDeliveryStatus(event: unknown): "delivered" | "bounced" | "failed" | null {
  if (event === "delivered") return "delivered";
  if (event === "bounce") return "bounced";
  if (event === "dropped") return "failed";
  return null;
}

function isValidSendGridSignature(
  publicKey: string,
  timestamp: string,
  body: Buffer,
  signature: string,
): boolean {
  try {
    return verifySignature(
      "sha256",
      Buffer.concat([Buffer.from(timestamp, "utf8"), body]),
      publicKey,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * Register before express.json() and the app-wide API auth boundary.
 * SendGrid signs the raw body, so the callback verifies that exact payload.
 */
export function registerStaffInviteDeliveryWebhook(
  app: Express,
  options: { publicKey?: string } = {},
): void {
  app.post(
    "/api/webhooks/sendgrid-events",
    express.raw({ type: "application/json", limit: "2mb" }),
    async (req, res): Promise<void> => {
      // Set this to the PEM public key from SendGrid's signed Event Webhook configuration.
      const publicKey = options.publicKey ?? process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
      if (!publicKey) {
        res.status(503).json({ message: "Email event verification is not configured" });
        return;
      }
      const signature = req.header("x-twilio-email-event-webhook-signature");
      const timestamp = req.header("x-twilio-email-event-webhook-timestamp");
      if (
        !Buffer.isBuffer(req.body) ||
        !signature ||
        !timestamp ||
        !/^\d{1,12}$/.test(timestamp) ||
        !isValidSendGridSignature(publicKey, timestamp, req.body, signature)
      ) {
        res.status(401).json({ message: "Invalid email event signature" });
        return;
      }

      let events: unknown;
      try {
        events = JSON.parse(req.body.toString("utf8"));
      } catch {
        res.status(400).json({ message: "Invalid email event payload" });
        return;
      }
      if (!Array.isArray(events)) {
        res.status(400).json({ message: "Invalid email event payload" });
        return;
      }

      try {
        for (const entry of events) {
          if (!entry || typeof entry !== "object") continue;
          const event = entry as {
            event?: unknown;
            timestamp?: unknown;
            custom_args?: { staff_invite_id?: unknown };
          };
          const status = inviteDeliveryStatus(event.event);
          const inviteId = event.custom_args?.staff_invite_id;
          const occurredAt = event.timestamp;
          if (
            !status ||
            typeof inviteId !== "string" ||
            !/^[1-9]\d{0,18}$/.test(inviteId) ||
            BigInt(inviteId) > 9223372036854775807n ||
            typeof occurredAt !== "number" ||
            !Number.isSafeInteger(occurredAt) ||
            occurredAt <= 0 ||
            occurredAt > 253402300799
          ) continue;

          await pool.query(
            `UPDATE staff_invites
             SET email_delivery_status = $2,
                 email_delivery_at = to_timestamp($3),
                 email_provider_event_at = to_timestamp($3)
             WHERE id = $1::bigint
               AND (email_provider_event_at IS NULL OR email_provider_event_at <= to_timestamp($3))`,
            [inviteId, status, occurredAt],
          );
        }
      } catch (error) {
        logger.error(
          { errorName: error instanceof Error ? error.name : "unknown" },
          "Staff invitation email event could not be recorded",
        );
        res.status(500).json({ message: "Could not record email event" });
        return;
      }

      res.status(200).json({ received: true });
    },
  );
}

type VerifiedIdentity = NonNullable<Awaited<ReturnType<typeof verifiedClerkIdentity>>>;

export function registerStaffInviteRoutes(
  app: Express,
  options: {
    verifyIdentity?: (req: Request) => Promise<VerifiedIdentity | null>;
    clerkUserId?: (req: Request) => string | null;
    requireSignedIn?: RequestHandler;
    listAccounts?: ListClerkAccounts;
    requireAdmin?: RequestHandler;
    sendInviteEmail?: (to: string, inviteUrl: string, role: StaffRole, inviteId: string) => Promise<void>;
  } = {},
): void {
  const verifyIdentity = options.verifyIdentity ?? verifiedClerkIdentity;
  const clerkUserIdForRequest = options.clerkUserId ?? ((req: Request) => getAuth(req).userId);
  const requireSignedIn = options.requireSignedIn ?? requireAuth;
  const requireAdmin = options.requireAdmin ?? requireInviteAdmin;
  const sendInviteEmail = options.sendInviteEmail ?? (async (to, inviteUrl, role, inviteId) => {
    const configuredBase = process.env.NODE_ENV === "production"
      ? process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL
      : process.env.REPLIT_DEV_DOMAIN
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL;
    if (!configuredBase) throw new Error("Public app URL is not configured");
    const base = new URL(configuredBase);
    if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
      throw new Error("Public app URL must be a clean HTTPS origin");
    }
    const escapeHtml = (value: string) => {
      const entities: Record<string, string> = {
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
      };
      return value.replace(/[&<>"']/g, (character) => entities[character]);
    };
    const readableRole = role.replaceAll("_", " ");
    const link = `${base.origin}${inviteUrl}`;
    await sendEmail(
      to,
      "You’re invited to CSD Tech Support",
      `You’ve been invited to join CSD Tech Support as ${readableRole}.\n\nAccept your invitation: ${link}\n\nThe link expires in ${INVITE_LIFETIME_DAYS} days. You must sign in using this email address and verify it before accepting. If you weren’t expecting this invitation, you can ignore this email.`,
      {
        html: `<p>You’ve been invited to join CSD Tech Support as <strong>${escapeHtml(readableRole)}</strong>.</p><p><a href="${escapeHtml(link)}">Accept your invitation</a></p><p>This link expires in ${INVITE_LIFETIME_DAYS} days. Sign in using this email address and verify it before accepting. If you weren’t expecting this invitation, you can ignore this email.</p>`,
        operation: "staff invite",
        customArgs: { staff_invite_id: inviteId },
      },
    );
  });
  // Retire the direct identity-repair action: staff enrollment requires an invitation.
  app.post("/api/staff-access/:userId/helpdesk-identity", requireAdmin, (_req, res) => {
    res.status(410).json({
      message: "Direct sign-in linking is no longer available. Send an owner-issued staff invitation and have the recipient accept it with the invited verified email.",
    });
    return;
  });
  registerStaffAccountDiscoveryRoute(app, requireAdmin, options.listAccounts);
  app.get("/api/staff-access/invites", requireAdmin, async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, email, role, created_at, expires_at, accepted_at, revoked_at,
                email_delivery_status, email_delivery_at
         FROM staff_invites ORDER BY created_at DESC LIMIT 100`,
      );
      res.json(result.rows.map(publicInvite));
      return;
    } catch (error: any) {
      res.status(500).json({ message: error?.message || "Could not load staff invitations" });
      return;
    }
  });

  app.post("/api/staff-access/invites", requireAdmin, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const role = req.body?.role;
    if (!email) {
      res.status(400).json({ message: "Enter a valid email address" });
      return;
    }
    if (!STAFF_ROLES.has(role)) {
      res.status(400).json({ message: "Select a valid staff role" });
      return;
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existingAccess = await client.query(
        `SELECT p.approval_status FROM auth_users u
         JOIN staff_access_profiles p ON p.user_id = u.id
         WHERE LOWER(u.email) = $1 AND p.approval_status IN ('approved', 'suspended')
         LIMIT 1`,
        [email],
      );
      if (existingAccess.rows[0]) {
        await client.query("ROLLBACK");
        res.status(409).json({
          message: "This person already has a staff account. Change their role or status in Staff Access instead of sending another invitation.",
        });
        return;
      }
      await client.query(
        `UPDATE staff_invites SET revoked_at = NOW()
         WHERE LOWER(email) = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [email],
      );
      const result = await client.query(
        `INSERT INTO staff_invites
           (email, role, token_hash, invited_by, expires_at, email_delivery_status)
         VALUES ($1, $2, $3, $4, NOW() + ($5::int * INTERVAL '1 day'), 'pending')
         RETURNING id, email, role, created_at, expires_at, accepted_at, revoked_at`,
        [email, role, tokenHash, req.dbUser?.id ?? null, INVITE_LIFETIME_DAYS],
      );
      await client.query("COMMIT");
      const invitePath = `/staff-invite#${token}`;
      let emailSent = false;
      let emailDeliveryStatus: "pending" | "accepted" | "failed" = "pending";
      try {
        await sendInviteEmail(email, invitePath, role as StaffRole, String(result.rows[0].id));
        emailSent = true;
        emailDeliveryStatus = "accepted";
        try {
          await pool.query(
            `UPDATE staff_invites SET email_delivery_status = 'accepted', email_delivery_at = NOW()
             WHERE id = $1 AND email_delivery_status = 'pending'`,
            [result.rows[0].id],
          );
        } catch (error) {
          logger.error(
            { inviteId: result.rows[0].id, errorName: error instanceof Error ? error.name : "unknown" },
            "Staff invitation provider acceptance could not be recorded",
          );
        }
      } catch (error) {
        emailDeliveryStatus = "failed";
        logger.error(
          { inviteId: result.rows[0].id, errorName: error instanceof Error ? error.name : "unknown" },
          "Staff invitation email could not be submitted",
        );
        try {
          await pool.query(
            `UPDATE staff_invites SET email_delivery_status = 'failed', email_delivery_at = NOW()
             WHERE id = $1 AND email_delivery_status = 'pending'`,
            [result.rows[0].id],
          );
        } catch (recordError) {
          logger.error(
            { inviteId: result.rows[0].id, errorName: recordError instanceof Error ? recordError.name : "unknown" },
            "Staff invitation send failure could not be recorded",
          );
        }
      }
      let inviteStatus: { email_delivery_status?: string; email_delivery_at?: string | null } = {
        email_delivery_status: emailDeliveryStatus,
        email_delivery_at: null,
      };
      try {
        const statusResult = await pool.query(
          "SELECT email_delivery_status, email_delivery_at FROM staff_invites WHERE id = $1",
          [result.rows[0].id],
        );
        inviteStatus = statusResult.rows[0] ?? inviteStatus;
      } catch (error) {
        logger.error(
          { inviteId: result.rows[0].id, errorName: error instanceof Error ? error.name : "unknown" },
          "Staff invitation email status could not be loaded",
        );
      }
      res.status(201).json({
        invite: publicInvite({ ...result.rows[0], ...inviteStatus }),
        invitePath,
        emailSent,
      });
      return;
    } catch (error: any) {
      await client.query("ROLLBACK");
      res.status(500).json({ message: "Could not create staff invitation" });
      return;
    } finally {
      client.release();
    }
  });

  app.post("/api/staff-access/invites/:id/revoke", requireAdmin, async (req, res) => {
    if (typeof req.params.id !== "string" || !/^\d+$/.test(req.params.id)) {
      res.status(400).json({ message: "Invalid invitation" });
      return;
    }
    try {
      const result = await pool.query(
        `UPDATE staff_invites SET revoked_at = NOW()
         WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
         RETURNING id, email, role, created_at, expires_at, accepted_at, revoked_at,
                   email_delivery_status, email_delivery_at`,
        [req.params.id],
      );
      if (!result.rows[0]) {
        res.status(409).json({ message: "Invitation is no longer active" });
        return;
      }
      res.json(publicInvite(result.rows[0]));
      return;
    } catch (error: any) {
      res.status(500).json({ message: error?.message || "Could not revoke staff invitation" });
      return;
    }
  });

  app.post("/api/public/staff-invites/validate", limitInviteRequests, async (req, res) => {
    const token = tokenFromRequest(req.body?.token);
    if (!token) {
      res.status(404).json({ message: "Invitation not found" });
      return;
    }
    try {
      const result = await pool.query(
        `SELECT id, email, role, created_at, expires_at, accepted_at, revoked_at
         FROM staff_invites WHERE token_hash = $1`,
        [hashToken(token)],
      );
      if (!result.rows[0]) {
        res.status(404).json({ message: "Invitation not found" });
        return;
      }
      const invite = publicInvite(result.rows[0]);
      if (invite.status !== "pending") {
        res.status(410).json({ message: `This invitation has ${invite.status}` });
        return;
      }
      res.json(invite);
      return;
    } catch (error: any) {
      res.status(500).json({ message: "Could not validate invitation" });
      return;
    }
  });

  app.post("/api/public/staff-invites/accept", limitInviteRequests, requireSignedIn, async (req, res) => {
    const token = tokenFromRequest(req.body?.token);
    if (!token) {
      res.status(404).json({ message: "Invitation not found" });
      return;
    }
    const firstName = typeof req.body?.firstName === "string" ? req.body.firstName.trim() : "";
    const lastName = typeof req.body?.lastName === "string" ? req.body.lastName.trim() : "";
    if (!firstName || !lastName || firstName.length > 100 || lastName.length > 100) {
      res.status(400).json({ message: "Enter your first and last name (100 characters or fewer each)" });
      return;
    }
    let identity;
    try {
      identity = await verifyIdentity(req);
    } catch {
      res.status(503).json({ message: "Could not verify your account email. Try again shortly." });
      return;
    }
    if (!identity) {
      res.status(403).json({ message: "Your verified account email is required to accept this invitation" });
      return;
    }
    const { email } = identity;
    const clerkUserId = clerkUserIdForRequest(req);
    if (!clerkUserId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const inviteResult = await client.query(
        `SELECT id, email, role, invited_by, expires_at, accepted_at, revoked_at
         FROM staff_invites WHERE token_hash = $1 FOR UPDATE`,
        [hashToken(token)],
      );
      const invite = inviteResult.rows[0];
      if (!invite) {
        await client.query("ROLLBACK");
        res.status(404).json({ message: "Invitation not found" });
        return;
      }
      if (invite.accepted_at || invite.revoked_at || new Date(invite.expires_at).getTime() <= Date.now()) {
        await client.query("ROLLBACK");
        res.status(410).json({ message: "This invitation is no longer active" });
        return;
      }
      if (normalizeEmail(invite.email) !== email) {
        await client.query("ROLLBACK");
        res.status(403).json({ message: "Sign in with the email address this invitation was sent to" });
        return;
      }
      if (!req.dbUser?.id) {
        await client.query("ROLLBACK");
        res.status(401).json({ message: "Authentication required" });
        return;
      }

      const existing = await client.query(
        `SELECT id FROM auth_users WHERE LOWER(email) = $1 AND id <> $2 FOR UPDATE`,
        [email, req.dbUser.id],
      );
      if (existing.rows.length > 1) {
        await client.query("ROLLBACK");
        res.status(409).json({ message: "Multiple accounts have this email. Ask the owner to resolve the duplicates." });
        return;
      }
      let targetUserId = req.dbUser.id;
      if (existing.rows[0]) {
        const previousId = String(existing.rows[0].id);
        // Never take over another Clerk account; only link a legacy account
        // when the new Clerk email is verified and an owner issued this invite.
        const linked = await client.query(
          "SELECT clerk_user_id FROM auth_user_clerk_links WHERE auth_user_id = $1 FOR UPDATE",
          [previousId],
        );
        if (previousId.startsWith("user_") || (linked.rows[0] && linked.rows[0].clerk_user_id !== clerkUserId)) {
          await client.query("ROLLBACK");
          res.status(409).json({ message: "This email belongs to another sign-in account. Ask the owner for help." });
          return;
        }
        const oldProfile = await client.query(
          "SELECT approval_status FROM staff_access_profiles WHERE user_id = $1 FOR UPDATE",
          [previousId],
        );
        if (oldProfile.rows[0] && oldProfile.rows[0].approval_status !== "pending") {
          await client.query("ROLLBACK");
          res.status(409).json({ message: "This account already has staff access. Ask the owner to update its role." });
          return;
        }
        // Link only an empty bridge created by this sign-in. Preserve the
        // bridge itself so no associated history can be cascade-deleted.
        const emptyBridge = await client.query(
          `SELECT u.id FROM auth_users u WHERE u.id = $1
            AND NULLIF(TRIM(u.email), '') IS NULL
            AND NULLIF(TRIM(u.first_name), '') IS NULL
            AND NULLIF(TRIM(u.last_name), '') IS NULL
            AND NOT EXISTS (SELECT 1 FROM staff_access_profiles p WHERE p.user_id = u.id)
            AND NOT EXISTS (SELECT 1 FROM staff_client_assignments a WHERE a.user_id = u.id)
            AND NOT EXISTS (SELECT 1 FROM staff_job_assignments a WHERE a.user_id = u.id)
            AND NOT EXISTS (SELECT 1 FROM staff_contact_assignments a WHERE a.user_id = u.id)
          FOR UPDATE`,
          [req.dbUser.id],
        );
        if (!emptyBridge.rows[0]) {
          await client.query("ROLLBACK");
          res.status(409).json({ message: "This sign-in account has existing records. Ask the owner to resolve the account link." });
          return;
        }
        await client.query(
          "INSERT INTO auth_user_clerk_links (clerk_user_id, auth_user_id) VALUES ($1, $2)",
          [clerkUserId, previousId],
        );
        targetUserId = previousId;
      }
      const profile = await client.query(
        `SELECT approval_status FROM staff_access_profiles WHERE user_id = $1 FOR UPDATE`,
        [targetUserId],
      );
      if (profile.rows[0] && profile.rows[0].approval_status !== "pending") {
        await client.query("ROLLBACK");
        res.status(409).json({ message: "This account already has staff access. Ask the owner to update your role." });
        return;
      }
      await client.query(
        `UPDATE auth_users SET email = $2,
            first_name = $3,
            last_name = $4,
           updated_at = NOW()
         WHERE id = $1`,
        [targetUserId, email, firstName, lastName],
      );
      await client.query(
        `INSERT INTO staff_access_profiles
            (user_id, role, can_view_voicemails, approval_status, feature_permissions, approved_at, approved_by, updated_at)
          VALUES ($1, $2, TRUE, 'pending', '{}'::jsonb, NULL, NULL, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           role = EXCLUDED.role,
            approval_status = 'pending',
           feature_permissions = '{}'::jsonb,
            approved_at = NULL,
            approved_by = NULL,
           updated_at = GREATEST(NOW(), staff_access_profiles.updated_at + INTERVAL '1 millisecond')`,
        [targetUserId, invite.role],
      );
      await client.query(
        `UPDATE staff_invites SET accepted_at = NOW(), accepted_by = $2
         WHERE id = $1`,
        [invite.id, targetUserId],
      );
      await client.query(
        `INSERT INTO staff_access_audit
           (target_user_id, actor_user_id, action, previous_access, new_access)
          VALUES ($1, $2, 'invite_accepted', '{}'::jsonb, $3::jsonb)`,
        [targetUserId, invite.invited_by, JSON.stringify({ role: invite.role, approval_status: "pending" })],
      );
      await client.query("COMMIT");
      res.json({ role: invite.role, approvalStatus: "pending" });
      return;
    } catch (error: any) {
      await client.query("ROLLBACK");
      res.status(error?.code === "23505" ? 409 : 500).json({
        message: error?.code === "23505"
          ? "This email is already attached to another account. Ask the owner for help."
          : "Could not accept staff invitation",
      });
      return;
    } finally {
      client.release();
    }
  });

  // A ticket assignee is a legacy users.id, separate from a Clerk login.
  // Only an owner may explicitly link/create one for an approved staff account.
  app.post("/api/staff-access/:userId/helpdesk-assignee", requireAdmin, async (req, res) => {
    if (typeof req.params.userId !== "string" || !req.params.userId) {
      res.status(400).json({ message: "Invalid staff account" });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const target = await client.query(
        `SELECT u.id, u.email, u.first_name, u.last_name, p.approval_status
         FROM auth_users u JOIN staff_access_profiles p ON p.user_id = u.id
         WHERE u.id = $1 FOR UPDATE OF u, p`,
        [req.params.userId],
      );
      const staff = target.rows[0];
      if (!staff) {
        await client.query("ROLLBACK");
        res.status(404).json({ message: "Staff account not found" });
        return;
      }
      if (staff.approval_status !== "approved") {
        await client.query("ROLLBACK");
        res.status(409).json({ message: "Approve this staff account before linking a helpdesk assignee" });
        return;
      }
      const alreadyLinked = await client.query(
        `SELECT h.id, h.username AS name, h.email
         FROM staff_helpdesk_links l JOIN users h ON h.id = l.helpdesk_user_id
         WHERE l.auth_user_id = $1 FOR UPDATE OF l`,
        [staff.id],
      );
      if (alreadyLinked.rows[0]) {
        await client.query("COMMIT");
        res.json(alreadyLinked.rows[0]);
        return;
      }
      const email = normalizeEmail(staff.email);
      if (!email) {
        await client.query("ROLLBACK");
        res.status(409).json({
          code: "STAFF_EMAIL_REQUIRED",
          message: "This account is approved, but has no valid sign-in email on file. Confirm the person's verified sign-in identity before linking a helpdesk assignee.",
        });
        return;
      }
      const existing = await client.query(
        `SELECT id, username AS name, email FROM users
          WHERE LOWER(BTRIM(email)) = $1 FOR UPDATE`,
        [email],
      );
      if (existing.rows.length > 1) {
        await client.query("ROLLBACK");
        res.status(409).json({ message: "Multiple helpdesk assignees use this email. Resolve the duplicates before linking." });
        return;
      }
      let assignee = existing.rows[0];
      if (!assignee) {
        const humanName = [staff.first_name, staff.last_name].filter(Boolean).join("-")
          || email.split("@")[0];
        const prefix = humanName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 35) || "staff";
        const suffix = createHash("sha256").update(staff.id).digest("hex").slice(0, 12);
        const created = await client.query(
          `INSERT INTO users (username, password, email, role)
           VALUES ($1, $2, $3, 'user')
           RETURNING id, username AS name, email`,
          [`${prefix}-${suffix}`, `!${randomBytes(48).toString("hex")}`, email],
        );
        assignee = created.rows[0];
      }
      await client.query(
        `INSERT INTO staff_helpdesk_links (auth_user_id, helpdesk_user_id, created_by)
         VALUES ($1, $2, $3)`,
        [staff.id, assignee.id, req.dbUser?.id ?? null],
      );
      await client.query(
        `INSERT INTO staff_access_audit
           (target_user_id, actor_user_id, action, previous_access, new_access)
         VALUES ($1, $2, 'helpdesk_assignee_linked', '{}'::jsonb, $3::jsonb)`,
        [staff.id, req.dbUser?.id ?? null, JSON.stringify({ helpdeskAssigneeId: assignee.id })],
      );
      await client.query("COMMIT");
      res.json(assignee);
      return;
    } catch (error: any) {
      await client.query("ROLLBACK");
      res.status(error?.code === "23505" ? 409 : 500).json({
        message: error?.code === "23505"
          ? "This helpdesk assignee is already linked to another staff account."
          : "Could not link helpdesk assignee",
      });
      return;
    } finally {
      client.release();
    }
  });
}