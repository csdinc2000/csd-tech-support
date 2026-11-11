import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiRequestError, apiRequest } from "@/lib/queryClient";
import { RotateCcw, Search, UserRound } from "lucide-react";
import type { StaffAccountDirectoryEntry } from "./staff-dispatch-handoff";
import { accountAlreadyInStaffAccess, invitePrefillEmail } from "./staff-dispatch-handoff";
import { cn } from "@/lib/utils";

export type AccountsPage = {
  accounts: StaffAccountDirectoryEntry[];
  totalCount: number;
  nextOffset: number | null;
};

const PAGE_SIZE = 20;
const accountsQueryKey = ["/api/staff-access/accounts"];

export function isAccount(value: unknown): value is StaffAccountDirectoryEntry {
  if (!value || typeof value !== "object") return false;
  const account = value as Record<string, unknown>;
  return typeof account.clerkUserId === "string"
    && (account.email === null || typeof account.email === "string")
    && (account.firstName === null || typeof account.firstName === "string")
    && (account.lastName === null || typeof account.lastName === "string")
    && typeof account.emailVerified === "boolean"
    && (account.staffUserId === null || typeof account.staffUserId === "string")
    && (account.approvalStatus === null || ["approved", "pending", "suspended"].includes(String(account.approvalStatus)))
    && (account.invitationStatus === null || ["pending", "expired", "accepted", "revoked"].includes(String(account.invitationStatus)));
}

export function isAccountsPage(value: unknown): value is AccountsPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Record<string, unknown>;
  return Array.isArray(page.accounts)
    && page.accounts.every(isAccount)
    && typeof page.totalCount === "number"
    && (page.nextOffset === null || typeof page.nextOffset === "number");
}

export function accountLabel(account: StaffAccountDirectoryEntry) {
  const name = [account.firstName, account.lastName].map((part) => part?.trim()).filter(Boolean).join(" ");
  return name || account.email || `Account · ${account.clerkUserId.slice(-6)}`;
}

function approvalBadge(account: StaffAccountDirectoryEntry) {
  if (!account.staffUserId) {
    return <Badge variant="outline" className="font-normal">No staff profile</Badge>;
  }
  if (!account.approvalStatus) return <Badge variant="outline" className="font-normal">Staff status unavailable</Badge>;
  if (account.approvalStatus === "approved") {
    return <Badge className="border-emerald-200 bg-emerald-50 text-emerald-800 shadow-none hover:bg-emerald-50">Staff approved</Badge>;
  }
  if (account.approvalStatus === "suspended") {
    return <Badge variant="destructive" className="shadow-none">Staff suspended</Badge>;
  }
  return <Badge className="border-amber-200 bg-amber-50 text-amber-900 shadow-none hover:bg-amber-50">Staff pending</Badge>;
}

function invitationBadge(status: StaffAccountDirectoryEntry["invitationStatus"]) {
  if (!status) return <Badge variant="outline" className="font-normal">No invitation</Badge>;
  const classes = status === "accepted"
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : status === "pending"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-stone-200 bg-stone-100 text-stone-600";
  return <Badge className={`${classes} shadow-none hover:bg-inherit`}>Invite {status}</Badge>;
}

