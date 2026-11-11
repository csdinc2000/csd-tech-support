import type { RequestHandler } from "express";
import { requireAuth } from "./middlewares/clerkAuth";
import { isAdminUser, isAllStaffApiPath, requiredCapabilityForApiPath, requiredFeatureForApiPath } from "./security";
import { logger } from "./lib/logger";
import { getStaffAccess, type StaffAccess } from "./staff-access";

// Paths under /api that stay reachable WITHOUT a logged-in session. Some are
// method-specific: a path can be public for one verb but admin for another.
export function isPublicApiRequest(method: string, path: string): boolean {
  if (path === "/api/health" || path === "/api/healthz") return true;
  if (
    (method === "GET" && /^\/api\/public\/invoices\/[^/]+$/.test(path)) ||
    (method === "POST" && /^\/api\/public\/invoices\/[^/]+\/create-stripe-checkout$/.test(path)) ||
    // The customer's invoice page records its first view (token-checked and
    // rate-limited in invoice-routes.ts).
    (method === "POST" && /^\/api\/public\/invoices\/[^/]+\/view$/.test(path))
  )
    return true;
  if (
    (method === "GET" && /^\/api\/public\/contracts\/[^/]+$/.test(path)) ||
    (method === "POST" && /^\/api\/public\/contracts\/[^/]+\/sign$/.test(path))
  )
    return true;
  if (path === "/api/google/callback") return true;
  if (method === "POST" && path === "/api/intake") return true;
  if (method === "POST" && path === "/api/support/redeem-code") return true;
  if (
    method === "GET" &&
    (path === "/api/booking/categories" ||
      path === "/api/booking/services" ||
      /^\/api\/booking\/services\/[^/]+$/.test(path) ||
      path === "/api/booking/availability")
  )
    return true;
  if (method === "POST" && (path === "/api/booking/locks" || path === "/api/booking/appointments"))
    return true;
  if (method === "DELETE" && /^\/api\/booking\/locks\/[^/]+$/.test(path)) return true;
  if (
    method === "GET" &&
    (path === "/api/booking/v2/services" || path === "/api/booking/v2/availability")
  )
    return true;
  if (
    method === "POST" &&
    (path === "/api/booking/v2/holds" || /^\/api\/booking\/v2\/holds\/[^/]+\/confirm$/.test(path))
  )
    return true;
  if (path === "/api/portal" || path.startsWith("/api/portal/")) return true;
  if (method === "GET" && path.startsWith("/api/download/")) return true;
  if (method === "POST" && path === "/api/aria/support-chat") return true;
  if (method === "POST" && (
    path === "/api/public/staff-invites/validate" ||
    path === "/api/public/staff-invites/accept"
  )) return true;
  return false;
}

type StaffApiDecision = { allowed: true } | { allowed: false; message: string; unclassified?: boolean };

/**
 * The authorization decision for a signed-in, non-owner staff member (owners
 * pass before this). Pure, so it can be tested with real access profiles.
 */
export function authorizeStaffApiRequest(
  path: string,
  method: string,
  access: Pick<StaffAccess, "approvalStatus" | "features" | "capabilities">,
): StaffApiDecision {
  if (access.approvalStatus !== "approved") return { allowed: false, message: "Approved staff access required" };
  const required = requiredFeatureForApiPath(path, method);
  // Communications hub switches: any one listed switch is enough, and it also
  // unlocks owner-only paths (e.g. Main Line Setup).
  const capabilities = requiredCapabilityForApiPath(path, method);
  const hasCapability = Boolean(capabilities?.some((capability) => access.capabilities[capability]));
  if (required === "owner" && !hasCapability) return { allowed: false, message: "Owner approval required" };
  if (required && required !== "owner" && !access.features[required]) {
    return { allowed: false, message: `Approved ${required} access required` };
  }
  if (capabilities && !hasCapability) {
    return { allowed: false, message: "This communications tool isn't switched on for your staff account" };
  }
  // Fail closed: a path with no feature gate must be explicitly listed as open
  // to all staff (ALL_STAFF_API_PREFIXES in security.ts).
  if (!required && !isAllStaffApiPath(path, method)) {
    return { allowed: false, message: "This endpoint is not available to staff accounts", unclassified: true };
  }
  return { allowed: true };
}

// Mount after Clerk and the body parsers, before all protected API routes.
export const apiAuthenticationBoundary: RequestHandler = (req, res, next) => {
  // Express routes are case-insensitive by default; normalize before checking
  // exemptions and feature requirements so mixed-case paths cannot skip auth.
  const path = req.path.toLowerCase();
  if (!path.startsWith("/api")) return next();
  if (isPublicApiRequest(req.method, path)) return next();
  requireAuth(req, res, (error?: unknown) => {
    if (error) return next(error);
    if (isAdminUser(req)) return next();
    void getStaffAccess(req)
      .then((access) => {
        const decision = authorizeStaffApiRequest(path, req.method, access);
        if (!decision.allowed) {
          if (decision.unclassified) {
            logger.warn({ method: req.method, path }, "Refused unclassified API path; classify it in security.ts");
          }
          res.status(403).json({ message: decision.message });
          return;
        }
        return next();
      })
      .catch(next);
  });
};