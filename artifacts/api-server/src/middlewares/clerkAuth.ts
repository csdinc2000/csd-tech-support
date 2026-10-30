import type { RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { eq } from "drizzle-orm";
import { authUsers, type AuthUser } from "@workspace/db";
import { db } from "../db";
import { pool } from "../db";
import { isAdminEmail } from "../security";

declare global {
  namespace Express {
    interface Request {
      dbUser?: AuthUser;
      ownerApprovalStatus?: "approved" | "pending" | "suspended";
    }
  }
}

/**
 * Verifies the Clerk session, then resolves the existing auth_users bridge.
 * sessionClaims.userId is the old Replit subject for migrated users; auth.userId
 * is used only as a fallback for newly-created Clerk users.
 */
export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    const auth = getAuth(req);
    // sessionClaims is an untyped JWT payload, so the migrated-subject claim
    // arrives as unknown; only a string is a usable auth_users.id.
    const claimedUserId = auth.sessionClaims?.userId;
    const initialId = (typeof claimedUserId === "string" && claimedUserId) || auth.userId;
    if (!initialId) return res.status(401).json({ message: "Authentication required" });
    // A verified, accepted invitation may bind this Clerk user to a legacy
    // auth_users row. Resolve the link before looking up the empty JIT bridge.
    const linked = auth.userId
      ? await pool.query("SELECT auth_user_id FROM auth_user_clerk_links WHERE clerk_user_id = $1", [auth.userId])
      : null;
    const userId: string = linked?.rows[0]?.auth_user_id ?? initialId;
    let [dbUser] = await db.select().from(authUsers).where(eq(authUsers.id, userId)).limit(1);
    if (linked?.rows[0] && !dbUser) {
      return res.status(401).json({ message: "Account link no longer exists" });
    }
    if (!dbUser) {
      const [inserted] = await db
        .insert(authUsers)
        .values({ id: userId })
        .onConflictDoNothing()
        .returning();
      if (inserted) {
        dbUser = inserted;
      } else {
        [dbUser] = await db.select().from(authUsers).where(eq(authUsers.id, userId)).limit(1);
      }
    }
    if (!dbUser) return res.status(401).json({ message: "User provisioning failed" });
    req.dbUser = dbUser;
    if (isAdminEmail(auth.sessionClaims?.email)) {
      // Historical owner profiles may be pending while the allowlist still
      // granted access. Only explicit owner-status changes opt into enforcement.
      // Resolve by verified owner email rather than the bridge ID so another
      // local identity for the same Clerk email cannot bypass suspension.
      const status = await pool.query(
        `SELECT p.approval_status FROM auth_users u
         JOIN staff_access_profiles p ON p.user_id = u.id
         WHERE LOWER(u.email) = $1 AND EXISTS (
           SELECT 1 FROM staff_access_audit a
           WHERE a.target_user_id = u.id AND a.action = 'owner_status_updated'
         )
         ORDER BY CASE p.approval_status WHEN 'suspended' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END
         LIMIT 1`,
        [String(auth.sessionClaims?.email).trim().toLowerCase()],
      );
      req.ownerApprovalStatus = status.rows[0]?.approval_status ?? "approved";
    }
    return next();
  } catch (error) {
    return next(error);
  }
};