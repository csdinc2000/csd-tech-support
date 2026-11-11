import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import type { StaffFeature } from "./staff-access";
import { pool } from "./db";
import {
  recordSharedRateLimitCleanupFailure,
  recordSharedRateLimitCleanupSuccess,
} from "./internal-alerts";

const SHARED_RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000;
const SHARED_RATE_LIMIT_CLEANUP_BATCH_SIZE = 100;
let nextSharedRateLimitCleanupAt = 0;

// ---------------------------------------------------------------------------
// Fail-fast secret check (run at boot)
// ---------------------------------------------------------------------------
// Only secrets the app genuinely cannot run without. Optional integration keys
// (OpenAI, MeshCentral, Twilio, Stripe, etc.) are intentionally NOT listed —
// those features degrade gracefully when unset, so requiring them would block
// boot for no reason.
export function assertRequiredSecrets(): void {
  const required = ["DATABASE_URL", "CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY"];
  const missing = required.filter(
    (k) => !process.env[k] || !String(process.env[k]).trim(),
  );
  if (missing.length > 0) {
    console.error(
      `[boot] FATAL: missing required secret(s): ${missing.join(", ")}. ` +
        `Set them in Replit Secrets and restart.`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Admin authorization
// ---------------------------------------------------------------------------
// The auth_users table has no role column and db:push is unavailable, so admin
// status is driven by an email allowlist (ADMIN_EMAILS, comma-separated; falls
// back to CSD_ADMIN_EMAIL). This FAILS CLOSED: if the allowlist is empty, no one
// is treated as admin and the admin route groups return 403 for everyone. That
// is the safe direction — an unset/cleared allowlist must never silently grant
// admin to every authenticated user.
let warnedNoAdminList = false;

function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || process.env.CSD_ADMIN_EMAIL || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: unknown): boolean {
  const normalized = String(email || "").trim().toLowerCase();
  return Boolean(normalized) && adminEmails().includes(normalized);
}

export function isOwnerIdentity(req: Request): boolean {
  if (!req.dbUser?.id) return false;
  try {
    return isAdminEmail(getAuth(req).sessionClaims?.email);
  } catch {
    return false;
  }
}

export function isAdminUser(req: Request): boolean {
  const allow = adminEmails();
  if (allow.length === 0) {
    if (!warnedNoAdminList) {
      warnedNoAdminList = true;
      console.warn(
        "[security] ADMIN_EMAILS (and CSD_ADMIN_EMAIL) are unset — admin/mesh/" +
          "billing routes are locked for everyone. Set ADMIN_EMAILS " +
          "(comma-separated) to grant admin access.",
      );
    }
    return false;
  }
  try {
    return isOwnerIdentity(req) && req.ownerApprovalStatus !== "pending" && req.ownerApprovalStatus !== "suspended";
  } catch {
    // A protected route mounted without Clerk middleware must fail closed.
    return false;
  }
}

// Route groups that require an admin user (in addition to a valid session).
// Helpdesk lookup data is readable by staff because ticket forms need it, but
// changing shared helpdesk configuration is administrator-only.
export function requiredFeatureForApiPath(path: string, method = "GET"): StaffFeature | "owner" | null {
  const verb = method.toUpperCase();
  const isStaffVoicemailRequest =
    (verb === "GET" && path === "/api/twilio/voicemails") ||
    (verb === "PATCH" && /^\/api\/twilio\/voicemails\/[^/]+$/.test(path)) ||
    (verb === "GET" && /^\/api\/twilio\/voicemails\/[^/]+\/audio$/.test(path));
  const helpdeskConfigPrefixes = [
    "/api/helpdesk/departments",
    "/api/helpdesk/teams",
    "/api/helpdesk/help-topics",
    "/api/helpdesk/sla-plans",
    "/api/helpdesk/canned-responses",
    "/api/helpdesk/email-templates",
    "/api/helpdesk/filters",
    "/api/helpdesk/integrations",
    "/api/helpdesk/settings",
  ];
  const isHelpdeskConfig = helpdeskConfigPrefixes.some(
    (prefix) => path === prefix || path.startsWith(prefix + "/"),
  );
  const isSensitiveHelpdeskRead =
    path === "/api/helpdesk/settings" ||
    path.startsWith("/api/helpdesk/settings/") ||
    path === "/api/helpdesk/email-templates" ||
    path.startsWith("/api/helpdesk/email-templates/") ||
    path === "/api/helpdesk/integrations" ||
    path.startsWith("/api/helpdesk/integrations/") ||
    path === "/api/helpdesk/filters" ||
    path.startsWith("/api/helpdesk/filters/") ||
    /^\/api\/helpdesk\/teams\/[^/]+\/members(?:\/|$)/.test(path);

  if (path === "/api/billing" || path.startsWith("/api/billing/")) return "owner";
  if (path === "/api/provider-health" || path.startsWith("/api/provider-health/")) return "owner";
  if (path === "/api/staff-access" || path.startsWith("/api/staff-access/")) return "staffAdmin";
  // Referral rewards are a promise to customers, so only owners change them.
  if (path === "/api/crm/referrals/settings" && verb !== "GET") return "owner";
  // Speed to Lead decides whether customers get automatic texts.
  if (path === "/api/crm/speed-to-lead/settings" && verb !== "GET") return "owner";
  if (
    path === "/api/clients" || path.startsWith("/api/clients/") ||
    path === "/api/crm" || path.startsWith("/api/crm/")
  ) return "crm";
  if (path === "/api/invoices" || path.startsWith("/api/invoices/")) return "invoices";
  if (path === "/api/marketplace" || path.startsWith("/api/marketplace/")) return "marketplace";
  if (path === "/api/catalog" || path.startsWith("/api/catalog/")) {
    return verb === "GET" ? "invoices" : "owner";
  }
  if (path === "/api/meshcentral" || path.startsWith("/api/meshcentral/")) return "operations";
  // RMM and technician tools: each is used only by an operations-gated page.
  const underAny = (prefixes: string[]) =>
    prefixes.some((prefix) => path === prefix || path.startsWith(prefix + "/"));
  if (underAny([
    "/api/patches", "/api/patch-policies", "/api/network-scans", "/api/network",
    "/api/monitoring", "/api/tech-tools", "/api/emergency-contacts",
  ])) return "operations";
  if (underAny(["/api/automation-scripts"])) return "automation";
  // Bulk imports and the Google Contacts sync live on CRM / invoice pages.
  if (underAny(["/api/contact-import", "/api/google", "/api/service-contracts"])) return "crm";
  if (underAny(["/api/paypal-import"])) return "invoices";
  if (underAny(["/api/ptt/session", "/api/ptt/telemetry"])) return "communications";
  // Inbound-email ticket creation has no webhook signature; keep it to admins.
  if (path === "/api/helpdesk/email/inbound" || path === "/api/helpdesk/reports/summary") return "helpdeskAdmin";
  if (path === "/api/calendar" || path.startsWith("/api/calendar/")) return "scheduling";
  if (verb === "GET" && (path === "/api/staff-dispatch/audit" || path === "/api/staff-dispatch/client-messages")) return "owner";
  if (path === "/api/staff-dispatch/settings" || path.startsWith("/api/staff-dispatch/settings/")) return "owner";
  if (path === "/api/staff-dispatch" || path.startsWith("/api/staff-dispatch/")) return "dispatchAdmin";
  if (path === "/api/call-tracking" || path.startsWith("/api/call-tracking/")) return "communications";
  if (path === "/api/ptt/roster" || path === "/api/ptt/pages" || path.startsWith("/api/ptt/pages/")) return "communications";
  // Every SMS endpoint reads or changes customer conversations, so it needs
  // communications. The one exception is sending a single text: the digital
  // business card lets any approved staff member text their card, and the
  // send route enforces contact assignment itself.
  if (path === "/api/sms/send" && verb === "POST") return null; // see ALL_STAFF_API_PREFIXES
  if (path === "/api/sms" || path.startsWith("/api/sms/")) return "communications";
  if (path === "/api/communications" || path.startsWith("/api/communications/")) return "communications";
  // Call/SMS forwarding and the main-line setup decide where customer calls go;
  // only the owner changes them (the UI already hides "Main Line Setup").
  if (path === "/api/twilio/settings" && verb !== "GET") return "owner";
  if (verb !== "GET" && (
    path === "/api/twilio/a2p/register" ||
    path === "/api/twilio/sync-webhooks" ||
    path.startsWith("/api/twilio/voicemail-greeting") ||
    path.startsWith("/api/twilio/call-log/")
  )) return "owner";
  if (path === "/api/twilio" || (path.startsWith("/api/twilio/") && !isStaffVoicemailRequest)) return "communications";
  if (path === "/api/crm/deleted-contact-placeholders") return "crm";
  if (
    (path === "/api/helpdesk/sla/check-overdue" && verb === "POST") ||
    (isHelpdeskConfig && verb !== "GET") ||
    isSensitiveHelpdeskRead
  ) return "helpdeskAdmin";
  return null;
}

// ---------------------------------------------------------------------------
// API areas open to every approved staff member
// ---------------------------------------------------------------------------
// The auth boundary FAILS CLOSED: a signed-in, approved staff member may only
// reach an /api path that is public, gated by requiredFeatureForApiPath above,
// or listed here. A new route that matches none of them gets a 403 (owners
// still pass), and api-route-coverage.integration.test.ts fails until it is
// classified. Add a prefix here only when every approved staff member really
// should reach it; otherwise give it a feature gate above.
export const ALL_STAFF_API_PREFIXES: readonly { prefix: string; methods?: readonly string[] }[] = [
  // Shared work surfaces: the dashboard, tech board, ticket and alert widgets
  // show these to every role. Rows are still assignment-scoped by
  // enforceAssignedResourceBoundary and the route handlers.
  { prefix: "/api/dashboard" },
  { prefix: "/api/tickets" },
  { prefix: "/api/devices" },
  { prefix: "/api/alerts" },
  { prefix: "/api/remote-sessions" },
  { prefix: "/api/support/generate-code", methods: ["POST"] },
  { prefix: "/api/service-logs" },
  { prefix: "/api/intake" },
  { prefix: "/api/booking/appointments", methods: ["GET"] },
  { prefix: "/api/users", methods: ["GET"] },
  // Ticket forms need helpdesk lookup data; changing it is helpdeskAdmin.
  { prefix: "/api/helpdesk/departments", methods: ["GET"] },
  { prefix: "/api/helpdesk/teams", methods: ["GET"] },
  { prefix: "/api/helpdesk/help-topics", methods: ["GET"] },
  { prefix: "/api/helpdesk/sla-plans", methods: ["GET"] },
  { prefix: "/api/helpdesk/canned-responses", methods: ["GET"] },
  // Every staff member listens to and clears their own voicemail.
  { prefix: "/api/twilio/voicemails", methods: ["GET", "PATCH"] },
  // Personal tools: own profile/card/avatar, own Aria conversations, own
  // assistant tasks, own calendar.
  { prefix: "/api/staff-profile" },
  { prefix: "/api/aria" },
  { prefix: "/api/assistant" },
  { prefix: "/api/staff-calendar" },
  // Texting one customer (the business card "text my card" button); the route
  // enforces contact assignment.
  { prefix: "/api/sms/send", methods: ["POST"] },
];

export function isAllStaffApiPath(path: string, method = "GET"): boolean {
  const p = path.toLowerCase();
  // Express answers HEAD with the GET route.
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return ALL_STAFF_API_PREFIXES.some(
    ({ prefix, methods }) =>
      (p === prefix || p.startsWith(prefix + "/")) && (!methods || methods.includes(verb)),
  );
}

// ---------------------------------------------------------------------------
// Lightweight in-memory rate limiter
// ---------------------------------------------------------------------------
// Per-process fixed-window limiter keyed by client IP + path. Intentionally
// dependency-free (no express-rate-limit) to keep the change surgical; adequate
// for a single deployed instance. Swap for a shared-store limiter if the app is
// ever scaled to multiple instances.
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  message?: string;
  key?: (req: Request) => string;
  maxEntries?: number;
}): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();

    // Opportunistic sweep so the map can't grow unbounded.
    if (hits.size > (opts.maxEntries ?? 1000)) {
      hits.forEach((v, k) => {
        if (now > v.resetAt) hits.delete(k);
      });
    }

    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const key = opts.key ? opts.key(req) : `${ip}:${req.path}`;
    let rec = hits.get(key);
    if (!rec || now > rec.resetAt) {
      rec = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, rec);
    }
    rec.count++;

    if (rec.count > opts.max) {
      const retryAfter = Math.ceil((rec.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        message: opts.message || "Too many requests, please try again later.",
      });
      return;
    }

    next();
  };
}

