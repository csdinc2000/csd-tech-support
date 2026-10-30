import type { Express, RequestHandler } from "express";
import { clerkClient } from "@clerk/express";
import { UpdateStaffContactProfileBody } from "@workspace/api-zod";
import { pool } from "./db";
import { toValidE164 } from "./phone-validation";

type Account = {
  id: string;
  primaryEmailAddressId: string | null;
  emailAddresses: Array<{
    id: string;
    emailAddress: string;
    verification?: { status: string } | null;
  }>;
};
type ProfileRow = {
  id: string;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  department: string | null;
  details_updated_at: Date | null;
  clerk_id: string | null;
  enrolled: boolean;
};

const profileSql = `SELECT u.id, u.email, d.phone, d.job_title, d.department,
    d.updated_at AS details_updated_at,
    COALESCE(l.clerk_user_id, CASE WHEN u.id ~ '^user_[A-Za-z0-9]+$' THEN u.id END) AS clerk_id,
    EXISTS(SELECT 1 FROM staff_access_profiles p WHERE p.user_id=u.id) AS enrolled
  FROM auth_users u
  LEFT JOIN staff_directory_details d ON d.user_id=u.id
  LEFT JOIN auth_user_clerk_links l ON l.auth_user_id=u.id
  WHERE u.id=$1`;

function emailKey(value: string | null | undefined): string {
  return value?.trim().toLowerCase() || "";
}

export function verifiedAccountAddress(account: Account, email: string) {
  return account.emailAddresses.find((address) =>
    address.verification?.status === "verified"
    && emailKey(address.emailAddress) === emailKey(email));
}

function version(row: ProfileRow): string | null {
  return row.details_updated_at?.toISOString() ?? null;
}

