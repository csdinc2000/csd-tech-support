import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import ComplianceNotice from "@/components/compliance-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Phone, Plus, Search, Trash2, Workflow, BarChart3, Hash, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { TrackingNumber, CallFlow } from "@shared/schema";

function fmtPhone(n?: string | null) {
  if (!n) return "—";
  const m = n.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : n;
}

export default function CallTrackingPage() {
  return (
    <div className="p-6 max-w-7xl mx-auto" data-testid="page-call-tracking">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Call Tracking</h1>
        <p className="text-muted-foreground">Multi-number tracking, call flows, and attribution analytics.</p>
      </div>
      <ComplianceNotice title="Call Recording Notice" className="mb-6">
        Calls may be recorded or monitored for quality assurance, training, security, and service
        documentation where permitted and with required consent. Florida requires all-party
        consent — ensure callers are notified before recording.
      </ComplianceNotice>
      <Tabs defaultValue="numbers" className="w-full">
        <TabsList className="grid grid-cols-3 w-full max-w-xl">
          <TabsTrigger value="numbers" data-testid="tab-numbers"><Phone className="w-4 h-4 mr-2" />Numbers</TabsTrigger>
          <TabsTrigger value="flows" data-testid="tab-flows"><Workflow className="w-4 h-4 mr-2" />Call Flows</TabsTrigger>
          <TabsTrigger value="analytics" data-testid="tab-analytics"><BarChart3 className="w-4 h-4 mr-2" />Analytics</TabsTrigger>
        </TabsList>
        <TabsContent value="numbers" className="mt-6"><NumbersTab /></TabsContent>
        <TabsContent value="flows" className="mt-6"><FlowsTab /></TabsContent>
        <TabsContent value="analytics" className="mt-6"><AnalyticsTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ── NUMBERS TAB ────────────────────────────────────────────────────────────
function NumbersTab() {
  const { toast } = useToast();
  const { data: numbers = [], isLoading } = useQuery<TrackingNumber[]>({ queryKey: ["/api/call-tracking/numbers"] });
  const { data: flows = [] } = useQuery<CallFlow[]>({ queryKey: ["/api/call-tracking/flows"] });
  const [searchOpen, setSearchOpen] = useState(false);
  const [addManualOpen, setAddManualOpen] = useState(false);
  const [editing, setEditing] = useState<TrackingNumber | null>(null);

  // Unified sync — points the main business line AND every tracking number at
  // this app's webhooks (same action as Phone Settings → Sync all numbers).
  const sync = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/twilio/sync-webhooks", {}),
    onSuccess: () => toast({ title: "Webhooks synced", description: "Main line and all tracking numbers now point at this app." }),
    onError: (e: any) => toast({ title: "Sync failed", description: e?.message, variant: "destructive" }),
  });

  const del = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/call-tracking/numbers/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/call-tracking/numbers"] });
      toast({ title: "Number removed" });
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Tracking Numbers</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">Each number has its own campaign attribution and call flow.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => sync.mutate()} disabled={sync.isPending} data-testid="button-sync-webhooks">
            <RefreshCw className={`w-4 h-4 mr-2 ${sync.isPending ? "animate-spin" : ""}`} />Sync All Numbers
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAddManualOpen(true)} data-testid="button-add-manual">
            <Plus className="w-4 h-4 mr-2" />Add Existing
          </Button>
          <Button size="sm" onClick={() => setSearchOpen(true)} data-testid="button-provision">
            <Search className="w-4 h-4 mr-2" />Provision New
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : numbers.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Phone className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No tracking numbers yet. Provision your first to start attributing calls.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {numbers.map((n) => (
              <div key={n.id} className="flex items-center justify-between p-4 border rounded-lg hover-elevate" data-testid={`number-row-${n.id}`}>
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <span className="font-mono font-semibold">{fmtPhone(n.phoneNumber)}</span>
                    <Badge variant={n.numberType === "tollfree" ? "default" : "secondary"}>{n.numberType}</Badge>
                    {!n.active && <Badge variant="outline">Inactive</Badge>}
                  </div>
                  <div className="text-sm text-muted-foreground mt-1">
                    {n.campaignName || n.friendlyName || "No campaign"}
                    {n.sourceChannel && <span> · {n.sourceChannel}</span>}
                    {n.keywords && <span> · "{n.keywords}"</span>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Forwards to: {fmtPhone(n.forwardToNumber) || "global default"}
                    {" · "}Flow: {flows.find((f) => f.id === n.callFlowId)?.name || "global default"}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(n)} data-testid={`button-edit-${n.id}`}>Edit</Button>
                  <Button variant="ghost" size="sm" onClick={() => del.mutate(n.id)} data-testid={`button-delete-${n.id}`}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} flows={flows} />
      <ManualAddDialog open={addManualOpen} onOpenChange={setAddManualOpen} flows={flows} />
      {editing && <EditNumberDialog number={editing} flows={flows} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function SearchDialog({ open, onOpenChange, flows }: { open: boolean; onOpenChange: (v: boolean) => void; flows: CallFlow[] }) {
  const { toast } = useToast();
  const [type, setType] = useState<"local" | "tollfree">("local");
  const [areaCode, setAreaCode] = useState("");
  const [contains, setContains] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [campaign, setCampaign] = useState("");
  const [channel, setChannel] = useState("");
  const [keywords, setKeywords] = useState("");
  const [callFlowId, setCallFlowId] = useState<string>("none");
  const [forwardTo, setForwardTo] = useState("");

  async function doSearch() {
    setSearching(true);
    try {
      const res = await apiRequest("POST", "/api/call-tracking/numbers/search", { type, areaCode: areaCode || undefined, contains: contains || undefined, limit: 12 });
      setResults(await res.json());
    } catch (e: any) { toast({ title: "Search failed", description: e?.message, variant: "destructive" }); }
    finally { setSearching(false); }
  }

  async function buy(phoneNumber: string) {
    try {
      await apiRequest("POST", "/api/call-tracking/numbers/purchase", {
        phoneNumber, numberType: type,
        campaignName: campaign || undefined, sourceChannel: channel || undefined, keywords: keywords || undefined,
        callFlowId: callFlowId !== "none" ? parseInt(callFlowId, 10) : undefined,
        forwardToNumber: forwardTo || undefined,
      });
      toast({ title: "Number purchased", description: `${phoneNumber} is now active.` });
      queryClient.invalidateQueries({ queryKey: ["/api/call-tracking/numbers"] });
      onOpenChange(false);
    } catch (e: any) { toast({ title: "Purchase failed", description: e?.message, variant: "destructive" }); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Provision a Tracking Number</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as any)}>
                <SelectTrigger data-testid="select-number-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">Local</SelectItem>
                  <SelectItem value="tollfree">Toll-Free</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label>Area Code</Label><Input value={areaCode} onChange={(e) => setAreaCode(e.target.value)} placeholder="e.g. 954" data-testid="input-area-code" /></div>
            <div><Label>Contains</Label><Input value={contains} onChange={(e) => setContains(e.target.value)} placeholder="digits/letters" data-testid="input-contains" /></div>
          </div>
          <Button onClick={doSearch} disabled={searching} data-testid="button-search-numbers">
            <Search className="w-4 h-4 mr-2" />{searching ? "Searching…" : "Search Available Numbers"}
          </Button>

          {results.length > 0 && (
            <>
              <div className="border-t pt-4 grid grid-cols-2 gap-3">
                <div><Label>Campaign Name</Label><Input value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="Spring Promo" /></div>
                <div><Label>Source Channel</Label><Input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="Google PPC" /></div>
                <div><Label>Keywords</Label><Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="emergency it support" /></div>
                <div><Label>Forward To (optional)</Label><Input value={forwardTo} onChange={(e) => setForwardTo(e.target.value)} placeholder="+19542533135" /></div>
                <div className="col-span-2">
                  <Label>Call Flow</Label>
                  <Select value={callFlowId} onValueChange={setCallFlowId}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— Use global default —</SelectItem>
                      {flows.map((f) => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="border-t pt-4 space-y-1">
                <p className="text-sm font-medium">Available numbers:</p>
                {results.map((r) => (
                  <div key={r.phoneNumber} className="flex items-center justify-between p-2 border rounded">
                    <div>
                      <div className="font-mono">{fmtPhone(r.phoneNumber)}</div>
                      <div className="text-xs text-muted-foreground">{r.locality || ""} {r.region || ""}</div>
                    </div>
                    <Button size="sm" onClick={() => buy(r.phoneNumber)} data-testid={`button-buy-${r.phoneNumber}`}>Purchase</Button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ManualAddDialog({ open, onOpenChange, flows }: { open: boolean; onOpenChange: (v: boolean) => void; flows: CallFlow[] }) {
  const { toast } = useToast();
  const [form, setForm] = useState({ phoneNumber: "", friendlyName: "", numberType: "local", campaignName: "", sourceChannel: "", keywords: "", forwardToNumber: "", callFlowId: "none" });
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  async function save() {
    try {
      await apiRequest("POST", "/api/call-tracking/numbers", {
        phoneNumber: form.phoneNumber, friendlyName: form.friendlyName || null,
        numberType: form.numberType, campaignName: form.campaignName || null,
        sourceChannel: form.sourceChannel || null, keywords: form.keywords || null,
        forwardToNumber: form.forwardToNumber || null,
        callFlowId: form.callFlowId !== "none" ? parseInt(form.callFlowId, 10) : null,
        smsAutoReplyEnabled: false, active: true,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/call-tracking/numbers"] });
      toast({ title: "Tracking number added" });
      onOpenChange(false);
    } catch (e: any) { toast({ title: "Add failed", description: e?.message, variant: "destructive" }); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add Existing Twilio Number</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><Label>Phone Number (E.164)</Label><Input value={form.phoneNumber} onChange={(e) => set("phoneNumber", e.target.value)} placeholder="+19546377300" /></div>
          <div><Label>Friendly Name</Label><Input value={form.friendlyName} onChange={(e) => set("friendlyName", e.target.value)} /></div>
          <div>
            <Label>Type</Label>
            <Select value={form.numberType} onValueChange={(v) => set("numberType", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="local">Local</SelectItem><SelectItem value="tollfree">Toll-Free</SelectItem></SelectContent>
            </Select>
          </div>
          <div><Label>Campaign</Label><Input value={form.campaignName} onChange={(e) => set("campaignName", e.target.value)} /></div>
          <div><Label>Source Channel</Label><Input value={form.sourceChannel} onChange={(e) => set("sourceChannel", e.target.value)} /></div>
          <div><Label>Keywords</Label><Input value={form.keywords} onChange={(e) => set("keywords", e.target.value)} /></div>
          <div><Label>Forward To</Label><Input value={form.forwardToNumber} onChange={(e) => set("forwardToNumber", e.target.value)} placeholder="+1…" /></div>
          <div className="col-span-2">
            <Label>Call Flow</Label>
            <Select value={form.callFlowId} onValueChange={(v) => set("callFlowId", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— Global default —</SelectItem>
                {flows.map((f) => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter><Button onClick={save} data-testid="button-save-manual-number">Add</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditNumberDialog({ number, flows, onClose }: { number: TrackingNumber; flows: CallFlow[]; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    friendlyName: number.friendlyName ?? "",
    campaignName: number.campaignName ?? "",
    sourceChannel: number.sourceChannel ?? "",
    keywords: number.keywords ?? "",
    forwardToNumber: number.forwardToNumber ?? "",
    callFlowId: number.callFlowId ? String(number.callFlowId) : "none",
    smsAutoReplyEnabled: number.smsAutoReplyEnabled,
    smsAutoReplyText: number.smsAutoReplyText ?? "",
    voicemailGreeting: number.voicemailGreeting ?? "",
    active: number.active,
  });
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  async function save() {
    try {
      await apiRequest("PATCH", `/api/call-tracking/numbers/${number.id}`, {
        friendlyName: form.friendlyName || null,
        campaignName: form.campaignName || null,
        sourceChannel: form.sourceChannel || null,
        keywords: form.keywords || null,
        forwardToNumber: form.forwardToNumber || null,
        callFlowId: form.callFlowId !== "none" ? parseInt(form.callFlowId, 10) : null,
        smsAutoReplyEnabled: form.smsAutoReplyEnabled,
        smsAutoReplyText: form.smsAutoReplyText || null,
        voicemailGreeting: form.voicemailGreeting || null,
        active: form.active,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/call-tracking/numbers"] });
      toast({ title: "Saved" });
      onClose();
    } catch (e: any) { toast({ title: "Save failed", description: e?.message, variant: "destructive" }); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Edit {fmtPhone(number.phoneNumber)}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Friendly Name</Label><Input value={form.friendlyName} onChange={(e) => set("friendlyName", e.target.value)} /></div>
          <div><Label>Campaign</Label><Input value={form.campaignName} onChange={(e) => set("campaignName", e.target.value)} /></div>
          <div><Label>Source Channel</Label><Input value={form.sourceChannel} onChange={(e) => set("sourceChannel", e.target.value)} /></div>
          <div><Label>Keywords</Label><Input value={form.keywords} onChange={(e) => set("keywords", e.target.value)} /></div>
          <div><Label>Forward To</Label><Input value={form.forwardToNumber} onChange={(e) => set("forwardToNumber", e.target.value)} /></div>
          <div>
            <Label>Call Flow</Label>
            <Select value={form.callFlowId} onValueChange={(v) => set("callFlowId", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— Global default —</SelectItem>
                {flows.map((f) => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2 flex items-center justify-between p-3 border rounded">
            <div><Label>Active</Label><p className="text-xs text-muted-foreground">Inactive numbers ignore inbound calls.</p></div>
            <Switch checked={form.active} onCheckedChange={(v) => set("active", v)} />
          </div>
          <div className="col-span-2 flex items-center justify-between p-3 border rounded">
            <Label>SMS Auto-Reply</Label>
            <Switch checked={form.smsAutoReplyEnabled} onCheckedChange={(v) => set("smsAutoReplyEnabled", v)} />
          </div>
          {form.smsAutoReplyEnabled && (
            <div className="col-span-2"><Label>Auto-Reply Text</Label><Textarea rows={3} value={form.smsAutoReplyText} onChange={(e) => set("smsAutoReplyText", e.target.value)} /></div>
          )}
          <div className="col-span-2"><Label>Voicemail Greeting (overrides global)</Label><Textarea rows={2} value={form.voicemailGreeting} onChange={(e) => set("voicemailGreeting", e.target.value)} /></div>
        </div>
        <DialogFooter><Button onClick={save} data-testid="button-save-edit">Save Changes</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── FLOWS TAB ──────────────────────────────────────────────────────────────
function FlowsTab() {
  const { toast } = useToast();
  const { data: flows = [] } = useQuery<CallFlow[]>({ queryKey: ["/api/call-tracking/flows"] });
  const [editing, setEditing] = useState<CallFlow | null>(null);
  const [creating, setCreating] = useState(false);

  const del = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/call-tracking/flows/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/call-tracking/flows"] }); toast({ title: "Flow deleted" }); },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Call Flows</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">Reusable multi-step routing logic. Assign to one or more tracking numbers.</p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)} data-testid="button-new-flow"><Plus className="w-4 h-4 mr-2" />New Flow</Button>
      </CardHeader>
      <CardContent>
        {flows.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Workflow className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No call flows yet. Create one to define multi-step routing.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {flows.map((f) => {
              const stepCount = Array.isArray(f.steps) ? (f.steps as any[]).length : 0;
              return (
                <div key={f.id} className="flex items-center justify-between p-4 border rounded-lg" data-testid={`flow-row-${f.id}`}>
                  <div>
                    <div className="font-semibold">{f.name}</div>
                    <div className="text-xs text-muted-foreground">{stepCount} step{stepCount === 1 ? "" : "s"} · {f.description || "No description"}</div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(f)}>Edit</Button>
                    <Button variant="ghost" size="sm" onClick={() => del.mutate(f.id)}><Trash2 className="w-4 h-4" /></Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
      {(creating || editing) && (
        <FlowEditor flow={editing} onClose={() => { setEditing(null); setCreating(false); }} />
      )}
    </Card>
  );
}

function FlowEditor({ flow, onClose }: { flow: CallFlow | null; onClose: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState(flow?.name ?? "");
  const [description, setDescription] = useState(flow?.description ?? "");
  const [steps, setSteps] = useState<any[]>(Array.isArray(flow?.steps) ? (flow!.steps as any[]) : []);

  const STEP_TEMPLATES: Record<string, any> = {
    say: { type: "say", text: "Thank you for calling.", voice: "Polly.Joanna" },
    menu: { type: "menu", prompt: "Press 1 for sales, 2 for support.", options: [{ digit: "1", goto: 1 }, { digit: "2", goto: 2 }] },
    dial: { type: "dial", to: "+19542533135", timeout: 25, whisper: true, callerId: "original" },
    voicemail: { type: "voicemail", greeting: "Please leave a message after the tone.", maxLength: 120, transcribe: true },
    sms: { type: "sms", body: "Thanks for calling — here's a link to our intake form: https://bit.ly/4tZm0g5" },
    hangup: { type: "hangup" },
    goto: { type: "goto", step: 0 },
  };

  function addStep(t: string) { setSteps([...steps, { ...STEP_TEMPLATES[t] }]); }
  function updateStep(i: number, patch: any) { setSteps(steps.map((s, idx) => idx === i ? { ...s, ...patch } : s)); }
  function removeStep(i: number) { setSteps(steps.filter((_, idx) => idx !== i)); }
  function moveStep(i: number, dir: -1 | 1) {
    const j = i + dir; if (j < 0 || j >= steps.length) return;
    const next = [...steps]; [next[i], next[j]] = [next[j], next[i]]; setSteps(next);
  }

  async function save() {
    if (!name.trim()) { toast({ title: "Name required", variant: "destructive" }); return; }
    try {
      const payload = { name, description: description || null, steps, active: true };
      if (flow) await apiRequest("PATCH", `/api/call-tracking/flows/${flow.id}`, payload);
      else await apiRequest("POST", "/api/call-tracking/flows", payload);
      queryClient.invalidateQueries({ queryKey: ["/api/call-tracking/flows"] });
      toast({ title: "Saved" }); onClose();
    } catch (e: any) { toast({ title: "Save failed", description: e?.message, variant: "destructive" }); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{flow ? "Edit Flow" : "New Call Flow"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-flow-name" /></div>
            <div><Label>Description</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          </div>

          <div className="border rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <Label>Steps</Label>
              <Select onValueChange={(v) => addStep(v)}>
                <SelectTrigger className="w-40"><SelectValue placeholder="+ Add step…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="say">Say (text)</SelectItem>
                  <SelectItem value="menu">Menu (gather digit)</SelectItem>
                  <SelectItem value="dial">Dial (forward)</SelectItem>
                  <SelectItem value="voicemail">Voicemail</SelectItem>
                  <SelectItem value="sms">Send SMS</SelectItem>
                  <SelectItem value="goto">Goto step</SelectItem>
                  <SelectItem value="hangup">Hang up</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {steps.length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">No steps. Add one above to start.</p>}
            {steps.map((s, i) => (
              <div key={i} className="border rounded p-3 space-y-2 bg-muted/30" data-testid={`step-${i}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2"><Hash className="w-4 h-4" /><span className="font-mono text-xs">step {i}</span><Badge>{s.type}</Badge></div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => moveStep(i, -1)}>↑</Button>
                    <Button size="sm" variant="ghost" onClick={() => moveStep(i, 1)}>↓</Button>
                    <Button size="sm" variant="ghost" onClick={() => removeStep(i)}><Trash2 className="w-4 h-4" /></Button>
                  </div>
                </div>
                <StepFields step={s} onChange={(p) => updateStep(i, p)} />
              </div>
            ))}
          </div>
        </div>
        <DialogFooter><Button onClick={save} data-testid="button-save-flow">Save Flow</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepFields({ step, onChange }: { step: any; onChange: (p: any) => void }) {
  switch (step.type) {
    case "say":
      return <div><Label>Text to speak</Label><Textarea rows={2} value={step.text || ""} onChange={(e) => onChange({ text: e.target.value })} /></div>;
    case "menu":
      return (
        <div className="space-y-2">
          <div><Label>Prompt</Label><Textarea rows={2} value={step.prompt || ""} onChange={(e) => onChange({ prompt: e.target.value })} /></div>
          <Label>Options (digit → goto step #)</Label>
          {(step.options || []).map((o: any, i: number) => (
            <div key={i} className="flex gap-2">
              <Input className="w-16" value={o.digit} onChange={(e) => { const opts = [...step.options]; opts[i] = { ...o, digit: e.target.value }; onChange({ options: opts }); }} />
              <Input type="number" className="w-24" value={o.goto} onChange={(e) => { const opts = [...step.options]; opts[i] = { ...o, goto: parseInt(e.target.value, 10) }; onChange({ options: opts }); }} />
              <Button size="sm" variant="ghost" onClick={() => { const opts = step.options.filter((_: any, j: number) => j !== i); onChange({ options: opts }); }}>×</Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={() => onChange({ options: [...(step.options || []), { digit: "0", goto: 0 }] })}>+ Option</Button>
        </div>
      );
    case "dial":
      return (
        <div className="grid grid-cols-2 gap-2">
          <div><Label>Forward to</Label><Input value={step.to || ""} onChange={(e) => onChange({ to: e.target.value })} placeholder="+1…" /></div>
          <div><Label>Timeout (sec)</Label><Input type="number" value={step.timeout || 25} onChange={(e) => onChange({ timeout: parseInt(e.target.value, 10) })} /></div>
          <div className="flex items-center gap-2"><Switch checked={!!step.whisper} onCheckedChange={(v) => onChange({ whisper: v })} /><Label>Whisper announcement</Label></div>
          <div>
            <Label>Caller ID</Label>
            <Select value={step.callerId || "original"} onValueChange={(v) => onChange({ callerId: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="original">Original Caller</SelectItem><SelectItem value="tracking">Tracking Number</SelectItem></SelectContent>
            </Select>
          </div>
        </div>
      );
    case "voicemail":
      return (
        <div className="space-y-2">
          <div><Label>Greeting</Label><Textarea rows={2} value={step.greeting || ""} onChange={(e) => onChange({ greeting: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>Max length (sec)</Label><Input type="number" value={step.maxLength || 120} onChange={(e) => onChange({ maxLength: parseInt(e.target.value, 10) })} /></div>
            <div className="flex items-center gap-2 mt-6"><Switch checked={!!step.transcribe} onCheckedChange={(v) => onChange({ transcribe: v })} /><Label>Transcribe</Label></div>
          </div>
        </div>
      );
    case "sms":
      return <div><Label>SMS body to send to caller</Label><Textarea rows={2} value={step.body || ""} onChange={(e) => onChange({ body: e.target.value })} /></div>;
    case "goto":
      return <div><Label>Jump to step #</Label><Input type="number" value={step.step ?? 0} onChange={(e) => onChange({ step: parseInt(e.target.value, 10) })} /></div>;
    default:
      return <p className="text-xs text-muted-foreground">No options for this step.</p>;
  }
}

// SMS lives in the unified Messages inbox (Phone & Text → Messages), which shows
// every conversation across the main line and all tracking numbers and replies
// from the number the customer contacted. The former per-number SMS tab here was
// a redundant view over the same data and has been removed.

// ── ANALYTICS TAB ──────────────────────────────────────────────────────────
function AnalyticsTab() {
  const { data: byNumber = [] } = useQuery<any[]>({ queryKey: ["/api/call-tracking/analytics/by-number"] });
  const { data: byChannel = [] } = useQuery<any[]>({ queryKey: ["/api/call-tracking/analytics/by-channel"] });
  const { data: byDay = [] } = useQuery<any[]>({ queryKey: ["/api/call-tracking/analytics/by-day"] });
  const max = Math.max(1, ...byDay.map((d) => d.count));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle>Calls by Tracking Number</CardTitle></CardHeader>
        <CardContent>
          {byNumber.length === 0 ? <p className="text-sm text-muted-foreground">No calls logged yet.</p> : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-muted-foreground border-b"><th className="py-2">Number</th><th>Campaign</th><th>Channel</th><th>Calls</th><th>Unique</th><th>Voicemails</th><th>Avg Duration</th></tr></thead>
              <tbody>
                {byNumber.map((r, i) => (
                  <tr key={i} className="border-b">
                    <td className="py-2 font-mono">{fmtPhone(r.phoneNumber) || "Unattributed"}</td>
                    <td>{r.campaignName || "—"}</td>
                    <td>{r.sourceChannel || "—"}</td>
                    <td className="font-semibold">{r.totalCalls}</td>
                    <td>{r.uniqueCallers}</td>
                    <td>{r.voicemails}</td>
                    <td>{r.avgDuration}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle>By Source Channel</CardTitle></CardHeader>
          <CardContent>
            {byChannel.length === 0 ? <p className="text-sm text-muted-foreground">No data.</p> : (
              <div className="space-y-2">
                {byChannel.map((r, i) => {
                  const m = Math.max(1, ...byChannel.map((x) => x.totalCalls));
                  return (
                    <div key={i}>
                      <div className="flex justify-between text-sm"><span>{r.sourceChannel}</span><span className="font-mono">{r.totalCalls}</span></div>
                      <div className="h-2 bg-muted rounded"><div className="h-2 bg-primary rounded" style={{ width: `${(r.totalCalls / m) * 100}%` }} /></div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Calls by Day (last 30)</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-end gap-1 h-40">
              {byDay.length === 0 && <p className="text-sm text-muted-foreground">No data.</p>}
              {byDay.map((d) => (
                <div key={d.day} className="flex-1 flex flex-col items-center justify-end" title={`${d.day}: ${d.count}`}>
                  <div className="w-full bg-primary rounded-t" style={{ height: `${(d.count / max) * 100}%` }} />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
