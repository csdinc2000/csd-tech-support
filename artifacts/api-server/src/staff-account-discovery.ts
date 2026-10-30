import type { Express, RequestHandler } from "express";
import { clerkClient } from "@clerk/express";
import { pool } from "./db";

const PAGE_SIZE = 20;

type ClerkAccount = {
  id: string;
  emailAddresses: Array<{
    id: string;
    emailAddress: string;
    verification?: { status: string } | null;
  }>;
  primaryEmailAddressId: string | null;
  firstName: string | null;
  lastName: string | null;
};

type ClerkAccountListOptions = {
  query: string | undefined;
  limit: 20;
  offset: number;
  orderBy: "-created_at";
  userId?: string[];
};

export type ListClerkAccounts = (
  options: ClerkAccountListOptions,
) => Promise<{ data: ClerkAccount[]; totalCount: number }>;

const listClerkAccounts: ListClerkAccounts = (options) =>
  clerkClient.users.getUserList(options);

function cleanName(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeEmail(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : null;
}

function parseOffset(value: unknown): number | null {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const offset = Number(value);
  return Number.isSafeInteger(offset) ? offset : null;
}

export function registerStaffAccountDiscoveryRoute(
  app: Express,
  requireOwner: RequestHandler,
  listAccounts: ListClerkAccounts = listClerkAccounts,
): void {
  app.get("/api/staff-access/accounts", requireOwner, async (req, res): Promise<void> => {
    const rawClerkUserId = req.query.clerkUserId;
    if (
      rawClerkUserId !== undefined &&
      (typeof rawClerkUserId !== "string" ||
        rawClerkUserId.length > 100 ||
        !/^user_[A-Za-z0-9]+$/.test(rawClerkUserId))
    ) {
      res.status(400).json({ message: "Invalid Clerk user ID" });
      return;
    }
    const clerkUserId = typeof rawClerkUserId === "string" ? rawClerkUserId : undefined;

    const rawQuery = req.query.q;
    if (rawQuery !== undefined && typeof rawQuery !== "string") {
      res.status(400).json({ message: "Invalid account search query" });
      return;
    }
    const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
    if (query.length > 100) {
      res.status(400).json({ message: "Account search query must be 100 characters or fewer" });
      return;
    }

    const offset = parseOffset(req.query.offset);
    if (offset === null) {
      res.status(400).json({ message: "Offset must be a nonnegative integer" });
      return;
    }

    let page: Awaited<ReturnType<ListClerkAccounts>>;
    try {
      const options: ClerkAccountListOptions = {
        query: query || undefined,
        limit: PAGE_SIZE,
        offset,
        orderBy: "-created_at",
      };
      if (clerkUserId) options.userId = [clerkUserId];
      page = await listAccounts(options);
    } catch {
      // Provider exceptions can contain sensitive request details or raw payloads.
      res.status(503).json({ message: "Could not discover Clerk accounts" });
      return;
    }

    const clerkUserIds = page.data.map((account) => account.id);
    const primaryEmails = page.data.map((account) => {
      const primary = account.emailAddresses.find(
        (address) => address.id === account.primaryEmailAddressId,
      );
      return normalizeEmail(primary?.emailAddress);
    });
    const emailsForInvites = [...new Set(primaryEmails.filter((email): email is string => email !== null))];

    try {
      const staffByClerkId = new Map<string, {
        staffUserId: string;
        approvalStatus: "approved" | "pending" | "suspended";
      }>();
      if (clerkUserIds.length > 0) {
        // Clerk's publicMetadata.userId is not an established migrated-identity
        // convention in this codebase. Resolve identities only as clerkAuth does:
        // an explicit link first, then an exact auth_users.id match.
        const matches = await pool.query<{
          clerk_user_id: string;
          staff_user_id: string;
          approval_status: "approved" | "pending" | "suspended";
        }>(
          `SELECT requested.clerk_user_id, profile.user_id AS staff_user_id, profile.approval_status
           FROM UNNEST($1::text[]) AS requested(clerk_user_id)
           LEFT JOIN auth_user_clerk_links link ON link.clerk_user_id = requested.clerk_user_id
           JOIN auth_users local_user
             ON local_user.id = COALESCE(link.auth_user_id, requested.clerk_user_id)
           JOIN staff_access_profiles profile ON profile.user_id = local_user.id`,
          [clerkUserIds],
        );
        for (const match of matches.rows) {
          staffByClerkId.set(match.clerk_user_id, {
            staffUserId: String(match.staff_user_id),
            approvalStatus: match.approval_status,
          });
        }
      }

      const invitationByEmail = new Map<string, "pending" | "expired" | "accepted" | "revoked">();
      if (emailsForInvites.length > 0) {
        const invitations = await pool.query<{
          normalized_email: string;
          expires_at: Date | string;
          accepted_at: Date | string | null;
          revoked_at: Date | string | null;
        }>(
          `SELECT DISTINCT ON (LOWER(BTRIM(email)))
             LOWER(BTRIM(email)) AS normalized_email, expires_at, accepted_at, revoked_at
           FROM staff_invites
           WHERE LOWER(BTRIM(email)) = ANY($1::text[])
           ORDER BY LOWER(BTRIM(email)), created_at DESC, id DESC`,
          [emailsForInvites],
        );
        for (const invitation of invitations.rows) {
          const status = invitation.accepted_at
            ? "accepted"
            : invitation.revoked_at
              ? "revoked"
              : new Date(invitation.expires_at).getTime() <= Date.now()
                ? "expired"
                : "pending";
          invitationByEmail.set(invitation.normalized_email, status);
        }
      }

      const accounts = page.data.map((account, index) => {
        const primary = account.emailAddresses.find(
          (address) => address.id === account.primaryEmailAddressId,
        );
        const email = cleanName(primary?.emailAddress);
        const staff = staffByClerkId.get(account.id);
        return {
          clerkUserId: account.id,
          email,
          firstName: cleanName(account.firstName),
          lastName: cleanName(account.lastName),
          emailVerified: primary?.verification?.status === "verified",
          staffUserId: staff?.staffUserId ?? null,
          approvalStatus: staff?.approvalStatus ?? null,
          invitationStatus: primaryEmails[index]
            ? invitationByEmail.get(primaryEmails[index]!) ?? null
            : null,
        };
      });
      const totalCount = Number(page.totalCount);
      const nextOffset = offset + accounts.length < totalCount
        ? offset + accounts.length
        : null;
      res.json({ accounts, totalCount, nextOffset });
    } catch {
      res.status(500).json({ message: "Could not load staff account details" });
    }
  });
}