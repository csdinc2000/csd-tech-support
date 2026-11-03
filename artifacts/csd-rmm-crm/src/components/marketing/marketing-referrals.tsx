import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  AlertTriangle, Ban, CheckCircle2, ExternalLink, Gift, Mail, PauseCircle, PlayCircle, RotateCcw, Settings2, Trophy,
  UserPlus, Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { formatPhone, humanize } from "@/components/dashboard/tech-board/types";
import { CopyButton, MarketingCard, StatTile } from "./shared";

type ReferralStatus = "pending" | "qualified" | "rewarded" | "declined";
type Program = { active: boolean; referrerReward: string; friendReward: string; terms: string };
type Referral = {
  id: number; status: ReferralStatus; friendName: string; friendEmail: string | null; friendPhone: string | null;
  existingCustomer: boolean; note: string | null; intakeRecordId: number | null; leadId: number | null; contactId: number | null;
  createdAt: string; qualifiedAt: string | null; rewardedAt: string | null;
  referrer: { id: number; name: string; email: string; code: string };
  leadStatus: string | null; jobCompleted: boolean;
};
type Referrer = {
  id: number; code: string; fullName: string; email: string; phone: string | null; status: "active" | "paused";
  createdAt: string; referralCount: number; rewardedCount: number; shareUrl: string;
};
type ReferralData = {
  settings: Program;
  summary: { total: number; pending: number; qualified: number; rewarded: number; declined: number };
  referrals: Referral[];
  referrers: Referrer[];
};

const QUERY_KEY = ["/api/crm/referrals"];
const STATUS_TONE: Record<ReferralStatus, string> = {
  pending: "bg-amber-100 text-amber-800",
  qualified: "bg-blue-100 text-blue-800",
  rewarded: "bg-emerald-100 text-emerald-800",
  declined: "bg-gray-100 text-gray-600",
};
const FILTERS: { id: ReferralStatus | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pending", label: "Pending" },
  { id: "qualified", label: "Ready to reward" },
  { id: "rewarded", label: "Rewarded" },
  { id: "declined", label: "Declined" },
];

const errorText = (error: unknown) => (error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "Request failed");

