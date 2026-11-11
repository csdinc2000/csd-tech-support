import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertCircle, BellRing, CheckCircle2, Clock, Lock, MessageSquareText, Save, Sparkles, Timer, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  errorMessage,
  minutesLabel,
  renderAutoTextPreview,
  WEEKDAYS,
  type SpeedToLeadData,
  type SpeedToLeadLead,
  type SpeedToLeadSettings,
} from "@/lib/sales-agents";

const QUERY_KEY = ["/api/crm/speed-to-lead"];

export function SpeedToLeadPanel({ isOwner }: { isOwner: boolean }) {
  const { toast } = useToast();
  const { data, isLoading, error } = useQuery<SpeedToLeadData>({ queryKey: QUERY_KEY, staleTime: 0, refetchInterval: 15_000 });

  // Re-render every 30 s so "waiting N min" stays live between refetches.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const markContacted = useMutation({
    mutationFn: async (leadId: number) => apiRequest("POST", `/api/crm/speed-to-lead/${leadId}/contacted`),
    onSuccess: () => {
      toast({ title: "First contact recorded" });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err) => toast({ title: "Could not record contact", description: errorMessage(err), variant: "destructive" }),
  });

  if (isLoading) return <p className="text-sm text-gray-500">Loading Speed to Lead…</p>;
  if (error || !data) return <p role="alert" className="text-sm text-red-700">{errorMessage(error)}</p>;

  const { settings, metrics, leads } = data;
  const waiting = leads.filter((l) => !l.firstContactAt);
  const contacted = leads.filter((l) => l.firstContactAt);

  return (
    <div className="space-y-4" data-testid="speed-to-lead-panel">
      {!settings.enabled && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" data-testid="stl-disabled">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          Speed to Lead is off. {isOwner ? "Switch it on in the settings below" : "An owner can switch it on"} to start the first-contact clock for new inbound leads.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Metric icon={Timer} label="Median first response" value={minutesLabel(metrics.medianMinutes)} testId="stl-metric-median" />
        <Metric icon={CheckCircle2} label={`Within ${settings.targetMinutes} min target`} value={metrics.withinTargetPct == null ? "—" : `${metrics.withinTargetPct}%`} testId="stl-metric-target" />
        <Metric icon={Clock} label="Waiting now" value={String(metrics.waiting)} tone={waiting.some((l) => l.overdue) ? "red" : undefined} testId="stl-metric-waiting" />
        <Metric icon={MessageSquareText} label="Instant texts sent" value={String(metrics.autoTextsSent)} testId="stl-metric-texts" />
        <Metric icon={BellRing} label="Escalations" value={String(metrics.escalations)} testId="stl-metric-escalations" />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Lead queue</CardTitle>
          <CardDescription>
            Leads waiting for a first human contact come first. Calls, texts, emails, appointments or a status change in the CRM stop the clock automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0 sm:p-6 sm:pt-0">
          {leads.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-gray-500 sm:px-0 sm:pb-0">No leads tracked in the last 30 days.</p>
          ) : (
            <table className="w-full min-w-[760px] text-sm" data-testid="stl-queue">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2 font-medium">Lead</th>
                  <th className="px-3 py-2 font-medium">Response</th>
                  <th className="px-3 py-2 font-medium">Instant text</th>
                  <th className="px-3 py-2 font-medium">First contact</th>
                  <th className="px-3 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {[...waiting, ...contacted].map((lead) => (
                  <QueueRow
                    key={lead.leadId}
                    lead={lead}
                    now={now}
                    busy={markContacted.isPending && markContacted.variables === lead.leadId}
                    onContacted={() => markContacted.mutate(lead.leadId)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <SettingsCard settings={settings} isOwner={isOwner} twilioConfigured={data.twilioConfigured} />
    </div>
  );
}

function Metric({ icon: Icon, label, value, tone, testId }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: string; tone?: "red"; testId: string;
}) {
  return (
    <div className={cn("rounded-lg border bg-white p-3", tone === "red" && "border-red-200 bg-red-50")} data-testid={testId}>
      <p className="flex items-center gap-1.5 text-xs text-gray-600"><Icon className="h-3.5 w-3.5" />{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums text-gray-900", tone === "red" && "text-red-700")}>{value}</p>
    </div>
  );
}

const TEXT_STATUS: Record<SpeedToLeadLead["autoTextStatus"], { label: string; className: string }> = {
  pending: { label: "Queued", className: "bg-amber-100 text-amber-800" },
  sending: { label: "Sending", className: "bg-amber-100 text-amber-800" },
  sent: { label: "Sent", className: "bg-green-100 text-green-800" },
  skipped: { label: "Not sent", className: "bg-gray-100 text-gray-700" },
  failed: { label: "Failed", className: "bg-red-100 text-red-800" },
};

function QueueRow({ lead, now, busy, onContacted }: { lead: SpeedToLeadLead; now: number; busy: boolean; onContacted: () => void }) {
  const waitingMinutes = lead.firstContactAt ? null : Math.max(0, Math.round((now - new Date(lead.leadCreatedAt).getTime()) / 60_000));
  const status = TEXT_STATUS[lead.autoTextStatus] ?? TEXT_STATUS.skipped;
  return (
    <tr
      className={cn("border-b last:border-0 align-top", lead.overdue && !lead.firstContactAt && "bg-red-50")}
      data-testid={`stl-lead-${lead.leadId}`}
      data-overdue={lead.overdue && !lead.firstContactAt ? "true" : "false"}
    >
      <td className="px-3 py-2.5">
        <p className="font-medium text-gray-900">{lead.name}</p>
        <p className="text-xs text-gray-500">
          {[lead.company, lead.serviceType, lead.source].filter(Boolean).join(" · ")}
        </p>
        {(lead.phone || lead.email) && (
          <p className="text-xs text-gray-600">
            {lead.phone && <a href={`tel:${lead.phone}`} className="hover:underline">{lead.phone}</a>}
            {lead.phone && lead.email && " · "}
            {lead.email}
          </p>
        )}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        {lead.firstContactAt ? (
          <span className="text-gray-800">{minutesLabel(lead.responseMinutes)}</span>
        ) : (
          <span className={cn("font-medium", lead.overdue ? "text-red-700" : "text-amber-700")} data-testid={`stl-waiting-${lead.leadId}`}>
            Waiting {minutesLabel(waitingMinutes)}
          </span>
        )}
        {lead.escalatedAt && <p className="text-xs text-red-700">Escalated</p>}
      </td>
      <td className="px-3 py-2.5">
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", status.className)}>{status.label}</span>
        {lead.autoTextDetail && <p className="mt-1 max-w-[220px] text-xs text-gray-500">{lead.autoTextDetail}</p>}
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-700">
        {lead.firstContactAt ? (
          <>
            <p>{lead.firstContactBy || "Staff"}</p>
            <p className="text-gray-500">{(lead.firstContactKind || "").replace(/_/g, " ")} · {new Date(lead.firstContactAt).toLocaleString()}</p>
          </>
        ) : "—"}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex justify-end gap-2">
          {!lead.firstContactAt && (
            <Button size="sm" variant="outline" onClick={onContacted} disabled={busy} data-testid={`stl-contacted-${lead.leadId}`}>
              Mark contacted
            </Button>
          )}
          <Button size="sm" variant="ghost" asChild>
            <Link href={`/sales/copilot?leadId=${lead.leadId}`} data-testid={`stl-research-${lead.leadId}`}>
              <Sparkles className="mr-1 h-3.5 w-3.5" />Research
            </Link>
          </Button>
        </div>
      </td>
    </tr>
  );
}

type SettingsForm = Omit<SpeedToLeadSettings, "enabledAt" | "updatedAt">;

function toForm(s: SpeedToLeadSettings): SettingsForm {
  const { enabledAt: _enabledAt, updatedAt: _updatedAt, ...rest } = s;
  return rest;
}

function SettingsCard({ settings, isOwner, twilioConfigured }: { settings: SpeedToLeadSettings; isOwner: boolean; twilioConfigured: boolean }) {
  const { toast } = useToast();
  const [form, setForm] = useState<SettingsForm>(() => toForm(settings));
  const [dirty, setDirty] = useState(false);
  // Follow server changes (15 s refresh) until the owner starts editing.
  useEffect(() => {
    if (!dirty) setForm(toForm(settings));
  }, [settings, dirty]);

  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: async () => (await apiRequest("PUT", "/api/crm/speed-to-lead/settings", {
      ...form,
      escalationPhones: form.escalationPhones.map((p) => p.trim()).filter(Boolean),
    })).json(),
    onSuccess: () => {
      setDirty(false);
      toast({ title: "Speed to Lead settings saved" });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err) => toast({ title: "Settings not saved", description: errorMessage(err), variant: "destructive" }),
  });

  const disabled = !isOwner;
  const preview = renderAutoTextPreview(form.autoTextTemplate);

  return (
    <Card data-testid="stl-settings">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Zap className="h-4 w-4 text-csd-red" />Automation settings
          {!isOwner && <Badge variant="outline" className="ml-1 gap-1 font-normal"><Lock className="h-3 w-3" />Owner only</Badge>}
        </CardTitle>
        <CardDescription>
          {isOwner ? "These settings decide whether customers get an automatic text, so only owners can change them." : "Only an owner can change these settings."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <ToggleRow id="stl-enabled" label="Speed to Lead is on" description="Start a first-contact clock for every new inbound lead (imported prospects are always excluded)." checked={form.enabled} disabled={disabled} onChange={(v) => set("enabled", v)} />

        <div className="space-y-3 rounded-lg border p-3">
          <ToggleRow id="stl-auto-text" label="Send an instant text" description="One acknowledgement text from the business line." checked={form.autoTextEnabled} disabled={disabled} onChange={(v) => set("autoTextEnabled", v)} />
          <p className="text-xs text-gray-600">
            Texts only go to customers who gave SMS consent on the intake form and have not replied STOP, and never between 9pm and 8am (texts wait until morning).
            {!twilioConfigured && <span className="text-red-700"> Twilio is not configured, so no texts can be sent yet.</span>}
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="stl-template">Message</Label>
            <Textarea id="stl-template" data-testid="stl-template" rows={3} maxLength={480} value={form.autoTextTemplate} disabled={disabled} onChange={(e) => set("autoTextTemplate", e.target.value)} />
            <p className="text-xs text-gray-500">Placeholders: {"{firstName}"}, {"{service}"}, {"{company}"}. Must include opt-out wording (e.g. “Reply STOP to opt out”). {form.autoTextTemplate.length}/480</p>
          </div>
          <div className="rounded-md bg-gray-50 p-2.5">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Preview</p>
            <p className="mt-1 text-sm text-gray-800" data-testid="stl-preview">{preview}</p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="stl-target">First-contact target (minutes)</Label>
            <Input id="stl-target" type="number" min={1} max={240} value={form.targetMinutes} disabled={disabled}
              onChange={(e) => set("targetMinutes", Math.min(240, Math.max(1, Number(e.target.value) || 1)))} />
          </div>
          <ToggleRow id="stl-slack" label="Escalate to Slack" description="Post in the team channel when a lead waits past the target." checked={form.escalateSlack} disabled={disabled} onChange={(v) => set("escalateSlack", v)} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="stl-phones">Escalation phones (staff cells, up to 5, comma separated)</Label>
          <Input id="stl-phones" placeholder="(954) 555-0100, (954) 555-0101" disabled={disabled}
            value={form.escalationPhones.join(", ")}
            onChange={(e) => set("escalationPhones", e.target.value.split(",").map((p) => p.trimStart()).slice(0, 5))} />
        </div>

        <div className="space-y-3 rounded-lg border p-3">
          <ToggleRow id="stl-hours" label="Escalate during business hours only" description="Overnight leads escalate when the business day starts." checked={form.businessHoursOnly} disabled={disabled} onChange={(v) => set("businessHoursOnly", v)} />
          {form.businessHoursOnly && (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="stl-start">Opens (hour)</Label>
                <Input id="stl-start" type="number" min={0} max={23} value={form.businessStartHour} disabled={disabled} onChange={(e) => set("businessStartHour", Math.min(23, Math.max(0, Number(e.target.value) || 0)))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="stl-end">Closes (hour)</Label>
                <Input id="stl-end" type="number" min={1} max={24} value={form.businessEndHour} disabled={disabled} onChange={(e) => set("businessEndHour", Math.min(24, Math.max(1, Number(e.target.value) || 1)))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="stl-tz">Time zone</Label>
                <Input id="stl-tz" value={form.timezone} disabled={disabled} onChange={(e) => set("timezone", e.target.value)} />
              </div>
              <div className="flex flex-wrap gap-1 sm:col-span-3" role="group" aria-label="Business days">
                {WEEKDAYS.map((day, index) => {
                  const on = form.businessDays.includes(index);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      disabled={disabled}
                      onClick={() => set("businessDays", on ? form.businessDays.filter((d) => d !== index) : [...form.businessDays, index].sort())}
                      className={cn("rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-60", on ? "border-gray-900 bg-gray-900 text-white" : "bg-white text-gray-700")}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {isOwner && (
          <div className="flex justify-end">
            <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending || form.businessDays.length === 0} data-testid="stl-save">
              <Save className="mr-1.5 h-4 w-4" />{save.isPending ? "Saving…" : "Save settings"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ToggleRow({ id, label, description, checked, disabled, onChange }: {
  id: string; label: string; description: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <Label htmlFor={id} className="text-sm font-medium">{label}</Label>
        <p className="text-xs text-gray-600">{description}</p>
      </div>
      <Switch id={id} data-testid={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}
