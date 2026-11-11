import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Loader2, Phone, MessageSquare, Voicemail as VoicemailIcon, Save, RefreshCw, Play, Trash2, History, PhoneIncoming, PhoneMissed, Calendar as CalendarIcon, CheckCircle2, AlertCircle } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import type { TwilioSettings, Voicemail, CallLog } from "@shared/schema";
import ComplianceNotice from "@/components/compliance-notice";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import { formatUsPhone } from "@/lib/format";

const VOICE_OPTIONS = [
  // Natural-sounding neural voices (recommended) — much smoother and more human.
  { value: "Polly.Joanna-Neural", label: "Joanna — Natural (US Female) ★" },
  { value: "Polly.Danielle-Neural", label: "Danielle — Natural (US Female)" },
  { value: "Polly.Ruth-Neural", label: "Ruth — Natural (US Female)" },
  { value: "Polly.Kendra-Neural", label: "Kendra — Natural (US Female)" },
  { value: "Polly.Kimberly-Neural", label: "Kimberly — Natural (US Female)" },
  { value: "Polly.Salli-Neural", label: "Salli — Natural (US Female)" },
  { value: "Polly.Matthew-Neural", label: "Matthew — Natural (US Male)" },
  { value: "Polly.Stephen-Neural", label: "Stephen — Natural (US Male)" },
  // Older standard voices (more robotic) — kept for compatibility.
  { value: "Polly.Joanna", label: "Joanna (Standard, US Female)" },
  { value: "Polly.Salli", label: "Salli (Standard, US Female)" },
  { value: "Polly.Kendra", label: "Kendra (Standard, US Female)" },
  { value: "Polly.Ivy", label: "Ivy (Standard, US Female, younger)" },
  { value: "Polly.Kimberly", label: "Kimberly (Standard, US Female)" },
  { value: "Polly.Matthew", label: "Matthew (Standard, US Male)" },
  { value: "Polly.Joey", label: "Joey (Standard, US Male)" },
];

type PhoneSettingsPageProps = {
  defaultTab?: string;
  embedded?: boolean;
  visibleTabs?: string[];
};