export function MarketingReferrals({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast();
  const { data, isLoading, error } = useQuery<ReferralData>({ queryKey: QUERY_KEY });
  const [filter, setFilter] = useState<ReferralStatus | "all">("pending");
  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const update = useMutation({
    mutationFn: async ({ id, ...body }: { id: number; status?: ReferralStatus; note?: string }) =>
      (await apiRequest("PATCH", `/api/crm/referrals/${id}`, body)).json() as Promise<{ emailed: boolean }>,
    onSuccess: (result, vars) => {
      refresh();
      if (vars.status === "rewarded") {
        toast({ title: "Marked as rewarded", description: result.emailed ? "The referrer was emailed." : "The referrer email could not be sent." });
      }
    },
    onError: (err) => toast({ title: "Couldn't update referral", description: errorText(err), variant: "destructive" }),
  });

  if (error) return <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">Couldn't load referrals: {errorText(error)}</p>;

  const referrals = data?.referrals ?? [];
  const shown = filter === "all" ? referrals : referrals.filter((r) => r.status === filter);
  const readyToQualify = referrals.filter((r) => r.status === "pending" && r.jobCompleted).length;

  return (
    <div className="space-y-4" data-testid="marketing-referrals">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 xl:grid-cols-5">
        <StatTile icon={Users} label="Referrers" value={isLoading ? "–" : data?.referrers.length ?? 0} hint="Customers sharing a link" />
        <StatTile icon={Gift} label="Referrals" value={isLoading ? "–" : data?.summary.total ?? 0} hint="Requests with a code" />
        <StatTile icon={AlertTriangle} label="Pending" value={isLoading ? "–" : data?.summary.pending ?? 0} hint={`${readyToQualify} with a completed job`} testId="ref-stat-pending" />
        <StatTile icon={CheckCircle2} label="Ready to reward" value={isLoading ? "–" : data?.summary.qualified ?? 0} hint="Qualified, not yet paid" />
        <StatTile icon={Trophy} label="Rewarded" value={isLoading ? "–" : data?.summary.rewarded ?? 0} hint="Rewards issued" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <MarketingCard
          icon={Gift}
          title="Referrals"
          description="Qualify after the friend's first paid job is completed; mark rewarded once the reward is issued"
          className="xl:col-span-2 xl:self-start"
          bodyClassName="p-0"
          testId="ref-list"
        >
          <div className="flex gap-1.5 overflow-x-auto border-b border-gray-100 px-4 py-2 [scrollbar-width:none]" role="tablist" aria-label="Filter referrals">
            {FILTERS.map((f) => {
              const count = f.id === "all" ? referrals.length : referrals.filter((r) => r.status === f.id).length;
              return (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.id}
                  onClick={() => setFilter(f.id)}
                  className={cn("shrink-0 rounded-full px-2.5 py-1 text-xs font-medium", filter === f.id ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200")}
                  data-testid={`ref-filter-${f.id}`}
                >
                  {f.label} <span className="tabular-nums opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
          {isLoading ? (
            <p className="px-4 py-10 text-center text-sm text-gray-500">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-gray-500">
              {referrals.length === 0 ? "No referrals yet. Share the program from the portal or enroll a customer." : "Nothing in this view."}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {shown.map((referral) => (
                <ReferralRow key={referral.id} referral={referral} busy={update.isPending} onUpdate={(body) => update.mutate({ id: referral.id, ...body })} />
              ))}
            </ul>
          )}
        </MarketingCard>

        <div className="space-y-4">
          <EnrollCard onEnrolled={refresh} />
          <ProgramCard settings={data?.settings} canEdit={isAdmin} />
        </div>
      </div>

      <ReferrersCard referrers={data?.referrers ?? []} isLoading={isLoading} onChanged={refresh} />
    </div>
  );
}

function ReferralRow({ referral, busy, onUpdate }: { referral: Referral; busy: boolean; onUpdate: (body: { status?: ReferralStatus; note?: string }) => void }) {
  const [note, setNote] = useState(referral.note ?? "");
  const [editing, setEditing] = useState(false);
  const contact = [referral.friendPhone ? formatPhone(referral.friendPhone) : null, referral.friendEmail].filter(Boolean).join(" · ");
  const actions: { status: ReferralStatus; label: string; icon: React.ComponentType<{ className?: string }>; primary?: boolean }[] = (() => {
    switch (referral.status) {
      case "pending": return [{ status: "qualified", label: "Qualify", icon: CheckCircle2, primary: true }, { status: "declined", label: "Decline", icon: Ban }];
      case "qualified": return [{ status: "rewarded", label: "Mark rewarded", icon: Trophy, primary: true }, { status: "pending", label: "Back to pending", icon: RotateCcw }];
      case "rewarded": return [{ status: "qualified", label: "Undo reward", icon: RotateCcw }];
      case "declined": return [{ status: "pending", label: "Reopen", icon: RotateCcw }];
    }
  })();

  return (
    <li className="space-y-2 px-4 py-3" data-testid={`ref-row-${referral.id}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-gray-900">{referral.friendName}</span>
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", STATUS_TONE[referral.status])}>{humanize(referral.status)}</span>
            {referral.jobCompleted && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800">Job completed</span>}
            {referral.existingCustomer && (
              <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-[11px] font-medium text-orange-800" title="The request matched a contact that already existed">
                <AlertTriangle className="h-3 w-3" />Existing customer
              </span>
            )}
          </div>
          {contact && <p className="truncate text-xs text-gray-500">{contact}</p>}
          <p className="text-xs text-gray-500">
            Referred by <span className="font-medium text-gray-700">{referral.referrer.name}</span> ({referral.referrer.code}) · {format(new Date(referral.createdAt), "MMM d, yyyy")}
            {referral.leadStatus && <> · Lead {humanize(referral.leadStatus)}</>}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <Button
                key={action.status}
                size="sm"
                variant={action.primary ? "default" : "outline"}
                className={action.primary ? "bg-csd-red hover:bg-red-700" : undefined}
                disabled={busy}
                onClick={() => onUpdate({ status: action.status })}
                data-testid={`ref-action-${referral.id}-${action.status}`}
              >
                <Icon className="mr-1.5 h-3.5 w-3.5" />{action.label}
              </Button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {referral.leadId != null && (
          <Link href="/crm/leads" className="inline-flex items-center gap-1 text-gray-600 hover:text-csd-red"><ExternalLink className="h-3 w-3" />Leads</Link>
        )}
        {editing ? (
          <form
            className="flex w-full flex-col gap-2 sm:flex-row"
            onSubmit={(e) => { e.preventDefault(); onUpdate({ note }); setEditing(false); }}
          >
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. $25 credit applied to invoice INV-1042" className="h-8 text-xs" aria-label="Staff note" />
            <div className="flex gap-2">
              <Button type="submit" size="sm" variant="outline" disabled={busy}>Save</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => { setNote(referral.note ?? ""); setEditing(false); }}>Cancel</Button>
            </div>
          </form>
        ) : (
          <button type="button" className="text-gray-600 hover:text-csd-red" onClick={() => setEditing(true)}>
            {referral.note ? <>Note: <span className="text-gray-800">{referral.note}</span></> : "+ Add note"}
          </button>
        )}
      </div>
    </li>
  );
}

function EnrollCard({ onEnrolled }: { onEnrolled: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({ fullName: "", email: "", phone: "" });
  const [result, setResult] = useState<{ code: string; shareUrl: string; emailed: boolean } | null>(null);
  const enroll = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/crm/referrals/referrers", form)).json() as Promise<{ referrer: { code: string; shareUrl: string }; emailed: boolean }>,
    onSuccess: (res) => {
      setResult({ ...res.referrer, emailed: res.emailed });
      setForm({ fullName: "", email: "", phone: "" });
      onEnrolled();
    },
    onError: (err) => toast({ title: "Couldn't enroll customer", description: errorText(err), variant: "destructive" }),
  });
  return (
    <MarketingCard icon={UserPlus} title="Enroll a customer" description="At the counter or on the phone — we email them their link" testId="ref-enroll">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); enroll.mutate(); }}>
        <div className="space-y-1.5">
          <Label htmlFor="enroll-name" className="text-xs">Name</Label>
          <Input id="enroll-name" required value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="enroll-email" className="text-xs">Email</Label>
          <Input id="enroll-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="enroll-phone" className="text-xs">Phone (optional)</Label>
          <Input id="enroll-phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <Button type="submit" size="sm" className="w-full bg-csd-red hover:bg-red-700" disabled={enroll.isPending}>
          <Mail className="mr-1.5 h-3.5 w-3.5" />{enroll.isPending ? "Enrolling…" : "Enroll & email link"}
        </Button>
      </form>
      {result && (
        <div className="mt-3 space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900" data-testid="ref-enroll-result">
          <p>Code <span className="font-mono font-semibold">{result.code}</span>{result.emailed ? " — link emailed." : " — email could not be sent; share the link below."}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate">{result.shareUrl}</code>
            <CopyButton text={result.shareUrl} label="Copy" className="h-7 shrink-0" />
          </div>
        </div>
      )}
    </MarketingCard>
  );
}

function ProgramCard({ settings, canEdit }: { settings?: Program; canEdit: boolean }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Program | null>(null);
  useEffect(() => { if (settings) setDraft(settings); }, [settings]);
  const save = useMutation({
    mutationFn: async (body: Program) => (await apiRequest("PUT", "/api/crm/referrals/settings", body)).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: QUERY_KEY }); toast({ title: "Referral program updated" }); },
    onError: (err) => toast({ title: "Couldn't save", description: errorText(err), variant: "destructive" }),
  });
  if (!draft) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  return (
    <MarketingCard
      icon={Settings2}
      title="Program settings"
      description={canEdit ? "What customers see on the portal" : "Only account owners can change rewards"}
      testId="ref-settings"
      actions={
        <Button asChild size="sm" variant="outline">
          <a href={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/portal/referrals`} target="_blank" rel="noreferrer"><ExternalLink className="mr-1.5 h-3.5 w-3.5" />Portal page</a>
        </Button>
      }
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium text-gray-800">Program active</span>
          <Switch checked={draft.active} disabled={!canEdit} onCheckedChange={(active) => setDraft({ ...draft, active })} aria-label="Program active" />
        </label>
        <div className="space-y-1.5">
          <Label htmlFor="ref-referrer-reward" className="text-xs">Referrer reward</Label>
          <Input id="ref-referrer-reward" value={draft.referrerReward} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, referrerReward: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ref-friend-reward" className="text-xs">Friend reward</Label>
          <Input id="ref-friend-reward" value={draft.friendReward} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, friendReward: e.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ref-terms" className="text-xs">Terms</Label>
          <Textarea id="ref-terms" rows={5} value={draft.terms} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, terms: e.target.value })} className="text-xs" />
        </div>
        {canEdit && (
          <Button type="submit" size="sm" className="w-full" disabled={!dirty || save.isPending}>{save.isPending ? "Saving…" : "Save settings"}</Button>
        )}
      </form>
    </MarketingCard>
  );
}

function ReferrersCard({ referrers, isLoading, onChanged }: { referrers: Referrer[]; isLoading: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const resend = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/crm/referrals/referrers/${id}/resend`)).json() as Promise<{ emailed: boolean }>,
    onSuccess: (res) => toast({ title: res.emailed ? "Link emailed" : "Email could not be sent", variant: res.emailed ? "default" : "destructive" }),
    onError: (err) => toast({ title: "Couldn't resend", description: errorText(err), variant: "destructive" }),
  });
  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: "active" | "paused" }) => apiRequest("PATCH", `/api/crm/referrals/referrers/${id}`, { status }),
    onSuccess: onChanged,
    onError: (err) => toast({ title: "Couldn't update referrer", description: errorText(err), variant: "destructive" }),
  });
  return (
    <MarketingCard icon={Users} title="Referrers" description="Customers enrolled in the program" bodyClassName="p-0" testId="ref-referrers">
      {isLoading ? (
        <p className="px-4 py-8 text-center text-sm text-gray-500">Loading…</p>
      ) : referrers.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-gray-500">No one has joined yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {referrers.map((referrer) => (
            <li key={referrer.id} className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:justify-between" data-testid={`ref-referrer-${referrer.id}`}>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium text-gray-900">
                  {referrer.fullName}
                  <span className="font-mono text-xs text-gray-500">{referrer.code}</span>
                  {referrer.status === "paused" && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">Paused</span>}
                </p>
                <p className="truncate text-xs text-gray-500">
                  {referrer.email} · {referrer.referralCount} referral{referrer.referralCount === 1 ? "" : "s"} · {referrer.rewardedCount} rewarded · joined {format(new Date(referrer.createdAt), "MMM d, yyyy")}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <CopyButton text={referrer.shareUrl} label="Copy link" />
                <Button size="sm" variant="outline" disabled={resend.isPending} onClick={() => resend.mutate(referrer.id)}>
                  <Mail className="mr-1.5 h-3.5 w-3.5" />Resend
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={setStatus.isPending}
                  onClick={() => setStatus.mutate({ id: referrer.id, status: referrer.status === "active" ? "paused" : "active" })}
                >
                  {referrer.status === "active"
                    ? <><PauseCircle className="mr-1.5 h-3.5 w-3.5" />Pause</>
                    : <><PlayCircle className="mr-1.5 h-3.5 w-3.5" />Activate</>}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </MarketingCard>
  );
}
