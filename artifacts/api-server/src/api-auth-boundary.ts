import type { RequestHandler } from "express";
import { requireAuth } from "./middlewares/clerkAuth";
import { isAdminUser, requiredFeatureForApiPath } from "./security";
import { getStaffAccess } from "./staff-access";

// Paths under /api that stay reachable WITHOUT a logged-in session. Some are
// method-specific: a path can be public for one verb but admin for another.
export function isPublicApiRequest(method: string, path: string): boolean {
  if (path === "/api/health" || path === "/api/healthz") return true;
  if (
    (method === "GET" && /^\/api\/public\/invoices\/[^/]+$/.test(path)) ||
    (method === "POST" && /^\/api\/public\/invoices\/[^/]+\/create-stripe-checkout$/.test(path))
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
      path === "/api/booking/availability" ||
      /^\/api\/booking\/appointments\/[^/]+$/.test(path))
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

// Mount after Clerk and the body parsers, before all protected API routes.
export const apiAuthenticationBoundary: RequestHandler = (req, res, next) => {
  // Express routes are case-insensitive by default; normalize before checking
  // exemptions and feature requirements so mixed-case paths cannot skip auth.
  const path = req.path.toLowerCase();
  if (!path.startsWith("/api")) return next();
  if (isPublicApiRequest(req.method, path)) return next();
  requireAuth(req, res, (error?: unknown) => {
    if (error) return next(error);
    const required = requiredFeatureForApiPath(path, req.method);
    if (isAdminUser(req)) return next();
    void getStaffAccess(req)
      .then((access) => {
        if (access.approvalStatus !== "approved") {
          return res.status(403).json({ message: "Approved staff access required" });
        }
        if (required === "owner") {
          return res.status(403).json({ message: "Owner approval required" });
        }
        if (required && !access.features[required]) {
          return res.status(403).json({ message: `Approved ${required} access required` });
        }
        return next();
      })
      .catch(next);
  });
};