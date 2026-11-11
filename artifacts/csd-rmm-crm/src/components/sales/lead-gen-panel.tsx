import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertCircle, Building2, ExternalLink, Globe, Loader2, MapPin, Phone, Search, ShieldCheck, UserPlus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { errorMessage, fitScoreTone, type LeadGenRun, type LeadGenStatus, type Prospect } from "@/lib/sales-agents";
import { CopyButton } from "./copy-button";

type ProspectFilter = "new" | "imported" | "dismissed";
const DEFAULT_LOCATION = "Lauderhill, FL (Broward County)";

export function LeadGenPanel() {
  const { toast } = useToast();
  const [target, setTarget] = useState("");
  const [location, setLocation] = useState(DEFAULT_LOCATION);
  const [maxResults, setMaxResults] = useState(10);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [filter, setFilter] = useState<ProspectFilter>("new");

  const status = useQuery<LeadGenStatus>({ queryKey: ["/api/crm/lead-gen/status"] });
  const runs = useQuery<{ runs: LeadGenRun[] }>({ queryKey: ["/api/crm/lead-gen/runs"], staleTime: 0 });
  const activeRun = useQuery<{ run: LeadGenRun; prospects: Prospect[] }>({
    queryKey: [`/api/crm/lead-gen/runs/${activeRunId}`],
    enabled: activeRunId != null,
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.run.status === "running" || !query.state.data ? 4000 : false),
  });
  const prospects = useQuery<{ prospects: Prospect[] }>({
    queryKey: [`/api/crm/lead-gen/prospects?status=${filter}`],
    staleTime: 0,
  });

  const refreshLists = () => {
    void queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/crm/lead-gen/") });
  };

  // When the active run finishes, refresh the prospect and run lists once.
  const runStatus = activeRun.data?.run.status;
  useEffect(() => {
    if (activeRunId != null && runStatus && runStatus !== "running") refreshLists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, runStatus]);

  const start = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/crm/lead-gen/runs", { target: target.trim(), location: location.trim(), maxResults })).json() as Promise<{ runId: number }>,
    onSuccess: ({ runId }) => {
      setActiveRunId(runId);
      void queryClient.invalidateQueries({ queryKey: ["/api/crm/lead-gen/runs"] });
    },
    onError: (error) => toast({ title: "Search not started", description: errorMessage(error), variant: "destructive" }),
  });

  const importProspect = useMutation({
    mutationFn: async (id: number) => (await apiRequest("POST", `/api/crm/lead-gen/prospects/${id}/import`)).json() as Promise<{ prospect: Prospect }>,
    onSuccess: ({ prospect }) => {
      toast({ title: "Added to CRM", description: `${prospect.businessName} is now a new lead.` });
      refreshLists();
    },
    onError: (error) => toast({ title: "Import failed", description: errorMessage(error), variant: "destructive" }),
  });
  const dismiss = useMutation({
    mutationFn: async (id: number) => apiRequest("POST", `/api/crm/lead-gen/prospects/${id}/dismiss`),
    onSuccess: refreshLists,
    onError: (error) => toast({ title: "Could not dismiss", description: errorMessage(error), variant: "destructive" }),
  });

  const configured = status.data?.configured !== false;
  const running = activeRun.data?.run.status === "running" || (activeRunId != null && !activeRun.data);
  const shown = prospects.data?.prospects ?? [];

  return (
    <div className="space-y-4" data-testid="lead-gen-panel">
      <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          The agent researches public business information and suggests prospects. <strong>Nothing is contacted automatically</strong> —
          a prospect only reaches the CRM when you import it, and imported prospects never get Speed to Lead texts.
        </p>
      </div>

      {!configured && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" data-testid="lead-gen-not-configured">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          AI research is not configured. Add an ANTHROPIC_API_KEY secret to enable the Lead Generation Agent.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Search className="h-4 w-4 text-csd-red" />Find new prospects</CardTitle>
            <CardDescription>Describe who you want to sell to. The agent searches the web and scores each business for fit.</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_110px_auto] md:items-end"
              onSubmit={(event) => {
                event.preventDefault();
                if (target.trim().length >= 3) start.mutate();
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="lead-gen-target">Target businesses</Label>
                <Input
                  id="lead-gen-target"
                  data-testid="lead-gen-target"
                  placeholder="e.g. dental offices with 5–30 staff"
                  value={target}
                  maxLength={400}
                  onChange={(e) => setTarget(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-gen-location">Area</Label>
                <Input id="lead-gen-location" data-testid="lead-gen-location" value={location} maxLength={160} onChange={(e) => setLocation(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lead-gen-max">Results</Label>
                <Input
                  id="lead-gen-max"
                  data-testid="lead-gen-max"
                  type="number"
                  min={3}
                  max={25}
                  value={maxResults}
                  onChange={(e) => setMaxResults(Math.min(25, Math.max(3, Number(e.target.value) || 3)))}
                />
              </div>
              <Button type="submit" data-testid="lead-gen-start" disabled={!configured || target.trim().length < 3 || start.isPending || running}>
                {start.isPending || running ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Search className="mr-1.5 h-4 w-4" />}
                Find prospects
              </Button>
            </form>
            {running && (
              <p className="mt-3 flex items-center gap-2 text-sm text-gray-600" data-testid="lead-gen-running" aria-live="polite">
                <Loader2 className="h-4 w-4 animate-spin text-csd-red" />
                Researching the web… usually 1–3 minutes. You can leave this page; results are saved.
              </p>
            )}
            {activeRun.data?.run.status === "failed" && (
              <p role="alert" className="mt-3 text-sm text-red-700">{activeRun.data.run.error || "The research run failed."}</p>
            )}
            {activeRun.data?.run.status === "completed" && (
              <p className="mt-3 text-sm text-gray-700" data-testid="lead-gen-summary">
                Found {activeRun.data.run.prospectCount} new prospect{activeRun.data.run.prospectCount === 1 ? "" : "s"}.
                {activeRun.data.run.summary ? ` ${activeRun.data.run.summary}` : ""}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recent searches</CardTitle>
          </CardHeader>
          <CardContent className="max-h-64 space-y-1 overflow-y-auto">
            {(runs.data?.runs ?? []).length === 0 && <p className="text-sm text-gray-500">No searches yet.</p>}
            {(runs.data?.runs ?? []).map((run) => (
              <button
                type="button"
                key={run.id}
                onClick={() => { setActiveRunId(run.id); setFilter("new"); }}
                className={cn(
                  "w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-gray-100",
                  activeRunId === run.id && "bg-gray-100",
                )}
              >
                <span className="line-clamp-1 font-medium text-gray-900">{run.target}</span>
                <span className="flex items-center justify-between text-xs text-gray-500">
                  <span className="line-clamp-1">{run.location}</span>
                  <span className={cn(run.status === "failed" && "text-red-600", run.status === "running" && "text-amber-700")}>
                    {run.status === "completed" ? `${run.prospectCount} found` : run.status}
                  </span>
                </span>
              </button>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-gray-900">Prospects</h2>
        <div role="radiogroup" aria-label="Prospect status" className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
          {(["new", "imported", "dismissed"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={filter === value}
              data-testid={`prospect-filter-${value}`}
              onClick={() => setFilter(value)}
              className={cn("rounded-md px-3 py-1 text-xs font-medium capitalize", filter === value ? "bg-gray-900 text-white" : "text-gray-600 hover:text-gray-900")}
            >
              {value === "new" ? "To review" : value}
            </button>
          ))}
        </div>
      </div>

      {prospects.isLoading && <p className="text-sm text-gray-500">Loading prospects…</p>}
      {prospects.error && <p role="alert" className="text-sm text-red-700">{errorMessage(prospects.error)}</p>}
      {!prospects.isLoading && shown.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          {filter === "new" ? "No prospects waiting for review. Run a search above." : `No ${filter} prospects.`}
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {shown.map((p) => (
          <ProspectCard
            key={p.id}
            prospect={p}
            busy={(importProspect.isPending && importProspect.variables === p.id) || (dismiss.isPending && dismiss.variables === p.id)}
            onImport={() => importProspect.mutate(p.id)}
            onDismiss={() => dismiss.mutate(p.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ProspectCard({ prospect: p, busy, onImport, onDismiss }: { prospect: Prospect; busy: boolean; onImport: () => void; onDismiss: () => void }) {
  return (
    <Card className="flex flex-col" data-testid={`prospect-${p.id}`}>
      <CardHeader className="space-y-1 pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-start gap-2 text-base leading-snug">
            <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
            {p.businessName}
          </CardTitle>
          <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums", fitScoreTone(p.fitScore))} title="Fit score">
            {p.fitScore}/100
          </span>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600">
          {p.industry && <span>{p.industry}</span>}
          {p.city && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{p.city}</span>}
          {p.employeeEstimate && <span>{p.employeeEstimate} staff</span>}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 text-sm">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {p.website && (
            <a href={p.website} target="_blank" rel="noreferrer noopener" className="flex items-center gap-1 text-blue-700 hover:underline">
              <Globe className="h-3.5 w-3.5" />{p.website.replace(/^https?:\/\/(www\.)?/, "")}
            </a>
          )}
          {p.phone && <a href={`tel:${p.phone}`} className="flex items-center gap-1 text-gray-800 hover:underline"><Phone className="h-3.5 w-3.5" />{p.phone}</a>}
        </div>
        {p.fitReasons && <p className="text-gray-700">{p.fitReasons}</p>}
        {p.suggestedServices && (
          <div className="flex flex-wrap gap-1">
            {p.suggestedServices.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (
              <Badge key={s} variant="secondary" className="font-normal">{s}</Badge>
            ))}
          </div>
        )}
        {p.openingLine && (
          <div className="rounded-md bg-gray-50 p-2.5">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Opening line</p>
            <p className="mt-1 text-gray-800">{p.openingLine}</p>
            <div className="mt-2"><CopyButton text={p.openingLine} /></div>
          </div>
        )}
        {p.sources.length > 0 && (
          <details className="text-xs text-gray-600">
            <summary className="cursor-pointer">Sources ({p.sources.length})</summary>
            <ul className="mt-1 space-y-0.5">
              {p.sources.map((url) => (
                <li key={url} className="truncate">
                  <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-blue-700 hover:underline">
                    <ExternalLink className="h-3 w-3 shrink-0" />{url}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {p.status === "new" && (
            <>
              <Button size="sm" onClick={onImport} disabled={busy} data-testid={`prospect-import-${p.id}`}>
                <UserPlus className="mr-1.5 h-3.5 w-3.5" />Import to CRM
              </Button>
              <Button size="sm" variant="ghost" onClick={onDismiss} disabled={busy} data-testid={`prospect-dismiss-${p.id}`}>
                <X className="mr-1.5 h-3.5 w-3.5" />Dismiss
              </Button>
            </>
          )}
          {p.status === "imported" && (
            <>
              <Badge className="bg-green-600">Imported</Badge>
              <Link href="/crm/leads" className="text-sm text-blue-700 hover:underline" data-testid={`prospect-lead-link-${p.id}`}>Open leads</Link>
              {p.leadId && <Link href={`/sales/copilot?leadId=${p.leadId}`} className="text-sm text-blue-700 hover:underline">Research</Link>}
            </>
          )}
          {p.status === "dismissed" && <Badge variant="outline">Dismissed</Badge>}
        </div>
      </CardContent>
    </Card>
  );
}