export default function PhoneSettingsPage({
  defaultTab = "calllog",
  embedded = false,
  visibleTabs,
}: PhoneSettingsPageProps) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: settings, isLoading } = useQuery<TwilioSettings>({ queryKey: ["/api/twilio/settings"] });
  const [draft, setDraft] = useState<Partial<TwilioSettings>>({});
  const [baseline, setBaseline] = useState<TwilioSettings | null>(null);
  const dirty = baseline !== null && Object.keys(draft).some((key) =>
    JSON.stringify(draft[key as keyof TwilioSettings]) !== JSON.stringify(baseline[key as keyof TwilioSettings]));
  useUnsavedChangesGuard(dirty, "You have unsaved phone settings changes. Leave this page and discard them?");

  const set = <K extends keyof TwilioSettings>(k: K, v: TwilioSettings[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const save = useMutation({
    mutationFn: async (patch: Partial<TwilioSettings>) =>
      apiRequest("PATCH", "/api/twilio/settings", patch),
    onSuccess: async (_result, patch) => {
      setBaseline((current) => current ? { ...current, ...patch } : null);
      await qc.invalidateQueries({ queryKey: ["/api/twilio/settings"] });
      toast({ title: "Settings saved" });
    },
    onError: (e: any) => toast({ title: "Save failed", description: e?.message, variant: "destructive" }),
  });
  useEffect(() => {
    if (settings && !dirty && !save.isPending) {
      setBaseline(settings);
      setDraft(settings);
    }
  }, [settings, dirty, save.isPending]);

  const syncHooks = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/twilio/sync-webhooks", {}),
    onSuccess: () => toast({ title: "Webhooks synced", description: "Main line and all call-tracking numbers now point at this app." }),
    onError: (e: any) => toast({ title: "Sync failed", description: e?.message, variant: "destructive" }),
  });

  if (isLoading || !settings) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  const onSave = () => save.mutate(draft);
  const smsForwardTargets = (
    draft.smsForwardNumbers == null
      ? [draft.smsForwardToNumber || ""]
      : draft.smsForwardNumbers.split(",")
  );
  const setSmsForwardTargets = (targets: string[]) =>
    set("smsForwardNumbers", targets.slice(0, 5).join(","));
  const showTab = (tab: string) => !visibleTabs || visibleTabs.includes(tab);
  const showTabNavigation = !visibleTabs || visibleTabs.length > 1;

  return (
    <div className={`${embedded ? "space-y-6" : "p-6 max-w-5xl mx-auto space-y-6"}`} data-testid="page-phone-settings">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          {!embedded && <h1 className="text-3xl font-bold">Phone & SMS Settings</h1>}
          <p className="text-muted-foreground">Call forwarding, voicemail, and SMS auto-replies for your <b>main business line</b>. Per-number call flows and auto-replies live under <b>Call Tracking</b>; all texts appear in <b>Messages</b>.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => syncHooks.mutate()} disabled={syncHooks.isPending} data-testid="button-sync-webhooks">
            {syncHooks.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Sync all numbers
          </Button>
          <Button onClick={onSave} disabled={save.isPending} data-testid="button-save-settings">
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
            Save Changes
          </Button>
          {dirty && <Button variant="outline" disabled={save.isPending} onClick={() => setDraft(baseline!)} data-testid="button-discard-phone-settings">Discard changes</Button>}
        </div>
      </div>

      <ComplianceNotice title="Call Recording & Consent">
        Calls may be recorded or monitored for quality assurance, training, security, and service
        documentation where permitted and with required consent. Florida requires all-party
        consent — notify callers before recording.
      </ComplianceNotice>

      <Tabs defaultValue={defaultTab} className="w-full">
        {showTabNavigation && (
          <TabsList className="flex h-auto w-full justify-start gap-1 overflow-x-auto rounded-lg p-1">
            {showTab("calllog") && <TabsTrigger value="calllog" className="shrink-0"><History className="h-4 w-4 mr-1" />Call Log</TabsTrigger>}
            {showTab("numbers") && <TabsTrigger value="numbers" className="shrink-0"><Phone className="h-4 w-4 mr-1" />Phone Numbers</TabsTrigger>}
            {showTab("callflow") && <TabsTrigger value="callflow" className="shrink-0">Call Flow</TabsTrigger>}
            {showTab("voicemail") && <TabsTrigger value="voicemail" className="shrink-0"><VoicemailIcon className="h-4 w-4 mr-1" />Greeting &amp; Recording</TabsTrigger>}
            {showTab("sms") && <TabsTrigger value="sms" className="shrink-0"><MessageSquare className="h-4 w-4 mr-1" />SMS Automation</TabsTrigger>}
            {showTab("messages") && <TabsTrigger value="messages" className="shrink-0">Voicemails</TabsTrigger>}
            {showTab("calendar") && <TabsTrigger value="calendar" className="shrink-0"><CalendarIcon className="h-4 w-4 mr-1" />Calendar</TabsTrigger>}
          </TabsList>
        )}

        {showTab("calendar") && <TabsContent value="calendar">
          <CalendarPanel
            currentId={draft.schedulingCalendarId || ""}
            blockBusy={!!draft.schedulingCalendarBlockBusy}
            pushEvents={!!draft.schedulingCalendarPushEvents}
            onChange={(p) => {
              if ("schedulingCalendarId" in p) set("schedulingCalendarId", p.schedulingCalendarId as any);
              if ("schedulingCalendarBlockBusy" in p) set("schedulingCalendarBlockBusy", p.schedulingCalendarBlockBusy as any);
              if ("schedulingCalendarPushEvents" in p) set("schedulingCalendarPushEvents", p.schedulingCalendarPushEvents as any);
            }}
            onSave={() => save.mutate({
              schedulingCalendarId: draft.schedulingCalendarId,
              schedulingCalendarBlockBusy: draft.schedulingCalendarBlockBusy,
              schedulingCalendarPushEvents: draft.schedulingCalendarPushEvents,
            })}
            saving={save.isPending}
          />
        </TabsContent>}

        {showTab("calllog") && <TabsContent value="calllog">
          <CallLogPanel />
        </TabsContent>}

        {/* ── PHONE NUMBERS ─────────────────────────────────────────────── */}
        {showTab("numbers") && <TabsContent value="numbers">
          <Card>
            <CardHeader>
              <CardTitle>Phone Numbers</CardTitle>
              <CardDescription>The Twilio number callers reach, and where calls/texts/voicemails go.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="Twilio Phone Number (your business line)">
                <Input value={draft.twilioPhoneNumber || ""} onChange={(e) => set("twilioPhoneNumber", e.target.value)} placeholder="+19546377300" data-testid="input-twilio-number" />
              </Field>
              <Field label="Forward Calls To" hint="Your main business line rings here first, then backup 1 and backup 2 before voicemail. Press 1 to accept; mobile voicemail won't stop the backups.">
                <Input value={draft.forwardToNumber || ""} onChange={(e) => set("forwardToNumber", e.target.value)} placeholder="+19542533135" data-testid="input-forward-number" />
              </Field>
              <Field label="Backup Forward Number (optional)" hint="If the primary number doesn't answer, the call rings this number next before voicemail. Leave blank to skip.">
                <Input value={draft.backupForwardNumber || ""} onChange={(e) => set("backupForwardNumber", e.target.value)} placeholder="+1XXXXXXXXXX" data-testid="input-backup-forward-number" />
              </Field>
              <Field label="Backup Forward Number 2 (optional)" hint="If the primary and first backup don't answer, the call rings this final number before voicemail. Leave blank to skip.">
                <Input value={draft.backupForwardNumber2 || ""} onChange={(e) => set("backupForwardNumber2", e.target.value)} placeholder="+1XXXXXXXXXX" data-testid="input-backup-forward-number-2" />
              </Field>
              <Field label="Forward Texts To" hint="Inbound SMS to your business line is mirrored here.">
                <Input value={draft.smsForwardToNumber || ""} onChange={(e) => set("smsForwardToNumber", e.target.value)} placeholder="+19542533135" data-testid="input-sms-forward-number" />
              </Field>
              <Field label="Voicemail Notification Number" hint="Where voicemail alerts and transcripts are texted.">
                <Input value={draft.voicemailNotifyNumber || ""} onChange={(e) => set("voicemailNotifyNumber", e.target.value)} placeholder="+19542533135" data-testid="input-vm-notify-number" />
              </Field>
              <Separator />
              <p className="text-sm text-muted-foreground">
                After changing the Twilio Phone Number, click <b>Sync all numbers</b> to point Twilio at this app.
              </p>
            </CardContent>
          </Card>
        </TabsContent>}

        {/* ── CALL FLOW ─────────────────────────────────────────────────── */}
        {showTab("callflow") && <TabsContent value="callflow">
          <Card>
            <CardHeader>
              <CardTitle>Call Flow</CardTitle>
              <CardDescription>How incoming calls to your main business line are handled. Multi-step, per-number call flows for tracking numbers live under <b>Call Tracking → Call Flows</b>.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <Toggle label="Forward calls to your phone" checked={!!draft.callForwardingEnabled} onChange={(v) => set("callForwardingEnabled", v)} testid="toggle-forward" />
              <Field label="Ring time before voicemail (seconds)">
                <Input type="number" min={5} max={60} value={draft.dialTimeoutSeconds ?? 25} onChange={(e) => set("dialTimeoutSeconds", parseInt(e.target.value, 10))} data-testid="input-dial-timeout" />
              </Field>
              <Separator />
              <Toggle label="Show caller's real number on your phone" checked={!!draft.showCallerIdOnForward} onChange={(v) => set("showCallerIdOnForward", v)} testid="toggle-caller-id" />
              <p className="text-xs text-muted-foreground -mt-3">When ON, your forwarded phone displays the original caller's number (so you can see who's calling). When OFF, it shows your Twilio business line.</p>
              <Separator />
              <Toggle label="Whisper announcement when you answer" checked={!!draft.whisperEnabled} onChange={(v) => set("whisperEnabled", v)} testid="toggle-whisper" />
              <Toggle label="Read caller's number in the whisper" checked={!!draft.whisperAnnounceCaller} onChange={(v) => set("whisperAnnounceCaller", v)} testid="toggle-whisper-announce" />
              <Field label="Whisper Voice">
                <VoiceSelect value={draft.whisperVoice || ""} onChange={(v) => set("whisperVoice", v)} testid="select-whisper-voice" />
              </Field>
              <Field label="Whisper Text">
                <Textarea rows={2} value={draft.whisperText || ""} onChange={(e) => set("whisperText", e.target.value)} data-testid="textarea-whisper" />
              </Field>
              <Separator />
              <h3 className="font-semibold text-sm">Business Hours</h3>
              <p className="text-xs text-muted-foreground -mt-2">
                Default schedule: <strong>Monday – Friday, 5:00 AM – 11:00 PM</strong>. Calls outside these hours use the after-hours action below.
              </p>
              <Toggle label="Enforce business hours" checked={!!draft.businessHoursEnabled} onChange={(v) => set("businessHoursEnabled", v)} testid="toggle-bh" />
              <div className="grid grid-cols-3 gap-3">
                <Field label="Start (HH:MM, 24h)"><Input value={draft.businessHoursStart || ""} onChange={(e) => set("businessHoursStart", e.target.value)} placeholder="05:00" data-testid="input-bh-start" /></Field>
                <Field label="End (HH:MM, 24h)"><Input value={draft.businessHoursEnd || ""} onChange={(e) => set("businessHoursEnd", e.target.value)} placeholder="23:00" data-testid="input-bh-end" /></Field>
                <Field label="Timezone"><Input value={draft.businessHoursTimezone || ""} onChange={(e) => set("businessHoursTimezone", e.target.value)} placeholder="America/New_York" data-testid="input-bh-tz" /></Field>
              </div>
              <Field label="Active Days" hint="Pick which days of the week the business hours apply. Unchecked days are always after-hours.">
                <DaysOfWeekPicker
                  value={draft.businessHoursDays || "1,2,3,4,5"}
                  onChange={(v) => set("businessHoursDays", v)}
                />
              </Field>
              <Field label="After-hours action">
                <Select value={draft.afterHoursAction || "voicemail"} onValueChange={(v) => set("afterHoursAction", v)}>
                  <SelectTrigger data-testid="select-after-hours"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="forward">Still forward to my phone</SelectItem>
                    <SelectItem value="voicemail">Send straight to voicemail</SelectItem>
                    <SelectItem value="sms_only">Tell caller to text instead</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </CardContent>
          </Card>
        </TabsContent>}

        {/* ── VOICEMAIL ─────────────────────────────────────────────────── */}
        {showTab("voicemail") && <TabsContent value="voicemail">
          <Card>
            <CardHeader>
              <CardTitle>Voicemail</CardTitle>
              <CardDescription>Plays when you don't answer in time.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Toggle label="Enable voicemail" checked={!!draft.voicemailEnabled} onChange={(v) => set("voicemailEnabled", v)} testid="toggle-voicemail" />
              <Field label="Greeting Voice">
                <VoiceSelect value={draft.voicemailGreetingVoice || ""} onChange={(v) => set("voicemailGreetingVoice", v)} testid="select-vm-voice" />
                <p className="text-xs text-muted-foreground mt-1">Pick a voice marked “Natural” for a smooth, professional, human-sounding greeting (★ recommended). Remember to click “Save Changes”.</p>
              </Field>
              <Field label="Greeting Text">
                <Textarea rows={3} value={draft.voicemailGreeting || ""} onChange={(e) => set("voicemailGreeting", e.target.value)} data-testid="textarea-vm-greeting" />
                <p className="text-xs text-muted-foreground mt-1">This is what the chosen voice will read to callers. Edit it any time, then click “Save Changes”.</p>
              </Field>
              <GreetingAudioField />
              <Field label="Maximum Recording Length (seconds)">
                <Input type="number" min={15} max={300} value={draft.voicemailMaxLengthSeconds ?? 120} onChange={(e) => set("voicemailMaxLengthSeconds", parseInt(e.target.value, 10))} data-testid="input-vm-maxlen" />
              </Field>
              <Toggle label="Transcribe voicemails (and text the transcript)" checked={!!draft.voicemailTranscriptionEnabled} onChange={(v) => set("voicemailTranscriptionEnabled", v)} testid="toggle-transcribe" />
            </CardContent>
          </Card>
        </TabsContent>}

        {/* ── SMS ───────────────────────────────────────────────────────── */}
        {showTab("sms") && <TabsContent value="sms">
          <Card>
            <CardHeader>
              <CardTitle>SMS</CardTitle>
              <CardDescription>Auto-reply and inbound forwarding for your main business line. To read and reply to texts, use <b>Messages</b>. Per-number auto-replies are set on each number under <b>Call Tracking</b>.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <Toggle label="Forward inbound texts to your phone" checked={!!draft.smsForwardEnabled} onChange={(v) => set("smsForwardEnabled", v)} testid="toggle-sms-forward" />
              <div className="space-y-3 rounded-lg border p-4">
                <div>
                  <Label>Broadcast recipients</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Each incoming customer text is forwarded to all configured numbers simultaneously. Maximum five.
                  </p>
                </div>
                {smsForwardTargets.map((target, index) => (
                  <div key={index} className="flex gap-2">
                    <Input
                      type="tel"
                      value={target}
                      onChange={(event) => {
                        const next = [...smsForwardTargets];
                        next[index] = event.target.value;
                        setSmsForwardTargets(next);
                      }}
                      placeholder="+1 954 555 0123"
                      aria-label={`SMS broadcast recipient ${index + 1}`}
                      data-testid={`input-sms-forward-${index}`}
                    />
                    {smsForwardTargets.length > 1 && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setSmsForwardTargets(smsForwardTargets.filter((_, i) => i !== index))}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                ))}
                {smsForwardTargets.length < 5 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSmsForwardTargets([...smsForwardTargets, ""])}
                  >
                    Add recipient
                  </Button>
                )}
              </div>
              <Separator />
              <Toggle label="Auto-reply to inbound texts" checked={!!draft.smsAutoReplyEnabled} onChange={(v) => set("smsAutoReplyEnabled", v)} testid="toggle-auto-reply" />
              <Field label="Auto-reply Message">
                <Textarea rows={5} value={draft.smsAutoReplyText || ""} onChange={(e) => set("smsAutoReplyText", e.target.value)} data-testid="textarea-auto-reply" />
              </Field>
              <Separator />
              <Toggle label="Send a follow-up text after every call" checked={!!draft.postCallSmsEnabled} onChange={(v) => set("postCallSmsEnabled", v)} testid="toggle-post-call" />
              <Field label="Post-call Text">
                <Textarea rows={5} value={draft.postCallSmsText || ""} onChange={(e) => set("postCallSmsText", e.target.value)} data-testid="textarea-post-call" />
              </Field>
              <Separator />
              <div className="rounded-md border bg-muted/30 p-4 space-y-4">
                <div>
                  <h3 className="text-base font-semibold flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" /> Intake Form Thank-You Text
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    When a customer submits the website intake form, this text is automatically sent
                    to the mobile number they entered. Use <code className="bg-background px-1 rounded">{`{{name}}`}</code> to insert their first name.
                  </p>
                </div>
                <Toggle
                  label="Auto-send thank-you text after intake form submission"
                  checked={!!draft.intakeSmsEnabled}
                  onChange={(v) => set("intakeSmsEnabled", v)}
                  testid="toggle-intake-sms"
                />
                <Field label="Thank-You Text Message" hint="Sent to the customer's mobile number immediately after they submit the intake form.">
                  <Textarea
                    rows={5}
                    value={draft.intakeSmsText || ""}
                    onChange={(e) => set("intakeSmsText", e.target.value)}
                    data-testid="textarea-intake-sms"
                    placeholder="Hi {{name}}, thanks for submitting your service request — we'll be in touch shortly."
                  />
                </Field>
              </div>
            </CardContent>
          </Card>
        </TabsContent>}

        {/* ── VOICEMAILS LIST ───────────────────────────────────────────── */}
        {showTab("messages") && <TabsContent value="messages">
          <VoicemailsList />
        </TabsContent>}
      </Tabs>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Toggle({ label, checked, onChange, testid }: { label: string; checked: boolean; onChange: (v: boolean) => void; testid?: string }) {
  return (
    <div className="flex items-center justify-between">
      <Label className="text-sm font-medium">{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} data-testid={testid} />
    </div>
  );
}

