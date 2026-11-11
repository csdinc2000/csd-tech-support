import type { Express, Request } from "express";
import { clerkClient } from "@clerk/express";
import { pool } from "./db";
import { isAdminEmail, isAdminUser } from "./security";

type ClerkIdentity = { id: string; email: string | null };
type DeletionOptions = {
  isOwner?: (req: Request) => boolean;
  findClerkUsers?: (email: string) => Promise<ClerkIdentity[]>;
  deleteClerkUser?: (id: string) => Promise<void>;
};

export function registerStaffAccountDeletionRoutes(app: Express, options: DeletionOptions = {}): void {
  const isOwner = options.isOwner ?? isAdminUser;
  const findClerkUsers = options.findClerkUsers ?? (async (email: string) => {
    const result = await clerkClient.users.getUserList({ emailAddress: [email], limit: 100 });
    if (result.totalCount > result.data.length) throw new Error("Clerk lookup was incomplete");
    return result.data.map((user) => ({
      id: user.id,
      email: user.emailAddresses.find((address) =>
        address.id === user.primaryEmailAddressId && address.verification?.status === "verified",
      )?.emailAddress.toLowerCase() ?? null,
    }));
  });
  const deleteClerkUser = options.deleteClerkUser ?? (async (id: string) => {
    await clerkClient.users.deleteUser(id);
  });

  app.delete("/api/staff-access/:userId/account", async (req, res) => {
    if (!isOwner(req) || !req.dbUser?.id) {
      res.status(403).json({ message: "Owner access required" });
      return;
    }
    const confirmation = typeof req.body?.confirmEmail === "string" ? req.body.confirmEmail.trim().toLowerCase() : "";
    if (!confirmation) {
      res.status(400).json({ message: "Type the account email to confirm deletion" });
      return;
    }

    const client = await pool.connect();
    let clerkDeleted = false;
    let committed = false;
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "SELECT id, email FROM auth_users WHERE id = $1 FOR UPDATE",
        [req.params.userId],
      );
      const target = result.rows[0];
      const email = typeof target?.email === "string" ? target.email.trim().toLowerCase() : "";
      if (!target) {
        res.status(404).json({ message: "Account not found" });
        return;
      }
      if (!email || email !== confirmation) {
        res.status(409).json({ message: "Account email changed. Reload and confirm the current email." });
        return;
      }
      if (target.id === req.dbUser.id || isAdminEmail(email)) {
        res.status(403).json({ message: "Owner accounts cannot be deleted here" });
        return;
      }
      const helpdesk = await client.query(
        "SELECT 1 FROM staff_helpdesk_links WHERE auth_user_id = $1",
        [target.id],
      );
      if (helpdesk.rowCount) {
        res.status(409).json({ message: "Unlink the helpdesk assignee before deleting this account." });
        return;
      }
      const linked = await client.query(
        "SELECT clerk_user_id FROM auth_user_clerk_links WHERE auth_user_id = $1",
        [target.id],
      );
      const users = await findClerkUsers(email);
      if (users.some((user) => user.email !== email)) {
        res.status(409).json({ message: "Sign-in has a different or unverified primary email. Resolve it before deleting." });
        return;
      }
      if (users.length > 1) {
        res.status(409).json({ message: "Multiple sign-in accounts use this email. Resolve them before deleting." });
        return;
      }
      const clerkUser = users[0];
      if ((linked.rows[0] && linked.rows[0].clerk_user_id !== clerkUser?.id)
        || (String(target.id).startsWith("user_") && target.id !== clerkUser?.id)) {
        res.status(409).json({ message: "Account identity does not match its sign-in. Resolve the link first." });
        return;
      }

      // Verify database deletion constraints before touching Clerk. The entire
      // database transaction rolls back if the external sign-in deletion fails.
      await client.query("DELETE FROM staff_invites WHERE LOWER(email) = $1", [email]);
      await client.query("DELETE FROM auth_users WHERE id = $1", [target.id]);
      if (clerkUser) {
        await deleteClerkUser(clerkUser.id);
        clerkDeleted = true;
      }
      await client.query("COMMIT");
      committed = true;
      res.json({ deleted: true });
      return;
    } catch {
      res.status(500).json({
        message: clerkDeleted
          ? "Sign-in was removed, but local cleanup could not be confirmed. Contact the owner before retrying."
          : "Account deletion failed. No database changes were saved.",
      });
      return;
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
}