export function StaffAccountDirectoryRoster({
  searchQuery,
  staffProfileIds,
  onMatchedProfileIds,
  selectedClerkUserId,
  onSelectAccount,
}: {
  searchQuery: string;
  staffProfileIds: ReadonlySet<string>;
  onMatchedProfileIds: (profileIds: string[]) => void;
  selectedClerkUserId: string | null;
  onSelectAccount: (account: StaffAccountDirectoryEntry) => void;
}) {
  const [query, setQuery] = useState(searchQuery.trim());
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(searchQuery.trim());
      setOffset(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const accounts = useQuery<AccountsPage>({
    queryKey: [...accountsQueryKey, query, offset],
    queryFn: async () => {
      const params = new URLSearchParams({ q: query, offset: String(offset) });
      const response = await apiRequest("GET", `/api/staff-access/accounts?${params.toString()}`);
      const payload: unknown = await response.json();
      if (!isAccountsPage(payload)) throw new Error("Sign-in accounts response was unusable");
      return payload;
    },
    staleTime: 15_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
  });

  const unlinkedAccounts = (accounts.data?.accounts ?? []).filter((account) =>
    !staffProfileIds.has(account.clerkUserId)
    && !(account.staffUserId && staffProfileIds.has(account.staffUserId)));
  const linkedProfileIds = (accounts.data?.accounts ?? []).flatMap((account) =>
    [account.staffUserId, account.clerkUserId].filter(
      (profileId): profileId is string => profileId !== null && staffProfileIds.has(profileId),
    ));
  const linkedProfileIdsKey = linkedProfileIds.join(",");

  useEffect(() => {
    onMatchedProfileIds(linkedProfileIds);
  }, [linkedProfileIdsKey, onMatchedProfileIds]);

  return (
    <>
      <li className="border-t bg-muted/20 px-4 py-3">
        <p className="text-sm font-semibold">Existing sign-in accounts</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Sign-in alone does not grant staff access. Select an account to review verification and invitation status.</p>
      </li>
      {accounts.isLoading ? (
        <li className="px-4 py-4 text-sm text-muted-foreground" aria-label="Loading sign-in accounts" data-testid="loading-staff-accounts">Loading sign-in accounts…</li>
      ) : accounts.isError ? (
        <li className="space-y-2 px-4 py-4">
          <p className="text-sm text-red-800" role="alert" data-testid="error-staff-accounts">Sign-in accounts could not be loaded{accounts.error instanceof ApiRequestError ? `: ${accounts.error.message}` : "."}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void accounts.refetch()} data-testid="button-retry-staff-accounts"><RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />Try again</Button>
        </li>
      ) : unlinkedAccounts.length === 0 ? (
        <li className="px-4 py-4 text-sm text-muted-foreground" data-testid="empty-staff-accounts">
          {accounts.data?.nextOffset !== null
            ? "No unlinked sign-in accounts on this page."
            : query ? "No matching unlinked sign-in accounts." : "No unlinked sign-in accounts."}
        </li>
      ) : (
        unlinkedAccounts.map((account) => {
          const label = accountLabel(account);
          const enrollmentLabel = account.invitationStatus === "pending"
            ? "Invitation pending"
            : account.invitationStatus === "accepted"
              ? "Invitation accepted · no staff profile"
              : "Not enrolled · invitation needed";
          const selected = selectedClerkUserId === account.clerkUserId;
          return (
            <li key={account.clerkUserId}>
              <button
                type="button"
                className={cn(
                  "w-full px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:bg-muted/50",
                  selected && "bg-muted/60 hover:bg-muted/60",
                )}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelectAccount(account)}
                data-testid={`list-item-clerk-${account.clerkUserId}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{label}</span>
                  <span className="shrink-0 text-xs font-medium text-amber-800">{enrollmentLabel}</span>
                </div>
                {account.email && label !== account.email && <p className="mt-0.5 truncate text-xs text-muted-foreground">{account.email}</p>}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge className={account.emailVerified ? "border-emerald-200 bg-emerald-50 text-emerald-800 shadow-none hover:bg-emerald-50" : "border-amber-200 bg-amber-50 text-amber-900 shadow-none hover:bg-amber-50"}>{account.emailVerified ? "Email verified" : "Email unverified"}</Badge>
                  {invitationBadge(account.invitationStatus)}
                </div>
              </button>
            </li>
          );
        })
      )}
      {!accounts.isLoading && !accounts.isError && accounts.data && accounts.data.totalCount > 0 && (
        <li className="border-t px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground" data-testid="text-staff-account-count">{offset + 1}–{offset + accounts.data.accounts.length} of {accounts.data.totalCount}</p>
            <div className="flex gap-1.5">
              <Button type="button" size="sm" variant="outline" disabled={offset === 0 || accounts.isFetching} onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))} data-testid="button-previous-staff-accounts">Previous</Button>
              <Button type="button" size="sm" variant="outline" disabled={accounts.data.nextOffset === null || accounts.isFetching} onClick={() => setOffset(accounts.data!.nextOffset!)} data-testid="button-next-staff-accounts">Next</Button>
            </div>
          </div>
        </li>
      )}
    </>
  );
}

export default function StaffAccountDirectory({ onSelectEmail }: { onSelectEmail: (email: string) => void }) {
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(searchText.trim());
      setOffset(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchText]);

  const accounts = useQuery<AccountsPage>({
    queryKey: [...accountsQueryKey, query, offset],
    queryFn: async () => {
      const params = new URLSearchParams({ q: query, offset: String(offset) });
      const response = await apiRequest("GET", `/api/staff-access/accounts?${params.toString()}`);
      const payload: unknown = await response.json();
      if (!isAccountsPage(payload)) throw new Error("Sign-in accounts response was unusable");
      return payload;
    },
    staleTime: 15_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
  });

  return (
    <section className="overflow-hidden rounded-xl border border-stone-200 bg-[hsl(28,29%,98%)] shadow-sm" aria-labelledby="staff-account-directory-title" data-testid="section-staff-account-directory">
      <div className="border-b border-stone-200 px-4 py-3 md:px-5">
        <div className="flex items-start gap-2">
          <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-csd-red" aria-hidden="true" />
          <div className="min-w-0">
            <h3 id="staff-account-directory-title" className="font-semibold text-stone-950">Existing sign-in accounts</h3>
            <p className="mt-1 text-xs text-stone-600">A sign-in account alone is not staff access. Staff access still requires an accepted invitation using the verified email, first and last names, and owner approval.</p>
          </div>
        </div>
        <label className="relative mt-3 block">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" aria-hidden="true" />
          <Input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Search sign-in accounts" className="bg-white pl-9" aria-label="Search sign-in accounts" data-testid="input-search-staff-accounts" />
        </label>
      </div>
      {accounts.isLoading ? (
        <div className="space-y-3 p-5" aria-label="Loading sign-in accounts" data-testid="loading-staff-accounts">{[0, 1, 2].map((item) => <div key={item} className="h-14 animate-pulse rounded-md bg-stone-100" />)}</div>
      ) : accounts.isError ? (
        <div className="p-5">
          <p className="text-sm text-red-800" role="alert" data-testid="error-staff-accounts">Sign-in accounts could not be loaded{accounts.error instanceof ApiRequestError ? `: ${accounts.error.message}` : "."}</p>
          <Button type="button" variant="outline" size="sm" className="mt-3 gap-2" onClick={() => void accounts.refetch()} data-testid="button-retry-staff-accounts"><RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />Try again</Button>
        </div>
      ) : !accounts.data?.accounts.length ? (
        <div className="px-5 py-8 text-center" data-testid="empty-staff-accounts">
          <p className="font-medium text-stone-900">{query ? "No matching sign-in accounts" : "No sign-in accounts yet"}</p>
          <p className="mt-1 text-sm text-stone-500">{query ? "Try a different email or account name." : "Accounts appear after someone signs in for the first time."}</p>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-stone-200">
            {accounts.data.accounts.map((account) => {
              const email = invitePrefillEmail(account);
              const alreadyInStaffAccess = accountAlreadyInStaffAccess(account);
              return (
                <li key={account.clerkUserId} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between md:px-5" data-testid={`row-staff-account-${account.clerkUserId}`}>
                  <div className="min-w-0">
                    <p className="break-words text-sm font-semibold text-stone-950" data-testid={`text-staff-account-label-${account.clerkUserId}`}>{accountLabel(account)}</p>
                    {account.email && accountLabel(account) !== account.email && <p className="mt-0.5 break-all text-xs text-stone-500">{account.email}</p>}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge className={account.emailVerified ? "border-emerald-200 bg-emerald-50 text-emerald-800 shadow-none hover:bg-emerald-50" : "border-amber-200 bg-amber-50 text-amber-900 shadow-none hover:bg-amber-50"} data-testid={`status-email-verification-${account.clerkUserId}`}>{account.emailVerified ? "Email verified" : "Email unverified"}</Badge>
                      {invitationBadge(account.invitationStatus)}
                      {approvalBadge(account)}
                    </div>
                  </div>
                  <Button type="button" size="sm" variant="outline" disabled={!email} onClick={() => email && onSelectEmail(email)} data-testid={`button-prefill-staff-invite-${account.clerkUserId}`}>{alreadyInStaffAccess ? "Already in Staff Access" : "Use email"}</Button>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 px-4 py-3 md:px-5">
            <p className="text-xs text-stone-500" data-testid="text-staff-account-count">
              {accounts.data.totalCount === 0 ? "No accounts" : `${offset + 1}–${offset + accounts.data.accounts.length} of ${accounts.data.totalCount}`}
            </p>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" disabled={offset === 0 || accounts.isFetching} onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))} data-testid="button-previous-staff-accounts">Previous</Button>
              <Button type="button" size="sm" variant="outline" disabled={accounts.data.nextOffset === null || accounts.isFetching} onClick={() => setOffset(accounts.data!.nextOffset!)} data-testid="button-next-staff-accounts">Next</Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}