// PostgreSQL-backed fixed-window limiter for actions whose allowance must be
// shared by every API instance. The key must come from authenticated server-side
// identity data; callers must not derive it from request payloads.
export async function cleanupExpiredSharedRateLimits(
  batchSize = SHARED_RATE_LIMIT_CLEANUP_BATCH_SIZE,
): Promise<number> {
  try {
    const result = await pool.query(
      `DELETE FROM shared_rate_limits
       WHERE ctid IN (
         SELECT ctid
         FROM shared_rate_limits
         WHERE reset_at <= NOW()
         ORDER BY reset_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )`,
      [batchSize],
    );
    await recordSharedRateLimitCleanupSuccess();
    return result.rowCount ?? 0;
  } catch (error) {
    await recordSharedRateLimitCleanupFailure();
    throw error;
  }
}

function scheduleSharedRateLimitCleanup(): void {
  const now = Date.now();
  if (now < nextSharedRateLimitCleanupAt) return;
  nextSharedRateLimitCleanupAt = now + SHARED_RATE_LIMIT_CLEANUP_INTERVAL_MS;
  void cleanupExpiredSharedRateLimits().catch(() => {
    console.warn("[security] shared rate-limit cleanup failed");
  });
}

export function sharedRateLimit(opts: {
  windowMs: number;
  max: number;
  message?: string;
  key: (req: Request) => string;
}): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = opts.key(req);
      const result = await pool.query<{ hit_count: number; reset_at: Date }>(
        `INSERT INTO shared_rate_limits (rate_key, hit_count, reset_at)
         VALUES ($1, 1, NOW() + ($2 * INTERVAL '1 millisecond'))
         ON CONFLICT (rate_key) DO UPDATE SET
           hit_count = CASE
             WHEN shared_rate_limits.reset_at <= NOW() THEN 1
             ELSE shared_rate_limits.hit_count + 1
           END,
           reset_at = CASE
             WHEN shared_rate_limits.reset_at <= NOW()
               THEN NOW() + ($2 * INTERVAL '1 millisecond')
             ELSE shared_rate_limits.reset_at
           END
         RETURNING hit_count, reset_at`,
        [key, opts.windowMs],
      );
      const record = result.rows[0];
      scheduleSharedRateLimitCleanup();
      if (Number(record.hit_count) > opts.max) {
        const retryAfter = Math.max(
          1,
          Math.ceil((new Date(record.reset_at).getTime() - Date.now()) / 1000),
        );
        res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({
          message: opts.message || "Too many requests, please try again later.",
        });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
