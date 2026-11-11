import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, ChevronRight, ClipboardList, Info, MessageSquare, Phone, Plus, Radio, ShieldCheck, Trash2, UserRoundPen, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { DispatchRecipient, useStaffDispatch } from "@/hooks/use-staff-dispatch";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import { useLocation, useSearch } from "wouter";
import { dispatchDraftForAssignee, resolveDispatchAssigneeHandoff } from "./staff-dispatch-handoff";

type RecipientDraft = Omit<DispatchRecipient, "id" | "updatedAt">;
type RecipientFlag = "enabled" | "onDuty" | "receiveCalls" | "receiveMessages" | "canUseCommands";
type FlagItem = { label: string; checked: boolean; key: RecipientFlag };

const blankRecipient: RecipientDraft = {
  name: "",
  role: "staff",
  phone: "",
  enabled: true,
  onDuty: true,
  receiveCalls: true,
  receiveMessages: true,
  canUseCommands: false,
  linkedUserId: null,
};

const recipientFlagItems = (recipient: RecipientDraft): FlagItem[] => [
  { label: "Active recipient", checked: recipient.enabled, key: "enabled" },
  { label: "Start on duty", checked: recipient.onDuty, key: "onDuty" },
  { label: "Receive calls", checked: recipient.receiveCalls, key: "receiveCalls" },
  { label: "Receive messages", checked: recipient.receiveMessages, key: "receiveMessages" },
  { label: "Can use commands", checked: recipient.canUseCommands, key: "canUseCommands" },
];

const normalizeUsPhone = (value: string) => {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
};