const DAY_OPTIONS: { iso: number; label: string }[] = [
  { iso: 1, label: "Mon" },
  { iso: 2, label: "Tue" },
  { iso: 3, label: "Wed" },
  { iso: 4, label: "Thu" },
  { iso: 5, label: "Fri" },
  { iso: 6, label: "Sat" },
  { iso: 7, label: "Sun" },
];

function DaysOfWeekPicker({ value, onChange }: { value: string; onChange: (csv: string) => void }) {
  const selected = new Set(
    (value || "")
      .split(",")
      .map((d) => parseInt(d.trim(), 10))
      .filter((n) => !isNaN(n)),
  );
  const toggle = (iso: number) => {
    const next = new Set(selected);
    if (next.has(iso)) next.delete(iso);
    else next.add(iso);
    const csv = Array.from(next).sort((a, b) => a - b).join(",");
    onChange(csv);
  };
  return (
    <div className="flex flex-wrap gap-2">
      {DAY_OPTIONS.map((d) => {
        const on = selected.has(d.iso);
        return (
          <button
            key={d.iso}
            type="button"
            onClick={() => toggle(d.iso)}
            data-testid={`day-${d.label.toLowerCase()}`}
            className={`px-3 py-1.5 rounded-md text-sm font-medium border transition ${
              on
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-foreground border-input hover:bg-muted"
            }`}
          >
            {d.label}
          </button>
        );
      })}
    </div>
  );
}

