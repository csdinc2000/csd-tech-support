import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  TicketDepartment,
  TicketTeam,
  TicketHelpTopic,
  SlaPlan,
  CannedResponse,
  EmailTemplate,
  TicketFilter,
  TicketSettings,
} from "@shared/schema";
import { Plus, Trash2, Save } from "lucide-react";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";

function useEntity<T>(url: string) {
  const qc = useQueryClient();
  const query = useQuery<T[]>({ queryKey: [url] });
  const invalidate = () => qc.invalidateQueries({ queryKey: [url] });
  const create = useMutation({
    mutationFn: async (body: any) => (await apiRequest("POST", url, body)).json(),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: any }) =>
      (await apiRequest("PUT", `${url}/${id}`, body)).json(),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: async (id: number) => (await apiRequest("DELETE", `${url}/${id}`)).json(),
    onSuccess: invalidate,
  });
  return { ...query, create, update, remove };
}

function DepartmentsTab() {
  const { toast } = useToast();
  const ent = useEntity<TicketDepartment>("/api/helpdesk/departments");
  const [draft, setDraft] = useState({ name: "", email: "", autoresponderEnabled: true });
  return (
    <Card>
      <CardHeader><CardTitle>Departments</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 items-end">
          <div className="flex-1"><label className="text-xs text-gray-500">Name</label>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Support" />
          </div>
          <div className="flex-1"><label className="text-xs text-gray-500">Email</label>
            <Input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder="support@..." />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={draft.autoresponderEnabled}
              onCheckedChange={(v) => setDraft({ ...draft, autoresponderEnabled: v })} />
            Autoresponder
          </label>
          <Button
            onClick={() => {
              if (!draft.name) return;
              ent.create.mutate(draft, {
                onSuccess: () => { toast({ title: "Created" }); setDraft({ name: "", email: "", autoresponderEnabled: true }); },
              });
            }}
          >
            <Plus className="h-4 w-4 mr-1" /> Add
          </Button>
        </div>
        <div className="space-y-2">
          {(ent.data || []).map((d) => (
            <div key={d.id} className="border rounded p-3 flex items-center gap-3">
              <Input
                defaultValue={d.name}
                onBlur={(e) => e.target.value !== d.name && ent.update.mutate({ id: d.id, body: { name: e.target.value } })}
                className="flex-1"
              />
              <Input
                defaultValue={d.email || ""}
                onBlur={(e) => e.target.value !== d.email && ent.update.mutate({ id: d.id, body: { email: e.target.value } })}
                className="flex-1"
              />
              <label className="flex items-center gap-2 text-xs">
                Default
                <Switch
                  checked={!!d.isDefault}
                  onCheckedChange={(v) => ent.update.mutate({ id: d.id, body: { isDefault: v } })}
                />
              </label>
              <label className="flex items-center gap-2 text-xs">
                Auto-reply
                <Switch
                  checked={!!d.autoresponderEnabled}
                  onCheckedChange={(v) => ent.update.mutate({ id: d.id, body: { autoresponderEnabled: v } })}
                />
              </label>
              <Button variant="ghost" size="sm" onClick={() => ent.remove.mutate(d.id)}>
                <Trash2 className="h-4 w-4 text-red-500" />
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function TeamsTab() {
  const ent = useEntity<TicketTeam>("/api/helpdesk/teams");
  const { data: depts = [] } = useQuery<TicketDepartment[]>({ queryKey: ["/api/helpdesk/departments"] });
  const [draft, setDraft] = useState({ name: "", departmentId: undefined as number | undefined });
  return (
    <Card>
      <CardHeader><CardTitle>Teams</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2 items-end">
          <div className="flex-1"><label className="text-xs">Name</label>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Tier 1" />
          </div>
          <div className="flex-1"><label className="text-xs">Department</label>
            <Select onValueChange={(v) => setDraft({ ...draft, departmentId: parseInt(v) })}>
              <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                {depts.map((d) => <SelectItem key={d.id} value={d.id.toString()}>{d.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={() => draft.name && ent.create.mutate(draft, { onSuccess: () => setDraft({ name: "", departmentId: undefined }) })}>
            <Plus className="h-4 w-4 mr-1" /> Add
          </Button>
        </div>
        <div className="space-y-2">
          {(ent.data || []).map((t) => (
            <div key={t.id} className="border rounded p-3 flex items-center gap-3">
              <Input defaultValue={t.name} className="flex-1"
                onBlur={(e) => e.target.value !== t.name && ent.update.mutate({ id: t.id, body: { name: e.target.value } })}
              />
              <Select
                value={t.departmentId?.toString() || ""}
                onValueChange={(v) => ent.update.mutate({ id: t.id, body: { departmentId: parseInt(v) } })}
              >
                <SelectTrigger className="w-48"><SelectValue placeholder="No dept" /></SelectTrigger>
                <SelectContent>
                  {depts.map((d) => <SelectItem key={d.id} value={d.id.toString()}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="ghost" size="sm" onClick={() => ent.remove.mutate(t.id)}>
                <Trash2 className="h-4 w-4 text-red-500" />
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function HelpTopicsTab() {
  const ent = useEntity<TicketHelpTopic>("/api/helpdesk/help-topics");
  const { data: depts = [] } = useQuery<TicketDepartment[]>({ queryKey: ["/api/helpdesk/departments"] });
  const { data: slas = [] } = useQuery<SlaPlan[]>({ queryKey: ["/api/helpdesk/sla-plans"] });
  const { data: teams = [] } = useQuery<TicketTeam[]>({ queryKey: ["/api/helpdesk/teams"] });
  const [draft, setDraft] = useState({
    name: "", departmentId: undefined as any, slaPlanId: undefined as any,
    autoAssignTeamId: undefined as any, priority: "medium",
  });
  return (
    <Card>
      <CardHeader><CardTitle>Help Topics</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2 items-end">
          <Input placeholder="Topic name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <Select onValueChange={(v) => setDraft({ ...draft, departmentId: parseInt(v) })}>
            <SelectTrigger><SelectValue placeholder="Dept" /></SelectTrigger>
            <SelectContent>
              {depts.map((d) => <SelectItem key={d.id} value={d.id.toString()}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select onValueChange={(v) => setDraft({ ...draft, slaPlanId: parseInt(v) })}>
            <SelectTrigger><SelectValue placeholder="SLA" /></SelectTrigger>
            <SelectContent>
              {slas.map((s) => <SelectItem key={s.id} value={s.id.toString()}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select onValueChange={(v) => setDraft({ ...draft, autoAssignTeamId: parseInt(v) })}>
            <SelectTrigger><SelectValue placeholder="Auto team" /></SelectTrigger>
            <SelectContent>
              {teams.map((t) => <SelectItem key={t.id} value={t.id.toString()}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Select value={draft.priority} onValueChange={(v) => setDraft({ ...draft, priority: v })}>
              <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={() => draft.name && ent.create.mutate(draft, { onSuccess: () => setDraft({ name: "", departmentId: undefined, slaPlanId: undefined, autoAssignTeamId: undefined, priority: "medium" }) })}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          {(ent.data || []).map((t) => (
            <div key={t.id} className="border rounded p-3 flex items-center gap-3 text-sm">
              <div className="flex-1 font-medium">{t.name}</div>
              <div>{depts.find((d) => d.id === t.departmentId)?.name || "—"}</div>
              <div>{slas.find((s) => s.id === t.slaPlanId)?.name || "—"}</div>
              <div>{teams.find((tm) => tm.id === t.autoAssignTeamId)?.name || "—"}</div>
              <div>{t.priority}</div>
              <Button variant="ghost" size="sm" onClick={() => ent.remove.mutate(t.id)}>
                <Trash2 className="h-4 w-4 text-red-500" />
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function SlaPlansTab() {
  const ent = useEntity<SlaPlan>("/api/helpdesk/sla-plans");
  const [draft, setDraft] = useState({ name: "", responseTimeMinutes: 60, resolveTimeMinutes: 1440 });
  return (
    <Card>
      <CardHeader><CardTitle>SLA Plans</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2 items-end">
          <Input placeholder="Name" value={draft.name} className="flex-1" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <div>
            <label className="text-xs">Response (min)</label>
            <Input type="number" value={draft.responseTimeMinutes} onChange={(e) => setDraft({ ...draft, responseTimeMinutes: parseInt(e.target.value) || 0 })} className="w-24" />
          </div>
          <div>
            <label className="text-xs">Resolve (min)</label>
            <Input type="number" value={draft.resolveTimeMinutes} onChange={(e) => setDraft({ ...draft, resolveTimeMinutes: parseInt(e.target.value) || 0 })} className="w-32" />
          </div>
          <Button onClick={() => draft.name && ent.create.mutate(draft, { onSuccess: () => setDraft({ name: "", responseTimeMinutes: 60, resolveTimeMinutes: 1440 }) })}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-2">
          {(ent.data || []).map((p) => (
            <div key={p.id} className="border rounded p-3 flex items-center gap-3 text-sm">
              <div className="flex-1 font-medium">{p.name}</div>
              <div>Resp: {p.responseTimeMinutes}m</div>
              <div>Resolve: {p.resolveTimeMinutes}m</div>
              <label className="flex items-center gap-1 text-xs">
                Active <Switch checked={!!p.isActive} onCheckedChange={(v) => ent.update.mutate({ id: p.id, body: { isActive: v } })} />
              </label>
              <Button variant="ghost" size="sm" onClick={() => ent.remove.mutate(p.id)}>
                <Trash2 className="h-4 w-4 text-red-500" />
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function CannedResponsesTab() {
  const ent = useEntity<CannedResponse>("/api/helpdesk/canned-responses");
  const [draft, setDraft] = useState({ name: "", body: "" });
  return (
    <Card>
      <CardHeader><CardTitle>Canned Responses</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 items-start">
          <Input placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <Textarea placeholder="Body (supports {{ticket_number}}, {{requester_name}}, {{subject}}, {{priority}}, {{status}})"
            rows={3} className="md:col-span-2" value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
        </div>
        <Button onClick={() => draft.name && draft.body && ent.create.mutate(draft, { onSuccess: () => setDraft({ name: "", body: "" }) })}>
          <Plus className="h-4 w-4 mr-1" /> Add
        </Button>
        <div className="space-y-2">
          {(ent.data || []).map((c) => (
            <div key={c.id} className="border rounded p-3 space-y-2">
              <div className="flex justify-between items-center">
                <Input defaultValue={c.name} className="flex-1"
                  onBlur={(e) => e.target.value !== c.name && ent.update.mutate({ id: c.id, body: { name: e.target.value } })} />
                <Button variant="ghost" size="sm" onClick={() => ent.remove.mutate(c.id)}>
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              </div>
              <Textarea
                defaultValue={c.body}
                rows={3}
                onBlur={(e) => e.target.value !== c.body && ent.update.mutate({ id: c.id, body: { body: e.target.value } })}
              />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function EmailTemplatesTab() {
  const ent = useEntity<EmailTemplate>("/api/helpdesk/email-templates");
  return (
    <Card>
      <CardHeader><CardTitle>Email Templates</CardTitle></CardHeader>
      <CardContent>
        <p className="text-xs text-gray-600 mb-3">
          Templates are referenced by <code>code</code>. Built-ins:
          <code className="ml-1">ticket.autoreply</code>,
          <code className="ml-1">ticket.new_reply</code>,
          <code className="ml-1">ticket.assigned</code>,
          <code className="ml-1">ticket.overdue</code>,
          <code className="ml-1">ticket.resolved</code>,
          <code className="ml-1">ticket.staff_new</code>. Variables:
          <code className="ml-1">{"{{ticket_number}} {{subject}} {{description}} {{requester_name}} {{priority}} {{status}} {{portal_url}} {{department_name}} {{assignee_name}} {{message_body}} {{response_time}} {{sla_due_at}}"}</code>
        </p>
        <div className="space-y-3">
          {(ent.data || []).map((t) => (
            <div key={t.id} className="border rounded p-3 space-y-2">
              <div className="flex gap-2 items-center">
                <span className="font-mono text-xs bg-gray-100 px-2 py-1 rounded">{t.code}</span>
                <Input
                  defaultValue={t.name}
                  className="flex-1"
                  onBlur={(e) => e.target.value !== t.name && ent.update.mutate({ id: t.id, body: { name: e.target.value } })}
                />
                <label className="flex items-center gap-1 text-xs">
                  Active <Switch checked={!!t.isActive}
                    onCheckedChange={(v) => ent.update.mutate({ id: t.id, body: { isActive: v } })} />
                </label>
                <Button variant="ghost" size="sm" onClick={() => ent.remove.mutate(t.id)}>
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              </div>
              <Input
                defaultValue={t.subject}
                placeholder="Subject"
                onBlur={(e) => e.target.value !== t.subject && ent.update.mutate({ id: t.id, body: { subject: e.target.value } })}
              />
              <Textarea
                defaultValue={t.body}
                rows={6}
                onBlur={(e) => e.target.value !== t.body && ent.update.mutate({ id: t.id, body: { body: e.target.value } })}
              />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function FiltersTab() {
  const ent = useEntity<TicketFilter>("/api/helpdesk/filters");
  const [draft, setDraft] = useState({
    name: "",
    matchType: "all",
    priority: 100,
    conditions: '[{"field":"subject","op":"contains","value":""}]',
    actions: '{"setPriority":"high"}',
  });
  return (
    <Card>
      <CardHeader><CardTitle>Ticket Filters</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-gray-600">
          Routing rules applied to incoming tickets. Conditions field options:
          <code className="ml-1">subject, description, requesterEmail, priority, source, helpTopicId, departmentId</code>.
          Ops: <code>equals, not_equals, contains, starts_with, ends_with, is_empty, is_not_empty</code>.
          Actions: <code className="ml-1">assignToUserId, assignToTeamId, setPriority, setDepartmentId, setHelpTopicId, setStatus, stopProcessing</code>.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
          <Input placeholder="Filter name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <Select value={draft.matchType} onValueChange={(v) => setDraft({ ...draft, matchType: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Match ALL</SelectItem>
              <SelectItem value="any">Match ANY</SelectItem>
            </SelectContent>
          </Select>
          <Input type="number" placeholder="Priority" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: parseInt(e.target.value) || 0 })} />
          <Input placeholder='Conditions JSON' value={draft.conditions} onChange={(e) => setDraft({ ...draft, conditions: e.target.value })} />
          <div className="flex gap-2">
            <Input placeholder="Actions JSON" value={draft.actions} onChange={(e) => setDraft({ ...draft, actions: e.target.value })} />
            <Button onClick={() => {
              try {
                const body = { ...draft, conditions: JSON.parse(draft.conditions), actions: JSON.parse(draft.actions) };
                ent.create.mutate(body, { onSuccess: () => setDraft({ name: "", matchType: "all", priority: 100, conditions: '[]', actions: '{}' }) });
              } catch { /* ignore */ }
            }}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          {(ent.data || []).map((f) => (
            <div key={f.id} className="border rounded p-3 text-sm space-y-2">
              <div className="flex items-center gap-2">
                <Input defaultValue={f.name} className="flex-1"
                  onBlur={(e) => e.target.value !== f.name && ent.update.mutate({ id: f.id, body: { name: e.target.value } })} />
                <Select value={f.matchType} onValueChange={(v) => ent.update.mutate({ id: f.id, body: { matchType: v } })}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">ALL</SelectItem>
                    <SelectItem value="any">ANY</SelectItem>
                  </SelectContent>
                </Select>
                <Input type="number" defaultValue={f.priority || 100} className="w-20"
                  onBlur={(e) => parseInt(e.target.value) !== f.priority && ent.update.mutate({ id: f.id, body: { priority: parseInt(e.target.value) || 0 } })} />
                <label className="flex items-center gap-1 text-xs">
                  Active <Switch checked={!!f.isActive}
                    onCheckedChange={(v) => ent.update.mutate({ id: f.id, body: { isActive: v } })} />
                </label>
                <Button variant="ghost" size="sm" onClick={() => ent.remove.mutate(f.id)}>
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              </div>
              <Textarea
                rows={2}
                defaultValue={JSON.stringify(f.conditions)}
                onBlur={(e) => { try { ent.update.mutate({ id: f.id, body: { conditions: JSON.parse(e.target.value) } }); } catch {} }}
              />
              <Textarea
                rows={2}
                defaultValue={JSON.stringify(f.actions)}
                onBlur={(e) => { try { ent.update.mutate({ id: f.id, body: { actions: JSON.parse(e.target.value) } }); } catch {} }}
              />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

const unsavedHelpdeskMessage = "You have unsaved helpdesk settings changes. Leave this page and discard them?";

function SettingsTab({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: settings } = useQuery<TicketSettings | null>({ queryKey: ["/api/helpdesk/settings"] });
  const update = useMutation({
    mutationFn: async (body: Partial<TicketSettings>) => (await apiRequest("PUT", "/api/helpdesk/settings", body)).json(),
    onSuccess: () => {
      setLocal({});
      qc.invalidateQueries({ queryKey: ["/api/helpdesk/settings"] });
      toast({ title: "Saved" });
    },
  });
  const [local, setLocal] = useState<Partial<TicketSettings>>({});
  const dirty = Object.entries(local).some(([key, value]) =>
    value !== settings?.[key as keyof TicketSettings]);
  useUnsavedChangesGuard(dirty, unsavedHelpdeskMessage);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  const merged = { ...settings, ...local } as TicketSettings;
  return (
    <Card>
      <CardHeader><CardTitle>Global Settings</CardTitle></CardHeader>
      <CardContent className="space-y-3 max-w-2xl">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex items-center justify-between text-sm">Autoresponder enabled
            <Switch checked={!!merged.autoresponderEnabled}
              onCheckedChange={(v) => setLocal({ ...local, autoresponderEnabled: v })} />
          </label>
          <label className="flex items-center justify-between text-sm">Overdue alerts
            <Switch checked={!!merged.overdueAlertEnabled}
              onCheckedChange={(v) => setLocal({ ...local, overdueAlertEnabled: v })} />
          </label>
          <label className="flex items-center justify-between text-sm">Customer portal
            <Switch checked={!!merged.portalEnabled}
              onCheckedChange={(v) => setLocal({ ...local, portalEnabled: v })} />
          </label>
          <div>
            <label className="text-xs text-gray-500">Ticket # prefix</label>
            <Input value={merged.ticketNumberPrefix || ""} onChange={(e) => setLocal({ ...local, ticketNumberPrefix: e.target.value })} />
          </div>
          <div>
            <label className="text-xs text-gray-500">Lock expiry (minutes)</label>
            <Input type="number" value={merged.lockExpiryMinutes || 0}
              onChange={(e) => setLocal({ ...local, lockExpiryMinutes: parseInt(e.target.value) || 0 })} />
          </div>
          <div>
            <label className="text-xs text-gray-500">Max attachment bytes</label>
            <Input type="number" value={merged.maxAttachmentBytes || 0}
              onChange={(e) => setLocal({ ...local, maxAttachmentBytes: parseInt(e.target.value) || 0 })} />
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-500">Allowed MIME types (comma-separated)</label>
          <Input value={merged.allowedMimeTypes || ""}
            onChange={(e) => setLocal({ ...local, allowedMimeTypes: e.target.value })} />
        </div>
        <Button disabled={!dirty || update.isPending} onClick={() => update.mutate(local)}>
          <Save className="h-4 w-4 mr-1" /> Save
        </Button>
        {dirty && <Button variant="outline" disabled={update.isPending} onClick={() => setLocal({})} data-testid="button-discard-helpdesk-settings">Discard changes</Button>}
      </CardContent>
    </Card>
  );
}

function ReportsTab() {
  const { data, refetch } = useQuery<any>({ queryKey: ["/api/helpdesk/reports/summary"] });
  const checkOverdue = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/helpdesk/sla/check-overdue", {})).json(),
    onSuccess: () => refetch(),
  });
  if (!data) return <div className="text-sm text-gray-500">Loading…</div>;
  const Block = ({ title, obj }: { title: string; obj: Record<string, number> }) => (
    <Card>
      <CardHeader><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent>
        <ul className="text-sm space-y-1">
          {Object.entries(obj).map(([k, v]) => (
            <li key={k} className="flex justify-between border-b py-1">
              <span>{k}</span><span className="font-mono">{v}</span>
            </li>
          ))}
          {Object.keys(obj).length === 0 && <li className="text-gray-500">—</li>}
        </ul>
      </CardContent>
    </Card>
  );
  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-center">
        <Card className="flex-1"><CardContent className="p-4">
          <div className="text-xs text-gray-500">Total</div>
          <div className="text-2xl font-bold">{data.total}</div>
        </CardContent></Card>
        <Card className="flex-1"><CardContent className="p-4">
          <div className="text-xs text-gray-500">Open</div>
          <div className="text-2xl font-bold text-blue-600">{data.open}</div>
        </CardContent></Card>
        <Card className="flex-1"><CardContent className="p-4">
          <div className="text-xs text-gray-500">Overdue</div>
          <div className="text-2xl font-bold text-red-600">{data.overdue}</div>
        </CardContent></Card>
        <Button onClick={() => checkOverdue.mutate()} disabled={checkOverdue.isPending}>
          Send overdue alerts now
        </Button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Block title="By Status" obj={data.byStatus} />
        <Block title="By Department" obj={data.byDepartment} />
        <Block title="By Help Topic" obj={data.byTopic} />
        <Block title="By Priority" obj={data.byPriority} />
        <Block title="By Assignee" obj={data.byAssignee} />
      </div>
    </div>
  );
}

export default function HelpdeskAdmin() {
  const [tab, setTab] = useState("departments");
  const [settingsDirty, setSettingsDirty] = useState(false);
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Helpdesk Admin</h1>
      <Tabs value={tab} onValueChange={(next) => {
        if (tab === "settings" && settingsDirty && !window.confirm(unsavedHelpdeskMessage)) return;
        setTab(next);
      }}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="departments">Departments</TabsTrigger>
          <TabsTrigger value="teams">Teams</TabsTrigger>
          <TabsTrigger value="topics">Help Topics</TabsTrigger>
          <TabsTrigger value="sla">SLA Plans</TabsTrigger>
          <TabsTrigger value="canned">Canned Responses</TabsTrigger>
          <TabsTrigger value="templates">Email Templates</TabsTrigger>
          <TabsTrigger value="filters">Filters</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
        </TabsList>
        <TabsContent value="departments"><DepartmentsTab /></TabsContent>
        <TabsContent value="teams"><TeamsTab /></TabsContent>
        <TabsContent value="topics"><HelpTopicsTab /></TabsContent>
        <TabsContent value="sla"><SlaPlansTab /></TabsContent>
        <TabsContent value="canned"><CannedResponsesTab /></TabsContent>
        <TabsContent value="templates"><EmailTemplatesTab /></TabsContent>
        <TabsContent value="filters"><FiltersTab /></TabsContent>
        <TabsContent value="settings"><SettingsTab onDirtyChange={setSettingsDirty} /></TabsContent>
        <TabsContent value="reports"><ReportsTab /></TabsContent>
      </Tabs>
    </div>
  );
}