const when = (value?: string) => {
  if (!value) return "Recently";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Recently" : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

function PresenceDot({ active }: { active: boolean }) {
  return <span aria-label={active ? "On duty" : "Off duty"} className={`inline-block h-2 w-2 rounded-full ${active ? "bg-emerald-600" : "bg-stone-300"}`} />;
}

export default function DispatchSettingsPage({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const { toast } = useToast();
  const { settings, audit, eligibleAssignees, create, update, remove } = useStaffDispatch();
  const search = useSearch();
  const [pathname, setLocation] = useLocation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DispatchRecipient | null>(null);
  const [draft, setDraft] = useState<RecipientDraft>(blankRecipient);
  const [assigneeHandoffWarning, setAssigneeHandoffWarning] = useState<string | null>(null);
  const handledAssigneeParam = useRef<string | null>(null);

  const recipients = settings.data?.recipients ?? [];
  const routeNames = useMemo(() => {
    const pick = (ids: number[]) => recipients.filter((person) => ids.includes(person.id)).map((person) => person.name);
    return {
      calls: pick(settings.data?.routing.activeCallRecipients ?? []),
      messages: pick(settings.data?.routing.activeMessageRecipients ?? []),
    };
  }, [recipients, settings.data?.routing.activeCallRecipients, settings.data?.routing.activeMessageRecipients]);
  const normalizedPhone = normalizeUsPhone(draft.phone);
  const isPending = create.isPending || update.isPending;
  const isDirty = editing
    ? JSON.stringify(draft) !== JSON.stringify({ name: editing.name, role: editing.role, phone: editing.phone, enabled: editing.enabled, onDuty: editing.onDuty, receiveCalls: editing.receiveCalls, receiveMessages: editing.receiveMessages, canUseCommands: editing.canUseCommands, linkedUserId: editing.linkedUserId ?? null })
    : JSON.stringify(draft) !== JSON.stringify(blankRecipient);
  useUnsavedChangesGuard(dialogOpen && isDirty, "You have unsaved dispatch recipient changes. Leave this page and discard them?");
  useEffect(() => {
    onDirtyChange?.(dialogOpen && isDirty);
    return () => onDirtyChange?.(false);
  }, [dialogOpen, isDirty, onDirtyChange]);
  const receivesAnything = draft.enabled && draft.onDuty && (draft.receiveCalls || draft.receiveMessages);

  const closeDialog = () => {
    setDialogOpen(false);
    setDraft(blankRecipient);
    setEditing(null);
  };
  const openNew = () => {
    setEditing(null);
    setDraft(blankRecipient);
    setDialogOpen(true);
  };
  const openEdit = (recipient: DispatchRecipient) => {
    setEditing(recipient);
    setDraft({ name: recipient.name, role: recipient.role, phone: recipient.phone, enabled: recipient.enabled, onDuty: recipient.onDuty, receiveCalls: recipient.receiveCalls, receiveMessages: recipient.receiveMessages, canUseCommands: recipient.canUseCommands, linkedUserId: recipient.linkedUserId ?? null });
    setDialogOpen(true);
  };
  useEffect(() => {
    const params = new URLSearchParams(search);
    const rawAssigneeId = params.get("assigneeId");
    if (rawAssigneeId === null) {
      handledAssigneeParam.current = null;
      return;
    }
    if (handledAssigneeParam.current === rawAssigneeId) return;

    const clearAssigneeParam = () => {
      params.delete("assigneeId");
      const remainingSearch = params.toString();
      setLocation(`${pathname}${remainingSearch ? `?${remainingSearch}` : ""}`);
    };
    const numericId = Number(rawAssigneeId);
    if (!/^\d+$/.test(rawAssigneeId) || !Number.isSafeInteger(numericId) || numericId <= 0) {
      handledAssigneeParam.current = rawAssigneeId;
      setAssigneeHandoffWarning("The Dispatch link contains an invalid helpdesk assignee ID.");
      clearAssigneeParam();
      return;
    }
    if (dialogOpen) {
      handledAssigneeParam.current = rawAssigneeId;
      setAssigneeHandoffWarning("The assignee link was not applied because a recipient form is already open. Close it before opening the linked assignee.");
      clearAssigneeParam();
      return;
    }
    if (settings.isLoading || settings.isFetching || !settings.data) return;
    const configuredRecipient = resolveDispatchAssigneeHandoff(numericId, settings.data.recipients, []);
    if (configuredRecipient.kind === "edit") {
      handledAssigneeParam.current = rawAssigneeId;
      setAssigneeHandoffWarning(null);
      openEdit(configuredRecipient.recipient);
      clearAssigneeParam();
      return;
    }
    if (eligibleAssignees.isLoading || eligibleAssignees.isFetching) return;
    if (eligibleAssignees.isError) {
      handledAssigneeParam.current = rawAssigneeId;
      setAssigneeHandoffWarning("Approved assignees could not be checked. Reload eligible assignees and try opening Configure Dispatch again.");
      clearAssigneeParam();
      return;
    }
    if (!eligibleAssignees.data) return;

    handledAssigneeParam.current = rawAssigneeId;
    const handoff = resolveDispatchAssigneeHandoff(
      numericId,
      settings.data.recipients,
      eligibleAssignees.data,
    );
    if (handoff.kind === "edit") {
      setAssigneeHandoffWarning(null);
      openEdit(handoff.recipient);
    } else if (handoff.kind === "add") {
      setAssigneeHandoffWarning(null);
      setEditing(null);
      setDraft(dispatchDraftForAssignee(handoff.assignee));
      setDialogOpen(true);
    } else {
      setAssigneeHandoffWarning(handoff.reason === "not-approved"
        ? `Helpdesk assignee #${numericId} is not currently approved. Approve or restore staff access before configuring a new dispatch recipient.`
        : `Helpdesk assignee #${numericId} could not be found as an eligible assignee. It may be invalid, removed, or suspended.`);
    }
    clearAssigneeParam();
  }, [search, pathname, setLocation, dialogOpen, settings.data, settings.isLoading, settings.isFetching, eligibleAssignees.data, eligibleAssignees.isLoading, eligibleAssignees.isFetching, eligibleAssignees.isError]);
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim() || !draft.phone.trim()) {
      toast({ title: "Name and mobile number are required", variant: "destructive" });
      return;
    }
    if (!normalizeUsPhone(draft.phone)) {
      toast({ title: "Enter a valid U.S. mobile number", description: "Use a 10-digit number, with or without +1.", variant: "destructive" });
      return;
    }
    if (draft.canUseCommands && !draft.linkedUserId) {
      toast({ title: "Link a helpdesk assignee before enabling commands", description: "CLAIM uses this account to assign tickets.", variant: "destructive" });
      return;
    }
    if (!editing && !draft.linkedUserId) {
      toast({ title: "Select an approved helpdesk assignee", description: "Invite and approve the person in Staff Access first.", variant: "destructive" });
      return;
    }
    const data = { ...draft, name: draft.name.trim(), phone: normalizeUsPhone(draft.phone)! };
    const complete = () => {
      closeDialog();
      toast({ title: editing ? "Dispatch recipient updated" : "Dispatch recipient added" });
    };
    if (editing) update.mutate({ id: editing.id, data }, { onSuccess: complete, onError: (error: Error) => toast({ title: "Update failed", description: error.message, variant: "destructive" }) });
    else create.mutate(data, { onSuccess: complete, onError: (error: Error) => toast({ title: "Could not add recipient", description: error.message, variant: "destructive" }) });
  };
  const patch = (recipient: DispatchRecipient, data: Partial<DispatchRecipient>) => {
    update.mutate({ id: recipient.id, data }, { onError: (error: Error) => toast({ title: "Change failed", description: error.message, variant: "destructive" }) });
  };
  const destroy = (recipient: DispatchRecipient) => {
    if (!window.confirm(`Remove ${recipient.name} from staff dispatch?`)) return;
    remove.mutate(recipient.id, { onSuccess: () => toast({ title: "Recipient removed" }), onError: (error: Error) => toast({ title: "Removal failed", description: error.message, variant: "destructive" }) });
  };

  if (settings.isLoading) return <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-7"><div className="h-16 w-2/3 animate-pulse rounded-lg bg-stone-200" /><div className="h-52 animate-pulse rounded-xl bg-stone-200" /><div className="h-80 animate-pulse rounded-xl bg-stone-200" /></div>;
  if (settings.isError) return <div className="mx-auto max-w-2xl p-6"><div className="rounded-xl border border-red-200 bg-red-50 p-6"><h1 className="font-semibold text-red-950">Dispatch settings could not load</h1><p className="mt-1 text-sm text-red-800">Check your connection, then reload this control plane.</p><Button className="mt-4" onClick={() => settings.refetch()}>Try again</Button></div></div>;

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-7" data-testid="page-dispatch-settings">
      <header className="mb-7 border-l-4 border-csd-red pl-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.17em] text-csd-red"><Radio className="h-4 w-4" /> Operations control plane</div>
            <h1 className="text-3xl font-bold tracking-tight text-stone-950">Staff Dispatch</h1>
            <p className="mt-1 max-w-2xl text-sm text-stone-600">Decide who is available to take client calls, messages, and live dispatch commands.</p>
          </div>
           <Button onClick={openNew} className="gap-2 bg-csd-red shadow-sm hover:bg-red-800"><Plus className="h-4 w-4" /> Add dispatch recipient</Button>
        </div>
      </header>

      {assigneeHandoffWarning && (
        <div role="alert" className="mb-6 flex gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950" data-testid="warning-assignee-handoff">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
          <p>{assigneeHandoffWarning}</p>
        </div>
      )}

      <div className="mb-6 grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-stone-300 bg-stone-950 p-4 text-stone-100 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-red-300"><Phone className="h-4 w-4" /> Calls routing now</div>
          <p className="mt-3 text-lg font-semibold">{routeNames.calls.length ? routeNames.calls.join(" · ") : "No active call recipient"}</p>
          <p className="mt-1 text-xs text-stone-400">Only approved, enabled, on-duty staff with Calls selected are routed.</p>
        </div>
        <div className="rounded-xl border border-stone-300 bg-red-50 p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-red-800"><MessageSquare className="h-4 w-4" /> Messages routing now</div>
          <p className="mt-3 text-lg font-semibold text-stone-950">{routeNames.messages.length ? routeNames.messages.join(" · ") : "No active message recipient"}</p>
          <p className="mt-1 text-xs text-stone-600">Client communications always use the CSD number; staff mobile numbers are never exposed.</p>
        </div>
      </div>

      <section className="overflow-hidden rounded-xl border border-stone-300 bg-[hsl(28,29%,98%)] shadow-sm">
        <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3 md:px-5">
          <div><h2 className="flex items-center gap-2 font-bold text-stone-950"><UsersRound className="h-4 w-4 text-csd-red" /> Dispatch roster</h2><p className="mt-0.5 text-xs text-stone-500">{recipients.length} configured recipient{recipients.length === 1 ? "" : "s"}</p></div>
          <span className="hidden text-xs text-stone-500 md:block">Live permission changes are logged</span>
        </div>
        {recipients.length === 0 ? <div className="p-10 text-center"><Radio className="mx-auto h-7 w-7 text-red-300" /><h3 className="mt-3 font-semibold">No dispatch recipients yet</h3><p className="mt-1 text-sm text-stone-500">Add an on-call staff member before enabling client routing.</p><Button onClick={openNew} variant="outline" className="mt-4">Add first recipient</Button></div> : (
          <div className="divide-y divide-stone-200">
            {recipients.map((person) => <div key={person.id} className={`p-4 transition-opacity md:px-5 ${person.enabled ? "" : "opacity-55"}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><div className="flex items-center gap-2 font-semibold text-stone-950"><PresenceDot active={person.onDuty && person.enabled && person.staffAccessApproved === true} /> {person.name} <span className="rounded border border-stone-300 bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-stone-600">{person.role === "technician" ? "Technician" : "Staff"}</span> {!person.enabled && <span className="rounded border border-stone-300 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-stone-500">Paused</span>}</div><div className="ml-4 mt-1 font-mono text-xs text-stone-500">{person.phone}</div><div className={`ml-4 mt-2 flex items-center gap-1.5 text-xs font-medium ${person.linkedUserId ? "text-emerald-700" : "text-amber-700"}`}>{person.linkedUserId ? <><CheckCircle2 className="h-3.5 w-3.5" /> Linked helpdesk assignee</> : <>Not linked to a helpdesk assignee</>}</div>{person.staffAccessApproved !== true && <p className="ml-4 mt-1 text-xs font-medium text-amber-800">Routing and SMS commands paused until linked staff access is approved.</p>}</div>
                <div className="flex items-center gap-1"><Button variant="ghost" size="sm" onClick={() => openEdit(person)} className="gap-1.5 text-stone-600 hover:text-stone-950"><UserRoundPen className="h-4 w-4" /> Edit</Button><Button variant="ghost" size="icon" onClick={() => destroy(person)} aria-label={`Remove ${person.name}`} className="text-stone-400 hover:bg-red-50 hover:text-red-700"><Trash2 className="h-4 w-4" /></Button></div>
              </div>
              <div className="mt-4 grid gap-3 border-t border-stone-100 pt-3 sm:grid-cols-4">
                {recipientFlagItems(person).filter((item) => item.key !== "enabled").map((item) => <label key={item.key} className="flex cursor-pointer items-center justify-between gap-2 text-xs font-semibold text-stone-600"><span>{item.label.replace("Receive ", "")}</span><Switch checked={item.checked} disabled={!person.enabled || update.isPending || (item.key === "canUseCommands" && !person.linkedUserId)} onCheckedChange={(value) => patch(person, { [item.key]: value })} /></label>)}
              </div>
            </div>)}
          </div>
        )}
      </section>

      <section className="mt-6 rounded-xl border border-stone-300 bg-[hsl(28,29%,98%)] shadow-sm">
        <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3 md:px-5"><div><h2 className="flex items-center gap-2 font-bold text-stone-950"><ClipboardList className="h-4 w-4 text-csd-red" /> Dispatch audit</h2><p className="mt-0.5 text-xs text-stone-500">Recent permission and roster changes</p></div><Activity className="h-4 w-4 text-stone-400" /></div>
        {audit.isLoading ? <div className="space-y-3 p-5">{[1, 2, 3].map((item) => <div key={item} className="h-9 animate-pulse rounded bg-stone-100" />)}</div> : audit.isError ? <div className="p-5 text-sm text-stone-500">Audit history is temporarily unavailable.</div> : (audit.data?.length ?? 0) === 0 ? <div className="p-8 text-center text-sm text-stone-500">No dispatch changes have been recorded yet.</div> : <div className="divide-y divide-stone-100">{audit.data?.slice(0, 12).map((entry, index) => <div key={entry.id ?? index} className="flex items-start gap-3 px-4 py-3 md:px-5"><ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-csd-red" /><div className="min-w-0 flex-1"><p className="text-sm text-stone-800">{entry.message ?? entry.action ?? "Dispatch setting changed"}{entry.outcome ? ` · ${entry.outcome}` : ""}</p><p className="mt-0.5 text-xs text-stone-500">{entry.actorName ?? entry.actorIdentity ? `${entry.actorName ?? entry.actorIdentity} · ` : ""}{when(entry.createdAt ?? entry.timestamp)}</p></div></div>)}</div>}
      </section>

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!isPending) { if (open) setDialogOpen(true); else closeDialog(); } }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto border-stone-300 bg-[hsl(28,29%,98%)] sm:max-w-2xl">
          <form onSubmit={save}>
            <DialogHeader>
               <DialogTitle>{editing ? "Edit dispatch recipient" : "Add dispatch recipient"}</DialogTitle>
               <DialogDescription>First invite and approve this person in Staff Access, then create their helpdesk assignee there. This form configures phone routing; it does not create a login.</DialogDescription>
            </DialogHeader>

            <section className="mt-5 rounded-lg border border-stone-200 bg-white p-4">
              <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-stone-500">Identity</h3>
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <label className="text-sm font-medium">Full name <span className="text-csd-red">*</span>
                  <Input className="mt-1.5" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Team member name" autoComplete="name" required />
                </label>
                <label className="text-sm font-medium">Dispatch role
                  <select className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={draft.role} disabled={Boolean(draft.linkedUserId && eligibleAssignees.data?.find((item) => item.id === draft.linkedUserId)?.approvalStatus === "approved")} onChange={(event) => setDraft({ ...draft, role: event.target.value as RecipientDraft["role"] })}>
                    <option value="staff">Staff</option><option value="technician">Technician</option>
                  </select>
                </label>
                <label className="text-sm font-medium sm:col-span-2">Mobile number <span className="text-csd-red">*</span>
                  <Input className="mt-1.5 font-mono" type="tel" inputMode="tel" autoComplete="tel" value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} onBlur={() => normalizedPhone && setDraft((current) => ({ ...current, phone: normalizedPhone }))} placeholder="(954) 555-0123" required aria-invalid={Boolean(draft.phone && !normalizedPhone)} />
                  <span className={`mt-1 block text-xs ${draft.phone && !normalizedPhone ? "text-red-700" : "text-stone-500"}`}>{draft.phone && !normalizedPhone ? "Enter a valid 10-digit U.S. mobile number." : normalizedPhone ? `Will save as ${normalizedPhone}` : "Used only for private dispatch calls and messages."}</span>
                </label>
              </div>
            </section>

            <section className="mt-4 rounded-lg border border-stone-200 bg-white p-4">
              <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-stone-500">Availability & routing</h3>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {recipientFlagItems(draft).filter((item) => item.key !== "canUseCommands").map((item) => (
                  <label key={item.key} className={`flex items-center justify-between rounded-md border px-3 py-2.5 text-sm font-medium ${item.checked ? "border-stone-300 bg-stone-50 text-stone-900" : "border-stone-200 text-stone-500"}`}>
                    <span>{item.label}</span>
                    <Switch checked={item.checked} onCheckedChange={(value) => setDraft({ ...draft, [item.key]: value })} />
                  </label>
                ))}
              </div>
              <div className={`mt-3 flex gap-2 rounded-md px-3 py-2 text-xs ${receivesAnything ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"}`}>
                {receivesAnything ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
                {receivesAnything ? `${draft.name.trim() || "This recipient"} will be eligible for ${draft.receiveCalls && draft.receiveMessages ? "calls and messages" : draft.receiveCalls ? "calls" : "messages"} while on duty.` : "This recipient will not receive live dispatch until Active, On duty, and at least one routing channel are enabled."}
              </div>
            </section>

            <section className="mt-4 rounded-lg border border-stone-200 bg-white p-4">
              <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-stone-500">Helpdesk link & command permission</h3>
              <label className="mt-3 block text-sm font-medium">Linked helpdesk assignee <span className="text-xs font-normal text-stone-500">(required for commands)</span>
                <select className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" disabled={eligibleAssignees.isLoading || eligibleAssignees.isError} value={draft.linkedUserId ?? ""} onChange={(event) => { const linkedUserId = event.target.value ? Number(event.target.value) : null; const assignee = eligibleAssignees.data?.find((item) => item.id === linkedUserId); setDraft({ ...draft, linkedUserId, role: assignee?.approvalStatus === "approved" ? (assignee.staffRole === "field_technician" ? "technician" : "staff") : draft.role, canUseCommands: linkedUserId ? draft.canUseCommands : false }); }}>
                  <option value="">No linked assignee</option>
                  {eligibleAssignees.data?.filter((assignee) => assignee.approvalStatus === "approved" || assignee.id === draft.linkedUserId).map((assignee) => <option key={assignee.id} value={assignee.id} disabled={assignee.approvalStatus !== "approved" && assignee.id !== draft.linkedUserId}>{assignee.name || assignee.email || `Assignee #${assignee.id}`}{assignee.email ? ` · ${assignee.email}` : ""}{assignee.approvalStatus !== "approved" ? " · legacy link" : ""}</option>)}
                </select>
                {eligibleAssignees.isLoading ? <span className="mt-1 block text-xs text-stone-500">Loading eligible helpdesk assignees…</span> : eligibleAssignees.isError ? <span className="mt-1 block text-xs text-red-700">Eligible assignees could not be loaded. Try again before enabling commands.</span> : !(eligibleAssignees.data?.some((assignee) => assignee.approvalStatus === "approved")) ? <span className="mt-1 block text-xs text-amber-700">No approved assignee is ready. Approve the person and create their helpdesk assignee in Staff Access, then return here.</span> : <span className="mt-1 block text-xs text-stone-500">The CLAIM command assigns tickets to this exact helpdesk account. Only approved staff can be newly linked.</span>}
                <a href={`${import.meta.env.BASE_URL}staff-access`} className="mt-2 inline-block text-xs font-medium text-csd-red underline">Open Staff Access to invite or approve someone</a>
              </label>
              <label className={`mt-3 flex items-center justify-between rounded-md border px-3 py-3 ${draft.linkedUserId ? "border-stone-300 bg-stone-50" : "border-stone-200 bg-stone-50/60 text-stone-400"}`}>
                <span><span className="block text-sm font-semibold">Can use approved commands</span><span className="mt-0.5 block text-xs font-normal">Allows dispatch controls such as CLAIM; does not grant administrative access.</span></span>
                <Switch checked={draft.canUseCommands} disabled={!draft.linkedUserId} onCheckedChange={(canUseCommands) => setDraft({ ...draft, canUseCommands })} />
              </label>
              <div className="mt-3 flex gap-2 text-xs text-stone-500"><ShieldCheck className="h-4 w-4 shrink-0 text-csd-red" /> Command activity remains tied to the linked helpdesk identity and is auditable.</div>
            </section>

            <div className="mt-4 flex gap-2 rounded-md bg-stone-100 px-3 py-2 text-xs text-stone-600"><Info className="h-4 w-4 shrink-0" />Saving applies routing and permission changes immediately.</div>
            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" disabled={isPending} onClick={closeDialog}>Cancel</Button>
              <Button type="submit" disabled={isPending || !isDirty || !draft.name.trim() || !normalizedPhone}>{isPending ? "Saving…" : editing ? "Save changes" : `Add ${draft.role === "technician" ? "technician" : "staff member"}`}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}