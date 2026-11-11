import type { Request, RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { storage } from "../storage";
import { isAdminEmail } from "../security";

// Owner check shared by the A2P controls, provider health and other
// owner-only routes registered from routes.ts.
//
// Authorization model: org-wide controls (muting A2P paging, provider health)
// are restricted to the "owner" identity the A2P monitor already treats as
// the page recipient (A2P_ALERT_EMAIL / CSD_ADMIN_EMAIL), ADMIN_EMAILS, plus
// any user whose stored role is owner/admin. A logged-in but ordinary user
// gets 403 and the UI hides the controls based on the GET response.
const ownerEmailsFromEnv = (): string[] =>
  [process.env.A2P_ALERT_EMAIL, process.env.CSD_ADMIN_EMAIL]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .map((v) => v.toLowerCase());
export const resolveActor = async (req: Request) => {
  const email = String(req.dbUser?.email || getAuth(req).sessionClaims?.email || "").toLowerCase() || null;
  const sub = req.dbUser?.id || null;
  let role: string | null = null;
  if (email) {
    try {
      const record = await storage.getUserByUsername(email);
      if (record?.role) role = record.role;
    } catch {
      // Storage may not have the user yet; fall through to env check.
    }
  }
  const isOwner =
    role === "owner" ||
    role === "admin" ||
    isAdminEmail(email) ||
    (email != null && ownerEmailsFromEnv().includes(email));
  return { email, sub, role, isOwner };
};
export const requireOwner: RequestHandler = async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    if (!actor.isOwner) {
      res.status(403).json({ error: "Owner access required" });
      return;
    }
    (req as Request & { actor?: typeof actor }).actor = actor;
    next();
  } catch (err) {
    req.log.error({ error: (err as Error)?.message }, "Owner authorization check failed");
    res.status(500).json({ error: "Authorization check failed" });
  }
};
