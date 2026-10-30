import { FormEvent, useMemo, useState } from "react";
import { Activity, CheckCircle2, ChevronRight, ClipboardList, MessageSquare, Phone, Plus, Radio, ShieldCheck, Trash2, UserRoundPen, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { DispatchRecipient, useStaffDispatch } from "@/hooks/use-staff-dispatch";

type RecipientDraft = Omit<DispatchRecipient, "id" | "updatedAt">;
type RecipientFlag = "enabled" | "onDuty" | "receiveCalls" | "receiveMessages" | "canUseCommands";
type FlagItem = { label: string; checked: boolean; key: RecipientFlag };

const blankRecipient: RecipientDraft = {
  name: "",
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

const when = (value?: string) => {
  if (!value) return "Recently";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Recently" : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

function PresenceDot({ active }: { active: boolean }) {
  return <span aria-label={active ? "On duty" : "Off duty"} className={`inline-block h-2 w-2 rounded-full ${active ? "bg-emerald-600" : "bg-stone-300"}`} />;
}

export default function DispatchSettingsPage() {
  const { toast } = useToast();
  const { settings, audit, eligibleAssignees, create, update, remove } = useStaffDispatch();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DispatchRecipient | null>(null);
  const [draft, setDraft] = useState<RecipientDraft>(blankRecipient);

  const recipients = settings.data?.recipients ?? [];
  const routeNames = useMemo(() => {
    const pick = (ids: number[]) => recipients.filter((person) => ids.includes(person.id)).map((person) => person.name);
    return {
      calls: pick(settings.data?.routing.activeCallRecipients ?? []),
      messages: pick(settings.data?.routing.activeMessageRecipients ?? []),
    };
  }, [recipients, settings.data?.routing.activeCallRecipients, settings.data?.routing.activeMessageRecipients]);

  const openNew = () => {
    setEditing(null);
    setDraft(blankRecipient);
    setDialogOpen(true);
  };
  const openEdit = (recipient: DispatchRecipient) => {
    setEditing(recipient);
    setDraft({ name: recipient.name, phone: recipient.phone, enabled: recipient.enabled, onDuty: recipient.onDuty, receiveCalls: recipient.receiveCalls, receiveMessages: recipient.receiveMessages, canUseCommands: recipient.canUseCommands, linkedUserId: recipient.linkedUserId ?? null });
    setDialogOpen(true);
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim() || !draft.phone.trim()) {
      toast({ title: "Name and mobile number are required", variant: "destructive" });
      return;
    }
    if (draft.canUseCommands && !draft.linkedUserId) {
      toast({ title: "Link a helpdesk assignee before enabling commands", description: "CLAIM uses this account to assign tickets.", variant: "destructive" });
      return;
    }
    const data = { ...draft, name: draft.name.trim(), phone: draft.phone.trim() };
    const complete = () => {
      setDialogOpen(false);
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
          <Button onClick={openNew} className="gap-2 bg-csd-red shadow-sm hover:bg-red-800"><Plus className="h-4 w-4" /> Add staff recipient</Button>
        </div>
      </header>

      <div className="mb-6 grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-stone-300 bg-stone-950 p-4 text-stone-100 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-red-300"><Phone className="h-4 w-4" /> Calls routing now</div>
          <p className="mt-3 text-lg font-semibold">{routeNames.calls.length ? routeNames.calls.join(" · ") : "No active call recipient"}</p>
          <p className="mt-1 text-xs text-stone-400">Only enabled, on-duty staff with Calls selected are routed.</p>
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
                <div><div className="flex items-center gap-2 font-semibold text-stone-950"><PresenceDot active={person.onDuty && person.enabled} /> {person.name} {!person.enabled && <span className="rounded border border-stone-300 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-stone-500">Paused</span>}</div><div className="ml-4 mt-1 font-mono text-xs text-stone-500">{person.phone}</div><div className={`ml-4 mt-2 flex items-center gap-1.5 text-xs font-medium ${person.linkedUserId ? "text-emerald-700" : "text-amber-700"}`}>{person.linkedUserId ? <><CheckCircle2 className="h-3.5 w-3.5" /> Linked helpdesk assignee</> : <>Not linked to a helpdesk assignee</>}</div></div>
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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}><DialogContent className="border-stone-300 bg-[hsl(28,29%,98%)] sm:max-w-xl"><form onSubmit={save}><DialogHeader><DialogTitle>{editing ? "Edit dispatch recipient" : "Add dispatch recipient"}</DialogTitle><DialogDescription>Recipients are contacted privately; clients continue to see the CSD number.</DialogDescription></DialogHeader><div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium">Full name<Input className="mt-1.5" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Staff member name" /></label><label className="text-sm font-medium">Mobile number<Input className="mt-1.5" value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} placeholder="(954) 555-0123" /></label></div><label className="mt-4 block text-sm font-medium">Linked helpdesk assignee<span className="ml-1 text-xs font-normal text-stone-500">(required for commands)</span><select className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={draft.linkedUserId ?? ""} onChange={(event) => setDraft({ ...draft, linkedUserId: event.target.value ? Number(event.target.value) : null })}><option value="">Select an assignee</option>{eligibleAssignees.data?.map((assignee) => <option key={assignee.id} value={assignee.id}>{assignee.name}{assignee.email ? ` · ${assignee.email}` : ""}</option>)}</select>{eligibleAssignees.isLoading ? <span className="mt-1 block text-xs text-stone-500">Loading eligible helpdesk assignees…</span> : eligibleAssignees.isError ? <span className="mt-1 block text-xs text-red-700">Eligible assignees could not be loaded. Try again before enabling commands.</span> : <span className="mt-1 block text-xs text-stone-500">CLAIM assigns tickets to this linked helpdesk account.</span>}</label><div className="mt-5 grid gap-3 rounded-lg bg-stone-100 p-3 sm:grid-cols-2">{recipientFlagItems(draft).map((item) => <label key={item.key} className="flex items-center justify-between text-sm font-medium text-stone-700"><span>{item.label}</span><Switch checked={item.checked} disabled={item.key === "canUseCommands" && !draft.linkedUserId} onCheckedChange={(value) => setDraft({ ...draft, [item.key]: value })} /></label>)}</div><div className="mt-3 flex gap-2 text-xs text-stone-500"><ShieldCheck className="h-4 w-4 shrink-0 text-csd-red" /> Commands allow staff to use approved dispatch controls; they do not grant administrative access.</div><DialogFooter className="mt-6"><Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button><Button type="submit" disabled={create.isPending || update.isPending}>{editing ? "Save changes" : "Add recipient"}</Button></DialogFooter></form></DialogContent></Dialog>
    </div>
  );
}