interface CalendarStatus {
  connected: boolean;
  account?: string;
  attachedCalendarId?: string | null;
  blockBusy?: boolean;
  pushEvents?: boolean;
  error?: string;
  calendars?: { id: string; summary: string; primary?: boolean; accessRole?: string }[];
}

export function CalendarPanel({
  currentId,
  blockBusy,
  pushEvents,
  onChange,
  onSave,
  saving,
}: {
  currentId: string;
  blockBusy: boolean;
  pushEvents: boolean;
  onChange: (patch: Record<string, any>) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const { data, isLoading, refetch, isFetching } = useQuery<CalendarStatus>({
    queryKey: ["/api/calendar/status"],
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CalendarIcon className="h-5 w-5" /> Google Calendar (Scheduling)</CardTitle>
        <CardDescription>
          Attach a Google Calendar to use for the appointment booking flow. When enabled, busy times block availability and confirmed appointments are pushed as events.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? (
          <div className="flex items-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin mr-2" /> Checking connection…</div>
        ) : data?.connected ? (
          <div className="flex items-start gap-3 rounded-md border border-green-200 bg-green-50 dark:bg-green-950/30 p-3">
            <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5" />
            <div className="text-sm">
              <div className="font-medium text-green-900 dark:text-green-200">Connected to Google</div>
              <div className="text-green-800 dark:text-green-300">Authorized account: <strong>{data.account || "—"}</strong></div>
              <div className="text-green-800 dark:text-green-300">{data.calendars?.length ?? 0} calendar(s) accessible</div>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 dark:bg-red-950/30 p-3">
            <AlertCircle className="h-5 w-5 text-red-600 mt-0.5" />
            <div className="text-sm text-red-900 dark:text-red-200">
              <div className="font-medium">Not connected</div>
              <div>{data?.error || "Google Calendar connector is not yet authorized for this Repl."}</div>
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Scheduling Calendar</Label>
          {data?.calendars?.length ? (
            <Select value={currentId} onValueChange={(v) => onChange({ schedulingCalendarId: v })}>
              <SelectTrigger data-testid="select-scheduling-calendar"><SelectValue placeholder="Pick a calendar" /></SelectTrigger>
              <SelectContent>
                {data.calendars.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.summary} {c.primary ? "(primary)" : ""} — {c.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={currentId}
              onChange={(e) => onChange({ schedulingCalendarId: e.target.value })}
              placeholder="calendar@example.com"
              data-testid="input-scheduling-calendar"
            />
          )}
          <p className="text-xs text-muted-foreground">
            Use the calendar email (e.g. <code>calendar@example.com</code>) or a calendar id from the list above.
          </p>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Block availability when calendar is busy</Label>
            <p className="text-xs text-muted-foreground">Customers won't see slots that overlap existing events on this calendar.</p>
          </div>
          <Switch checked={blockBusy} onCheckedChange={(v) => onChange({ schedulingCalendarBlockBusy: v })} data-testid="toggle-block-busy" />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Push confirmed appointments as events</Label>
            <p className="text-xs text-muted-foreground">When a customer books, an event is created on the attached calendar.</p>
          </div>
          <Switch checked={pushEvents} onCheckedChange={(v) => onChange({ schedulingCalendarPushEvents: v })} data-testid="toggle-push-events" />
        </div>

        <div className="flex items-center gap-2 pt-2">
          <Button onClick={onSave} disabled={saving} data-testid="button-save-calendar">
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
            Save Calendar Settings
          </Button>
          <Button variant="outline" onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh-calendar">
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Re-check Connection
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function VoiceSelect({ value, onChange, testid }: { value: string; onChange: (v: string) => void; testid?: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger data-testid={testid}><SelectValue placeholder="Select a voice" /></SelectTrigger>
      <SelectContent>
        {VOICE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function GreetingAudioField() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const { data } = useQuery<{ hasAudio: boolean; fileName: string | null }>({
    queryKey: ["/api/twilio/voicemail-greeting/audio"],
  });
  const hasAudio = !!data?.hasAudio;

  const onPick = async (file?: File) => {
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024) {
      toast({ title: "File too large", description: "Please upload an MP3 or WAV under 1.5 MB (a short greeting is plenty).", variant: "destructive" });
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setUploading(true);
    try {
      const res = await apiRequest("POST", "/api/twilio/voicemail-greeting/audio", undefined, {
        headers: {
          "Content-Type": file.type || "audio/mpeg",
          "X-File-Name": file.name.replace(/[^\x20-\x7E]/g, ""),
        },
        body: file,
      });
      await qc.invalidateQueries({ queryKey: ["/api/twilio/voicemail-greeting/audio"] });
      toast({ title: "Greeting uploaded", description: "Your recording will now play for callers instead of the spoken text." });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e?.message, variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const remove = useMutation({
    mutationFn: async () => apiRequest("DELETE", "/api/twilio/voicemail-greeting/audio"),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["/api/twilio/voicemail-greeting/audio"] });
      toast({ title: "Custom greeting removed", description: "Callers will now hear the spoken greeting text above." });
    },
    onError: (e: any) => toast({ title: "Remove failed", description: e?.message, variant: "destructive" }),
  });

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="text-sm font-medium">Upload Your Own Greeting (optional)</div>
      <p className="text-xs text-muted-foreground">
        Record a greeting in your own voice and upload it here (MP3 or WAV, under 1.5 MB). When a recording is uploaded, it plays for callers instead of the spoken text above.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept="audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav"
        className="hidden"
        data-testid="input-greeting-audio"
        onChange={(e) => onPick(e.target.files?.[0])}
      />
      {hasAudio ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
            <CheckCircle2 className="h-4 w-4" />
            <span data-testid="text-greeting-audio-name">Custom greeting active{data?.fileName ? `: ${data.fileName}` : ""}</span>
          </div>
          <audio controls className="w-full" src={`/webhooks/voice/greeting-audio?t=${Date.now()}`} data-testid="audio-greeting-preview" />
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()} data-testid="button-replace-greeting">
              {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Replace
            </Button>
            <Button type="button" variant="destructive" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()} data-testid="button-remove-greeting">
              {remove.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()} data-testid="button-upload-greeting">
          {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Play className="h-4 w-4 mr-2" />}
          Choose audio file
        </Button>
      )}
    </div>
  );
}

function formatPhone(num: string): string {
  return formatUsPhone(num, "Unknown");
}

function statusBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "secondary";
  if (status === "no-answer" || status === "busy" || status === "failed" || status === "canceled") return "destructive";
  return "default";
}

function CallLogPanel() {
  const { toast } = useToast();
  const { data: calls = [], isLoading } = useQuery<CallLog[]>({
    queryKey: ["/api/twilio/call-log"],
    refetchInterval: 15000,
  });
  const { data: stats } = useQuery<{ total: number; unique: number; last24h: number; voicemails: number }>({
    queryKey: ["/api/twilio/call-log/stats"],
    refetchInterval: 15000,
  });

  const remove = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/twilio/call-log/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/twilio/call-log"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/twilio/call-log/stats"] });
      toast({ title: "Call removed from log" });
    },
  });

  if (isLoading) return <div className="p-8 flex justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Calls" value={stats?.total ?? 0} icon={<PhoneIncoming className="h-4 w-4" />} />
        <StatCard label="Unique Callers" value={stats?.unique ?? 0} icon={<Phone className="h-4 w-4" />} />
        <StatCard label="Last 24 Hours" value={stats?.last24h ?? 0} icon={<History className="h-4 w-4" />} />
        <StatCard label="Voicemails Left" value={stats?.voicemails ?? 0} icon={<VoicemailIcon className="h-4 w-4" />} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Call Log</CardTitle>
          <CardDescription>Every call to your business line. Auto-refreshes every 15s.</CardDescription>
        </CardHeader>
        <CardContent>
          {calls.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No calls logged yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">When</th>
                    <th className="py-2 pr-3 font-medium">From</th>
                    <th className="py-2 pr-3 font-medium">Location</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">Duration</th>
                    <th className="py-2 pr-3 font-medium">Voicemail</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {calls.map((c) => (
                    <tr key={c.id} className="border-b last:border-0 hover:bg-muted/30" data-testid={`call-${c.id}`}>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {c.createdAt && (
                          <span title={format(new Date(c.createdAt), "PPp")}>
                            {formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 font-medium whitespace-nowrap">
                        <a href={`tel:${c.fromNumber}`} className="hover:underline">{formatPhone(c.fromNumber)}</a>
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">
                        {[c.fromCity, c.fromState].filter(Boolean).join(", ") || c.fromCountry || "—"}
                      </td>
                      <td className="py-2 pr-3"><Badge variant={statusBadgeVariant(c.status)}>{c.status}</Badge></td>
                      <td className="py-2 pr-3">{c.durationSeconds ? `${c.durationSeconds}s` : "—"}</td>
                      <td className="py-2 pr-3">
                        {c.hadVoicemail ? <Badge variant="outline"><VoicemailIcon className="h-3 w-3 mr-1" />Yes</Badge> : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="py-2 text-right">
                        <Button size="sm" variant="ghost" onClick={() => remove.mutate(c.id)} data-testid={`call-delete-${c.id}`}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center justify-between">
        <div>
          <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
          <div className="text-2xl font-bold">{value}</div>
        </div>
        <div className="text-muted-foreground">{icon}</div>
      </CardContent>
    </Card>
  );
}

export function VoicemailsList() {
  const { toast } = useToast();
  const { isAdmin } = useAdminAccess();
  const { data: list = [], isLoading } = useQuery<Voicemail[]>({ queryKey: ["/api/twilio/voicemails"] });

  const remove = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/twilio/voicemails/${id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/twilio/voicemails"] });
      toast({ title: "Voicemail deleted" });
    },
  });

  if (isLoading) return <div className="p-8 flex justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  if (list.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          No voicemails yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Voicemails</CardTitle>
        <CardDescription>{list.length} message{list.length === 1 ? "" : "s"}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.map((vm) => (
          <div key={vm.id} className="border rounded-lg p-4 space-y-2" data-testid={`voicemail-${vm.id}`}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Badge variant={vm.listened ? "secondary" : "default"}>{vm.listened ? "Heard" : "New"}</Badge>
                <span className="font-medium">{vm.fromNumber}</span>
                <span className="text-sm text-muted-foreground">
                  {vm.createdAt && format(new Date(vm.createdAt), "PPp")}
                </span>
                <span className="text-sm text-muted-foreground">{vm.durationSeconds ?? 0}s</span>
              </div>
              <div className="flex gap-2">
                {(vm.durationSeconds ?? 0) > 0 && (
                  <Button size="sm" variant="outline" asChild>
                    <a href={`/api/twilio/voicemails/${vm.id}/audio`} target="_blank" rel="noreferrer" data-testid={`play-${vm.id}`}>
                      <Play className="h-4 w-4 mr-1" />Play
                    </a>
                  </Button>
                )}
                {isAdmin && (
                  <Button size="sm" variant="ghost" onClick={() => remove.mutate(vm.id)} data-testid={`delete-${vm.id}`}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
            {(vm.durationSeconds ?? 0) > 0 ? (
              <audio controls preload="none" className="w-full">
                <source src={`/api/twilio/voicemails/${vm.id}/audio`} type="audio/mpeg" />
              </audio>
            ) : (
              <p className="text-sm text-muted-foreground">No audio — the caller hung up without leaving a message.</p>
            )}
            {vm.transcription && (
              <p className="text-sm bg-muted/50 p-2 rounded italic">"{vm.transcription}"</p>
            )}
            {!vm.transcription && vm.transcriptionStatus === "pending" && (
              <p className="text-xs text-muted-foreground">Transcription pending…</p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
