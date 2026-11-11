import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { accountLabel, isAccountsPage, type AccountsPage } from "./staff-account-directory";
import { meetingOnboardingStatus, type MeetingOnboardingPerson } from "./meeting-onboarding-status";

type Profile = MeetingOnboardingPerson & {
  id: string;
  firstName: string | null;
  lastName: string | null;
};
type Invitation = {
  id: string;
  email: string;
  status: "pending" | "expired" | "accepted" | "revoked";
  expiresAt: string;
};

/** Mounted only for an active owner. All reads reuse Staff Access authorization. */
export function MeetingOnboardingHelp({ search }: { search: string }) {
  const [page, setPage] = useState({ search, offset: 0 });
  const offset = page.search === search ? page.offset : 0;
  const profiles = useQuery<Profile[]>({
    queryKey: ["/api/staff-access"],
    queryFn: getQueryFn({ on401: "throw" }),
    staleTime: 15_000,
    refetchOnWindowFocus: "always",
  });
  const invitations = useQuery<Invitation[]>({
    queryKey: ["/api/staff-access/invites"],
    queryFn: getQueryFn({ on401: "throw" }),
    staleTime: 15_000,
    refetchOnWindowFocus: "always",
  });
  const accounts = useQuery<AccountsPage>({
    queryKey: ["/api/staff-access/accounts", "meeting-onboarding", search, offset],
    queryFn: async () => {
      const params = new URLSearchParams({ q: search, offset: String(offset) });
      const response = await apiRequest("GET", `/api/staff-access/accounts?${params}`);
      const payload: unknown = await response.json();
      if (!isAccountsPage(payload)) throw new Error("Sign-in accounts response was unusable");
      return payload;
    },
    staleTime: 15_000,
    refetchOnWindowFocus: "always",
  });
  const matches = (name: string, email: string | null) =>
    `${name} ${email ?? ""}`.toLowerCase().includes(search.toLowerCase());
  const profileIds = new Set((profiles.data ?? []).map((profile) => profile.id));
  const rows = (profiles.data ?? []).flatMap((profile) => {
    const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ") || profile.email || "Staff account";
    const status = meetingOnboardingStatus(profile);
    return status && matches(name, profile.email)
      ? [{ key: `profile-${profile.id}`, name, email: profile.email, ...status }]
      : [];
  });
  // Only exact IDs/explicit links identify the same account, never names or email.
  const accountRows = (accounts.data?.accounts ?? []).flatMap((account) => {
    if (profileIds.has(account.clerkUserId) || (account.staffUserId && profileIds.has(account.staffUserId))) return [];
    const status = meetingOnboardingStatus(account);
    return status ? [{
      key: `account-${account.clerkUserId}`, name: accountLabel(account), email: account.email, ...status,
    }] : [];
  });
  const pendingInvitations = (invitations.data ?? []).filter((invite) =>
    invite.status === "pending" && new Date(invite.expiresAt).getTime() > Date.now() && matches("", invite.email));
  const loading = profiles.isFetching || accounts.isFetching || invitations.isFetching;
  const failed = profiles.isError || accounts.isError || invitations.isError;

  return (
    <aside className="space-y-3 rounded-lg border bg-muted/20 p-3 text-xs" aria-label="Owner-only staff onboarding help" data-testid="meeting-onboarding-help">
      <div>
        <h3 className="text-sm font-semibold">Missing someone? Staff onboarding · Owner only</h3>
        <p className="mt-1 text-muted-foreground">Only approved staff with a valid email appear in the picker or “Invite all approved staff.” A sign-in account or a staff invitation alone is not enough.</p>
        <Link href="/staff-access" className="mt-2 inline-block font-medium underline underline-offset-2">Open Staff Access to invite or review people</Link>
      </div>
      <p className="text-muted-foreground">These entries explain onboarding only; they cannot be selected as meeting attendees. Search above by name or email. Pending staff invitations are shown separately and do not establish account identity.</p>
      {loading && <p role="status">Checking staff onboarding…</p>}
      {failed && <div role="alert">
        <p>Some onboarding details could not be loaded. Results may be incomplete; this does not mean the person has no account.</p>
        <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => {
          void profiles.refetch(); void accounts.refetch(); void invitations.refetch();
        }}>Retry onboarding details</Button>
      </div>}
      <ul className="max-h-64 space-y-2 overflow-y-auto" aria-label="People not available as staff attendees">
        {[...rows, ...accountRows].map((row) => <li key={row.key} className="rounded border bg-background p-2">
          <p className="break-words font-medium">{row.name}{row.email && row.name !== row.email ? ` · ${row.email}` : ""}</p>
          <p className="mt-1 font-semibold">{row.label}</p>
          <p className="mt-1 text-muted-foreground">{row.guidance}</p>
          <Link href="/staff-access" className="mt-1 inline-block underline">Review in Staff Access</Link>
        </li>)}
      </ul>
      {!loading && !failed && rows.length === 0 && accountRows.length === 0 && <p>No onboarding blockers found in the loaded accounts{search ? " matching this search" : ""}. This is not the full sign-in directory.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <span>Sign-in accounts: page {Math.floor(offset / 20) + 1}{accounts.data ? ` · ${accounts.data.totalCount} matching accounts` : ""}</span>
        <Button type="button" variant="outline" size="sm" disabled={offset === 0 || loading} onClick={() => setPage({ search, offset: Math.max(0, offset - 20) })}>Previous accounts</Button>
        <Button type="button" variant="outline" size="sm" disabled={accounts.data?.nextOffset == null || loading || accounts.isError} onClick={() => setPage({ search, offset: accounts.data?.nextOffset ?? offset })}>Next accounts</Button>
      </div>
      <div className="space-y-2 border-t pt-2">
        <p className="font-semibold">Pending staff invitations</p>
        <p className="text-muted-foreground">Matching active invitations from the latest 100 invitations. Older invitations are not included.</p>
        {pendingInvitations.map((invite) => <div key={invite.id} className="rounded border bg-background p-2">
          <p className="break-words font-medium">{invite.email} · Invitation pending</p>
          <p className="mt-1 text-muted-foreground">Accept the invitation with this verified email, complete the profile, then await owner approval. This is a staff enrollment invitation, not a meeting invitation.</p>
          <Link href="/staff-access" className="mt-1 inline-block underline">Manage invitation in Staff Access</Link>
        </div>)}
        {!invitations.isFetching && !invitations.isError && pendingInvitations.length === 0 && <p>No matching active invitations in the latest 100.</p>}
      </div>
    </aside>
  );
}
