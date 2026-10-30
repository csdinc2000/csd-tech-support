import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Clipboard, Clock3, Link2, MailPlus, RotateCcw, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAdminAccess, type StaffRole } from "@/hooks/use-admin-access";
import { ApiRequestError, apiRequest, getQueryFn, queryClient } from "@/lib/queryClient";
import StaffAccountDirectory from "./staff-account-directory";

type InviteRole = Exclude<StaffRole, "owner">;
type InviteStatus = "pending" | "expired" | "accepted" | "revoked";
type EmailDeliveryStatus = "pending" | "accepted" | "delivered" | "bounced" | "failed" | null;
type StaffInvite = {
  id: string;
  email: string;
  role: InviteRole;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  emailDeliveryStatus?: EmailDeliveryStatus;
  emailDeliveryAt?: string | null;
};
type CreatedInvite = { invite: StaffInvite; invitePath: string; emailSent: boolean };
type InviteManagerAccess = Pick<ReturnType<typeof useAdminAccess>, "isAdmin" | "role" | "isLoading">;
type UseInviteManagerAccess = () => InviteManagerAccess;

const roles: Array<{ value: InviteRole; label: string }> = [
  { value: "administrator", label: "Administrator" },
  { value: "field_technician", label: "Field Technician" },
  { value: "software_developer", label: "Software Developer" },
  { value: "accounting", label: "Accounting" },
  { value: "it_manager", label: "IT Manager" },
  { value: "legal_team", label: "Legal Team" },
  { value: "secretary", label: "Secretary" },
];

function readableDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function emailDeliveryLabel(status: EmailDeliveryStatus | undefined) {
  switch (status) {
    case "pending": return "Sending";
    case "accepted": return "Accepted by provider; delivery unconfirmed";
    case "delivered": return "Delivered";
    case "bounced": return "Bounced";
    case "failed": return "Failed";
    default: return "Not tracked";
  }
}

function emailDeliveryStyle(status: EmailDeliveryStatus | undefined) {
  switch (status) {
    case "delivered": return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "accepted": return "border-sky-200 bg-sky-50 text-sky-800";
    case "bounced":
    case "failed": return "border-red-200 bg-red-50 text-red-800";
    case "pending": return "border-amber-200 bg-amber-50 text-amber-900";
    default: return "border-stone-200 bg-stone-100 text-stone-600";
  }
}

function fullInviteLink(invitePath: string) {
  const base = `/${String(import.meta.env.BASE_URL || "/").replace(/^\/+|\/+$/g, "")}`;
  const prefix = base === "/" ? "" : base;
  return `${window.location.origin}${prefix}${invitePath.startsWith("/") ? invitePath : `/${invitePath}`}`;
}

