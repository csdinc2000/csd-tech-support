import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertCircle, ArrowRight, Building2, ExternalLink, Globe2, Loader2, Mail, MessageSquare, RefreshCw, Search, ShieldAlert, Sparkles, Target,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { errorMessage, fitScoreTone, type CopilotLeadDetail, type CopilotLeadRow, type LeadBrief } from "@/lib/sales-agents";
import { CopyButton } from "./copy-button";

export function SalesCopilotPanel({ leadId, onSelectLead }: { leadId: number | null; onSelectLead: (id: number) => void }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(id);
  }, [q]);

  const leads = useQuery<{ configured: boolean; leads: CopilotLeadRow[] }>({
    queryKey: [`/api/crm/lead-research/leads?q=${encodeURIComponent(debounced)}`],
    staleTime: 0,
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]" data-testid="sales-copilot-panel">
      <Card className="lg:max-h-[calc(100vh-14rem)] lg:overflow-hidden">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Pick a lead</CardTitle>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
            <Input aria-label="Search leads" placeholder="Name, company or service" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} data-testid="copilot-search" />
          </div>
        </CardHeader>
        <CardContent className="max-h-72 space-y-1 overflow-y-auto lg:max-h-[calc(100vh-22rem)]">
          {leads.isLoading && <p className="text-sm text-gray-500">Loading leads…</p>}
          {leads.error && <p role="alert" className="text-sm text-red-700">{errorMessage(leads.error)}</p>}
          {leads.data?.leads.length === 0 && <p className="text-sm text-gray-500">No leads match.</p>}
          {leads.data?.leads.map((lead) => (
            <button
              key={lead.id}
              type="button"
              onClick={() => onSelectLead(lead.id)}
              aria-current={lead.id === leadId ? "true" : undefined}
              data-testid={`copilot-lead-${lead.id}`}
              className={cn("w-full rounded-md px-2 py-2 text-left hover:bg-gray-100", lead.id === leadId && "bg-red-50 ring-1 ring-csd-red/30")}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="line-clamp-1 text-sm font-medium text-gray-900">{lead.name}</span>
                {lead.briefStatus === "completed" && <Badge variant="secondary" className="shrink-0 text-[10px]">Brief</Badge>}
                {lead.briefStatus === "running" && <Badge className="shrink-0 bg-amber-500 text-[10px]">Researching</Badge>}
                {lead.briefStatus === "failed" && <Badge variant="outline" className="shrink-0 text-[10px] text-red-700">Failed</Badge>}
              </span>
              <span className="line-clamp-1 text-xs text-gray-500">
                {[lead.company, lead.serviceType, lead.status].filter(Boolean).join(" · ")}
              </span>
            </button>
          ))}
        </CardContent>
      </Card>

      <div className="min-w-0">
        {leads.data && !leads.data.configured && (
          <div role="alert" className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            AI research is not configured. Add an ANTHROPIC_API_KEY secret to enable the Sales Copilot.
          </div>
        )}
        {leadId == null ? (
          <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
            <Sparkles className="h-8 w-8 text-csd-red" />
            <p className="mt-2 font-medium text-gray-900">Choose a lead to prepare for your next call</p>
            <p className="mt-1 max-w-md text-sm text-gray-600">
              The copilot reads the CRM history, researches the business on the web when it is a company, and writes a call-ready brief.
            </p>
          </div>
        ) : (
          <LeadBriefView leadId={leadId} configured={leads.data?.configured !== false} />
        )}
      </div>
    </div>
  );
}

function LeadBriefView({ leadId, configured }: { leadId: number; configured: boolean }) {
  const { toast } = useToast();
  const key = [`/api/crm/lead-research/${leadId}`];
  const detail = useQuery<CopilotLeadDetail>({
    queryKey: key,
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.brief?.status === "running" ? 4000 : false),
  });
  const status = detail.data?.brief?.status;
  useEffect(() => {
    if (status && status !== "running") {
      void queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/crm/lead-research/leads") });
    }
  }, [status]);

  const research = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/crm/lead-research/${leadId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("/api/crm/lead-research/leads") });
    },
    onError: (err) => toast({ title: "Research not started", description: errorMessage(err), variant: "destructive" }),
  });

  if (detail.isLoading) return <p className="text-sm text-gray-500">Loading lead…</p>;
  if (detail.error || !detail.data) return <p role="alert" className="text-sm text-red-700">{errorMessage(detail.error)}</p>;
  const { lead, brief } = detail.data;
  const running = brief?.status === "running";

  return (
    <div className="space-y-4" data-testid="copilot-detail">
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-900" data-testid="copilot-lead-name">{lead.name}</h2>
            <p className="text-sm text-gray-600">{[lead.company, lead.serviceType, lead.source, lead.status].filter(Boolean).join(" · ")}</p>
            {(lead.phone || lead.email) && <p className="text-sm text-gray-700">{[lead.phone, lead.email].filter(Boolean).join(" · ")}</p>}
            {lead.problem && <p className="mt-1 line-clamp-3 text-sm text-gray-600">{lead.problem}</p>}
          </div>
          <Button onClick={() => research.mutate()} disabled={!configured || running || research.isPending} data-testid="copilot-research" className="shrink-0">
            {running || research.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : brief ? <RefreshCw className="mr-1.5 h-4 w-4" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
            {brief && brief.status !== "failed" ? "Refresh research" : "Research this lead"}
          </Button>
        </CardContent>
      </Card>

      {running && (
        <p className="flex items-center gap-2 rounded-lg border bg-white px-4 py-3 text-sm text-gray-700" aria-live="polite" data-testid="copilot-running">
          <Loader2 className="h-4 w-4 animate-spin text-csd-red" />Researching… this usually takes about a minute.
        </p>
      )}
      {brief?.status === "failed" && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{brief.error || "Research failed."}</p>}
      {!brief && !running && <p className="text-sm text-gray-600">No research yet for this lead.</p>}
      {brief?.status === "completed" && brief.brief && <BriefBody brief={brief.brief} sources={brief.sources} grounded={brief.grounded} finishedAt={brief.finishedAt} />}
    </div>
  );
}