export function registerStaffContactProfileRoutes(
  app: Express,
  requireAdministrator: RequestHandler,
  options: {
    isOwnerEmail: (email: string | null) => boolean;
    getAccount?: (id: string) => Promise<Account>;
    setPrimaryEmail?: (userId: string, addressId: string) => Promise<Account>;
  },
): void {
  const getAccount = options.getAccount ?? ((id) => clerkClient.users.getUser(id));
  const setPrimaryEmail = options.setPrimaryEmail ?? ((id, addressId) =>
    clerkClient.users.updateUser(id, { primaryEmailAddressID: addressId }));

  app.get("/api/staff-access/:userId/profile", requireAdministrator, async (req, res): Promise<void> => {
    try {
      const result = await pool.query<ProfileRow>(profileSql, [req.params.userId]);
      const row = result.rows[0];
      if (!row || (!row.enrolled && !options.isOwnerEmail(row.email))) {
        res.status(404).json({ message: "Staff profile not found. Complete the staff invitation first." });
        return;
      }
      let verifiedEmails: string[] = [];
      let emailMessage = "Sign-in identity is not linked. Complete the verified staff invitation before changing email.";
      if (options.isOwnerEmail(row.email)) {
        emailMessage = "Owner sign-in email is protected and cannot be changed here.";
      } else if (row.clerk_id) {
        try {
          const account = await getAccount(row.clerk_id);
          if (account.id !== row.clerk_id) throw new Error("Identity mismatch");
          verifiedEmails = [...new Set(account.emailAddresses
            .filter((address) => address.verification?.status === "verified")
            .map((address) => emailKey(address.emailAddress))
            .filter((email) => !options.isOwnerEmail(email)))];
          emailMessage = "Choose a verified address on this same sign-in account. To use a new address, the staff member must add and verify it in Manage account first.";
        } catch {
          emailMessage = "Verified sign-in addresses are temporarily unavailable. Other profile details can still be saved.";
        }
      }
      res.json({
        email: row.email,
        phone: row.phone,
        jobTitle: row.job_title,
        department: row.department,
        updatedAt: version(row),
        verifiedEmails,
        emailChangeAvailable: verifiedEmails.length > 0,
        emailMessage,
      });
    } catch {
      res.status(500).json({ message: "Could not load staff contact information." });
    }
  });

  app.patch("/api/staff-access/:userId/profile", requireAdministrator, async (req, res): Promise<void> => {
    const parsed = UpdateStaffContactProfileBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Enter valid staff contact details." });
      return;
    }
    const input = parsed.data;
    const phone = input.phone.trim() ? toValidE164(input.phone) : null;
    if (input.phone.trim() && !phone) {
      res.status(400).json({ message: "Enter a valid phone number, or clear the field." });
      return;
    }
    const client = await pool.connect();
    let providerAttempted = false;
    try {
      await client.query("BEGIN");
      const result = await client.query<ProfileRow>(`${profileSql} FOR UPDATE OF u`, [req.params.userId]);
      const row = result.rows[0];
      if (!row || (!row.enrolled && !options.isOwnerEmail(row.email))) {
        res.status(404).json({ message: "Staff profile not found. Complete the staff invitation first." });
        return;
      }
      if (version(row) !== input.expectedUpdatedAt || emailKey(row.email) !== emailKey(input.expectedEmail)) {
        res.status(409).json({ message: "Staff information changed. Reload the current details before saving." });
        return;
      }
      const email = input.email === undefined ? row.email : emailKey(input.email);
      if (emailKey(email) !== emailKey(row.email)) {
        if (options.isOwnerEmail(row.email) || options.isOwnerEmail(email)) {
          res.status(403).json({ message: "Owner email identities cannot be changed or assigned here." });
          return;
        }
        if (!row.clerk_id || !email) {
          res.status(409).json({ message: "A verified sign-in identity is required before changing email." });
          return;
        }
        const duplicate = await client.query(
          "SELECT 1 FROM auth_users WHERE LOWER(TRIM(email))=$1 AND id<>$2 LIMIT 1",
          [email, row.id],
        );
        if (duplicate.rowCount) {
          res.status(409).json({ message: "This email belongs to another account. No identities were merged." });
          return;
        }
        const account = await getAccount(row.clerk_id);
        const address = account.id === row.clerk_id ? verifiedAccountAddress(account, email) : undefined;
        if (!address) {
          res.status(409).json({ message: "The staff member must verify this address on their own sign-in account first." });
          return;
        }
        providerAttempted = true;
        const updated = account.primaryEmailAddressId === address.id
          ? account
          : await setPrimaryEmail(row.clerk_id, address.id);
        if (updated.id !== row.clerk_id || updated.primaryEmailAddressId !== address.id
          || !verifiedAccountAddress(updated, email)) {
          throw new Error("Provider email update could not be confirmed");
        }
        await client.query("UPDATE auth_users SET email=$2, updated_at=NOW() WHERE id=$1", [row.id, email]);
      }
      const jobTitle = input.jobTitle.trim() || null;
      const department = input.department.trim() || null;
      await client.query(
        `INSERT INTO staff_directory_details(user_id,phone,job_title,department)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(user_id) DO UPDATE SET phone=$2,job_title=$3,department=$4,
           updated_at=GREATEST(NOW(),staff_directory_details.updated_at+INTERVAL '1 millisecond')`,
        [row.id, phone, jobTitle, department],
      );
      await client.query(
        `INSERT INTO staff_access_audit(target_user_id,actor_user_id,action,previous_access,new_access)
         VALUES($1,$2,'staff_profile_updated',$3::jsonb,$4::jsonb)`,
        [
          row.id, req.dbUser?.id ?? null,
          JSON.stringify({ profile: { email: row.email, phone: row.phone, jobTitle: row.job_title, department: row.department } }),
          JSON.stringify({ profile: { email, phone, jobTitle, department } }),
        ],
      );
      await client.query("COMMIT");
      res.json({ saved: true });
    } catch {
      res.status(502).json({
        message: providerAttempted
          ? "The sign-in email may have changed, but the local save could not be confirmed. Reload verified addresses before retrying."
          : "Could not save staff information. No profile changes were committed.",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
}
