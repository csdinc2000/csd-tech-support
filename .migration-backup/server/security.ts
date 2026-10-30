import type { Request, Response, NextFunction, RequestHandler } from "express";

// ---------------------------------------------------------------------------
// Fail-fast secret check (run at boot)
// ---------------------------------------------------------------------------
// Only secrets the app genuinely cannot run without. Optional integration keys
// (OpenAI, MeshCentral, Twilio, Stripe, etc.) are intentionally NOT listed —
// those features degrade gracefully when unset, so requiring them would block
// boot for no reason.
export function assertRequiredSecrets(): void {
  const required = ["DATABASE_URL", "SESSION_SECRET", "REPL_ID"];
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

export function isAdminUser(req: Request): boolean {
  const email = String((req.user as any)?.claims?.email || "").toLowerCase();
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
  return !!email && allow.includes(email);
}

// Route groups that require an admin user (in addition to a valid session).
// Helpdesk lookup data is readable by staff because ticket forms need it, but
// changing shared helpdesk configuration is administrator-only.
export function isAdminApiPath(path: string, method = "GET"): boolean {
  const verb = method.toUpperCase();
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

  return (
    path === "/api/meshcentral" ||
    path.startsWith("/api/meshcentral/") ||
    path === "/api/billing" ||
    path.startsWith("/api/billing/") ||
    path === "/api/invoices" ||
    path.startsWith("/api/invoices/") ||
    path === "/api/call-tracking" ||
    path.startsWith("/api/call-tracking/") ||
    path === "/api/twilio" ||
    path.startsWith("/api/twilio/") ||
    path === "/api/calendar" ||
    path.startsWith("/api/calendar/") ||
    path === "/api/staff-dispatch" ||
    path.startsWith("/api/staff-dispatch/") ||
    (path === "/api/helpdesk/sla/check-overdue" && verb === "POST") ||
    (isHelpdeskConfig && verb !== "GET") ||
    isSensitiveHelpdeskRead
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
      return res.status(429).json({
        message: opts.message || "Too many requests, please try again later.",
      });
    }

    next();
  };
}