export default function StaffInviteManager({
  useAccess = useAdminAccess,
  showDirectory = true,
  initialEmail,
  targetLabel,
}: {
  useAccess?: UseInviteManagerAccess;
  showDirectory?: boolean;
  initialEmail?: string | null;
  targetLabel?: string;
} = {}) {
  const { isAdmin, role: currentRole, isLoading: accessLoading } = useAccess();
  const emailInputRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState(initialEmail ?? "");
  const [pendingPrefillEmail, setPendingPrefillEmail] = useState<string | null>(null);
  const [role, setRole] = useState<InviteRole>("field_technician");
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [createdLinkRecipient, setCreatedLinkRecipient] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const previousInitialEmail = useRef(initialEmail);
  const emailEditedRef = useRef(false);
  const creatingRef = useRef(false);

  useEffect(() => {
    const nextEmail = initialEmail?.trim() || null;
    if (nextEmail === (previousInitialEmail.current?.trim() || null)) return;
    previousInitialEmail.current = nextEmail;
    if (!nextEmail) return;
    if (creatingRef.current || emailEditedRef.current) {
      setPendingPrefillEmail(nextEmail);
      return;
    }
    setEmail(nextEmail);
    emailEditedRef.current = false;
    setPendingPrefillEmail(null);
    setActionError(null);
    setFeedback(null);
  }, [initialEmail]);

  const invites = useQuery<StaffInvite[]>({
    queryKey: ["/api/staff-access/invites"],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: isAdmin,
    staleTime: 15_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
  });

  if (accessLoading || !isAdmin) return null;

  const sorted = [...(invites.data ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const isReissue = sorted.some((item) => item.email.toLowerCase() === email.trim().toLowerCase() && item.status === "pending");

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || creating) return;
    const recipient = email.trim();
    creatingRef.current = true;
    setCreating(true);
    setActionError(null);
    setFeedback(null);
    try {
      const response = await apiRequest("POST", "/api/staff-access/invites", { email: recipient, role });
      const result = await response.json() as CreatedInvite;
      // Never put the response, which contains the one-time path, in the query cache.
      setCreatedLink(fullInviteLink(result.invitePath));
      setCreatedLinkRecipient(recipient);
      setCopied(false);
      setCopyError(null);
      setEmail("");
      emailEditedRef.current = false;
      setFeedback(result.emailSent
        ? isReissue
          ? "A new invitation email was submitted. The previous pending link no longer works."
          : "Invitation email submitted to the email provider. The recipient must verify this sign-in email before accepting."
        : "Invitation created, but its email could not be submitted. Copy the link below and share it privately.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access/invites"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access/accounts"] }),
      ]);
    } catch (error) {
      setActionError(error instanceof ApiRequestError && error.status === 409
        ? error.message
        : "Could not create the invitation. Check the email address and try again.");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const copyLink = async () => {
    if (!createdLink) return;
    try {
      await navigator.clipboard.writeText(createdLink);
      setCopied(true);
      setCopyError(null);
    } catch {
      setCopied(false);
      setCopyError("Copy failed. Select the link and copy it manually.");
    }
  };

  const revoke = async (id: string) => {
    setRevokingId(id);
    setActionError(null);
    try {
      await apiRequest("POST", `/api/staff-access/invites/${encodeURIComponent(id)}/revoke`);
      setConfirmId(null);
      setFeedback("Invitation revoked. Its link can no longer be used.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access/invites"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/staff-access/accounts"] }),
      ]);
    } catch {
      setActionError("Could not revoke the invitation. Try again.");
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <section className="min-w-0 space-y-4" aria-labelledby="staff-invites-title" data-testid="section-staff-invites">
      <div className="border-l-4 border-csd-red pl-4">
        <div className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-csd-red"><ShieldCheck className="h-4 w-4" aria-hidden="true" /> Owner controls</div>
        <h2 id="staff-invites-title" className="text-xl font-semibold tracking-tight text-stone-950">Staff invitations</h2>
        <p className="mt-1 text-sm text-stone-600">Staff enrollment is invitation-only. Choose a role and share the invitation privately. Recipients can create an invited account or use their existing email or Google sign-in; the verified email must match the invitation. After acceptance, the account stays pending until the owner approves it in Staff Access.</p>
      </div>

      <form onSubmit={create} className="rounded-xl border border-stone-200 bg-[hsl(28,29%,98%)] p-4 shadow-sm md:p-5">
        {targetLabel && <p className="mb-3 text-sm text-stone-600" data-testid="text-invite-target">Invite for selected account: <span className="font-semibold text-stone-900">{targetLabel}</span></p>}
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(180px,0.7fr)_auto] sm:items-end">
          <label className="block min-w-0 text-sm font-medium text-stone-800">Staff email
            <Input ref={emailInputRef} type="email" required autoComplete="email" placeholder="name@company.com" value={email} onChange={(event) => {
              setEmail(event.target.value);
              emailEditedRef.current = true;
            }} className="mt-1.5 bg-white" data-testid="input-invite-email" />
          </label>
          <label className="block min-w-0 text-sm font-medium text-stone-800">Assigned role
            <select value={role} onChange={(event) => setRole(event.target.value as InviteRole)} className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-csd-red" data-testid="select-invite-role">
              {roles.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <Button type="submit" disabled={creating || !email.trim()} className="w-full gap-2 bg-csd-red hover:bg-red-800 sm:w-auto" data-testid="button-create-invite"><MailPlus className="h-4 w-4" aria-hidden="true" />{creating ? "Creating…" : isReissue ? "Reissue invitation" : "Create invitation"}</Button>
        </div>
        <p className="mt-3 text-xs text-stone-500">{isReissue ? "Reissuing this email revokes its previous pending link." : "The recipient must use this exact email address when accepting."}</p>
      </form>

      {pendingPrefillEmail && (
        <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between" role="status" data-testid="notice-pending-invite-prefill">
          <p>
            {creating ? "The current invitation is still being created." : "Your edited email was kept."}
            {" "}Use the selected account email {pendingPrefillEmail}?
          </p>
          <div className="flex shrink-0 gap-2">
            <Button type="button" size="sm" variant="outline" disabled={creating} onClick={() => {
              setEmail(pendingPrefillEmail);
              emailEditedRef.current = false;
              setPendingPrefillEmail(null);
              setActionError(null);
            }} data-testid="button-apply-invite-prefill">Use selected email</Button>
            <Button type="button" size="sm" variant="ghost" disabled={creating} onClick={() => setPendingPrefillEmail(null)} data-testid="button-keep-invite-email">Keep current</Button>
          </div>
        </div>
      )}

      {showDirectory && currentRole === "owner" && (
        <StaffAccountDirectory onSelectEmail={(selectedEmail) => {
          setEmail(selectedEmail);
          emailEditedRef.current = false;
          setPendingPrefillEmail(null);
          setActionError(null);
          emailInputRef.current?.focus();
        }} />
      )}

      {createdLink && (
        <div className="min-w-0 rounded-xl border border-amber-300 bg-amber-50 p-4 md:p-5" role="status" data-testid="panel-created-invite">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3"><Link2 className="mt-0.5 h-5 w-5 shrink-0 text-amber-800" aria-hidden="true" /><div><h3 className="font-semibold text-amber-950">Your one-time invite link is ready</h3><p className="mt-1 text-sm text-amber-900">Recipient: <strong data-testid="text-created-invite-recipient">{createdLinkRecipient}</strong>. Copy it now and share it with this recipient privately. This link cannot be retrieved after dismissal.</p></div></div>
            <Button type="button" size="icon" variant="ghost" aria-label="Dismiss invite link" onClick={() => { setCreatedLink(null); setCopied(false); setCopyError(null); }} data-testid="button-dismiss-invite-link"><X className="h-4 w-4" /></Button>
          </div>
          <div className="mt-4 flex min-w-0 flex-col gap-2 sm:flex-row">
            <Input aria-label="One-time invitation link" readOnly value={createdLink} onFocus={(event) => event.currentTarget.select()} className="min-w-0 bg-white font-mono text-xs" data-testid="input-created-invite-link" />
            <Button type="button" onClick={copyLink} variant="outline" className="shrink-0 gap-2" data-testid="button-copy-invite-link">{copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}{copied ? "Copied" : "Copy link"}</Button>
          </div>
          {copyError && <p role="alert" className="mt-2 text-sm text-red-800" data-testid="error-copy-invite">{copyError}</p>}
        </div>
      )}

      {feedback && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900" data-testid="status-invite-action">{feedback}</p>}
      {actionError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" data-testid="error-invite-action">{actionError}</p>}

      <div className="overflow-hidden rounded-xl border border-stone-200 bg-[hsl(28,29%,98%)] shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-stone-200 px-4 py-3 md:px-5">
          <div><h3 className="font-semibold text-stone-950">Invitation history</h3><p className="text-xs text-stone-500">Links are never shown again in this list.</p></div>
          <Clock3 className="h-4 w-4 shrink-0 text-stone-400" aria-hidden="true" />
        </div>
        {invites.isLoading ? (
          <div className="space-y-3 p-5" aria-label="Loading invitations" data-testid="loading-staff-invites">{[0, 1, 2].map((index) => <div key={index} className="h-12 animate-pulse rounded-md bg-stone-100" />)}</div>
        ) : invites.isError ? (
          <div className="p-5"><p className="text-sm text-red-800" role="alert" data-testid="error-staff-invites">Invitation history could not be loaded.</p><Button type="button" variant="outline" size="sm" className="mt-3 gap-2" onClick={() => void invites.refetch()} data-testid="button-retry-staff-invites"><RotateCcw className="h-3.5 w-3.5" />Try again</Button></div>
        ) : sorted.length === 0 ? (
          <div className="px-5 py-10 text-center" data-testid="empty-staff-invites"><MailPlus className="mx-auto h-7 w-7 text-stone-400" aria-hidden="true" /><p className="mt-3 font-medium text-stone-900">No invitations yet</p><p className="mt-1 text-sm text-stone-500">Create an invitation above to bring someone onto the team.</p></div>
        ) : (
          <ul className="divide-y divide-stone-200">
            {sorted.map((invite) => {
              const status: InviteStatus = invite.status === "pending" && Date.parse(invite.expiresAt) <= Date.now() ? "expired" : invite.status;
              const label = roles.find((option) => option.value === invite.role)?.label ?? invite.role;
              return <li key={invite.id} className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between md:px-5" data-testid={`row-staff-invite-${invite.id}`}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><span className="break-all text-sm font-semibold text-stone-950" data-testid={`text-invite-email-${invite.id}`}>{invite.email}</span><span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${status === "pending" ? "border-amber-200 bg-amber-50 text-amber-900" : status === "accepted" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-stone-200 bg-stone-100 text-stone-600"}`} data-testid={`status-invite-${invite.id}`}>{status}</span></div>
                  <p className="mt-1 text-xs text-stone-500">{label} · Sent {readableDate(invite.createdAt)} · {status === "pending" ? "Expires" : status === "accepted" ? "Accepted" : status === "revoked" ? "Revoked" : "Expired"} {readableDate(status === "accepted" ? invite.acceptedAt : status === "revoked" ? invite.revokedAt : invite.expiresAt)}</p>
                  <p className="mt-1 text-xs text-stone-600" data-testid={`status-invite-email-delivery-${invite.id}`}>
                    Email: <span className={`inline-flex rounded-full border px-2 py-0.5 font-semibold ${emailDeliveryStyle(invite.emailDeliveryStatus)}`}>{emailDeliveryLabel(invite.emailDeliveryStatus)}</span>
                    {invite.emailDeliveryAt && <> · Updated {readableDate(invite.emailDeliveryAt)}</>}
                  </p>
                </div>
                {status === "pending" && (confirmId === invite.id ? (
                  <div className="flex shrink-0 items-center gap-2"><span className="text-xs text-stone-600">Revoke this link?</span><Button type="button" variant="destructive" size="sm" disabled={revokingId === invite.id} onClick={() => void revoke(invite.id)} data-testid={`button-confirm-revoke-invite-${invite.id}`}>{revokingId === invite.id ? "Revoking…" : "Confirm"}</Button><Button type="button" variant="ghost" size="sm" disabled={revokingId === invite.id} onClick={() => setConfirmId(null)} data-testid={`button-cancel-revoke-invite-${invite.id}`}>Cancel</Button></div>
                ) : <Button type="button" variant="outline" size="sm" className="self-start shrink-0 sm:self-auto" onClick={() => setConfirmId(invite.id)} data-testid={`button-revoke-invite-${invite.id}`}>Revoke</Button>)}
              </li>;
            })}
          </ul>
        )}
      </div>
    </section>
  );
}