function List({ items, testId }: { items: string[]; testId?: string }) {
  if (!items.length) return <p className="text-sm text-gray-500">None noted.</p>;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-gray-800" data-testid={testId}>
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  );
}

function Section({ title, icon: Icon, children, className }: { title: string; icon?: React.ComponentType<{ className?: string }>; children: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-600">
          {Icon && <Icon className="h-4 w-4 text-csd-red" />}{title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function BriefBody({ brief, sources, grounded, finishedAt }: { brief: LeadBrief; sources: string[]; grounded: boolean; finishedAt: string | null }) {
  const profile = Object.entries(brief.companyProfile ?? {}).filter(([, v]) => v);
  return (
    <div className="space-y-4" data-testid="copilot-brief">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <CardTitle className="text-base leading-snug" data-testid="copilot-headline">{brief.headline}</CardTitle>
            <div className="flex items-center gap-2">
              {grounded && <Badge variant="secondary" className="gap-1" data-testid="copilot-grounded"><Globe2 className="h-3 w-3" />Grounded in web research</Badge>}
              <span className={cn("rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums", fitScoreTone(brief.leadScore))} title="Lead score">
                Score {Math.round(brief.leadScore)}
              </span>
            </div>
          </div>
          <CardDescription>
            {brief.customerType.replace(/_/g, " ")}{finishedAt ? ` · researched ${new Date(finishedAt).toLocaleString()}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent><p className="text-sm text-gray-800">{brief.summary}</p></CardContent>
      </Card>

      <div className="rounded-lg border border-csd-red/30 bg-red-50 p-4" data-testid="copilot-next-action">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-csd-red"><Target className="h-4 w-4" />Next best action</p>
        <p className="mt-1 font-medium text-gray-900">{brief.nextBestAction.action}</p>
        <p className="text-sm text-gray-700">{[brief.nextBestAction.timing, brief.nextBestAction.channel && `by ${brief.nextBestAction.channel}`].filter(Boolean).join(" · ")}</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {profile.length > 0 && (
          <Section title="Company profile" icon={Building2}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {profile.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="capitalize text-gray-500">{k}</dt>
                  <dd className="break-words text-gray-800">{v}</dd>
                </div>
              ))}
            </dl>
          </Section>
        )}
        <Section title="Likely needs"><List items={brief.needs} /></Section>
        <Section title="Recommended services">
          {brief.recommendedServices.length === 0 ? <p className="text-sm text-gray-500">None noted.</p> : (
            <ul className="space-y-2 text-sm" data-testid="copilot-services">
              {brief.recommendedServices.map((s, i) => (
                <li key={i}><span className="font-medium text-gray-900">{s.service}</span><span className="text-gray-700"> — {s.why}</span></li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Talking points"><List items={brief.talkingPoints} testId="copilot-talking-points" /></Section>
        <Section title="Discovery questions"><List items={brief.discoveryQuestions} /></Section>
        <Section title="Objections">
          {brief.objections.length === 0 ? <p className="text-sm text-gray-500">None noted.</p> : (
            <div className="space-y-2">
              {brief.objections.map((o, i) => (
                <details key={i} className="rounded-md border p-2 text-sm" data-testid={`copilot-objection-${i}`}>
                  <summary className="cursor-pointer font-medium text-gray-900">“{o.objection}”</summary>
                  <p className="mt-1.5 text-gray-700">{o.response}</p>
                </details>
              ))}
            </div>
          )}
        </Section>
        {brief.risks.length > 0 && <Section title="Risks" icon={ShieldAlert}><List items={brief.risks} /></Section>}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Drafts</CardTitle>
          <CardDescription>
            Drafts are never sent from here. Review and send them yourself from{" "}
            <Link href="/messages" className="text-blue-700 hover:underline">Messages</Link> or{" "}
            <Link href="/comms/email" className="text-blue-700 hover:underline">Email from Support</Link>.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900"><Mail className="h-4 w-4" />Email</p>
            <p className="text-sm text-gray-800" data-testid="copilot-email-subject"><span className="text-gray-500">Subject: </span>{brief.draftEmail.subject}</p>
            <pre className="whitespace-pre-wrap rounded-md bg-gray-50 p-3 font-sans text-sm text-gray-800">{brief.draftEmail.body}</pre>
            <CopyButton text={`Subject: ${brief.draftEmail.subject}\n\n${brief.draftEmail.body}`} label="Copy email" />
          </div>
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900"><MessageSquare className="h-4 w-4" />Text message</p>
            <p className="rounded-md bg-gray-50 p-3 text-sm text-gray-800" data-testid="copilot-draft-text">{brief.draftText}</p>
            <div className="flex items-center gap-3">
              <CopyButton text={brief.draftText} label="Copy text" />
              <span className="text-xs text-gray-500 tabular-nums">{brief.draftText.length} characters</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {sources.length > 0 && (
        <Section title={`Sources (${sources.length})`}>
          <ul className="space-y-1 text-xs" data-testid="copilot-sources">
            {sources.map((url) => (
              <li key={url} className="truncate">
                <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-blue-700 hover:underline">
                  <ExternalLink className="h-3 w-3 shrink-0" />{url}
                </a>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <p className="flex items-center gap-1 text-xs text-gray-500"><ArrowRight className="h-3 w-3" />AI research can be wrong — confirm facts and pricing before quoting the customer.</p>
    </div>
  );
}
