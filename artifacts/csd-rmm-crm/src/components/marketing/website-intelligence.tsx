import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useAuditLocalBusinessWebsite,
  useDiscoverLocalBusinessOpportunities,
} from "@workspace/api-client-react";
import type {
  LocalBusinessAuditReportList,
  LocalBusinessAuditResult,
  LocalBusinessDiscoveryInput,
  LocalBusinessDiscoveryResult,
  LocalBusinessIntelligenceStatus,
  LocalBusinessOpportunity,
  LocalBusinessSavedLead,
  LocalBusinessSavedLeadInput,
  LocalBusinessSavedLeadList,
} from "@workspace/api-client-react";
import { Building2, ExternalLink, Globe2, MapPin, Search, ShieldCheck, SquareArrowOutUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MarketingCard } from "./shared";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type View = "businesses" | "reports" | "saved";
type TechnologyFilter = "all" | "wordpress" | "php";

function resultMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "The request could not be completed.";
}

function isPhpReport(report: LocalBusinessAuditResult | undefined): boolean {
  return Boolean(report?.technologies.some((item) => /\bphp\b/i.test(item)) || /\bphp\b/i.test(report?.language ?? ""));
}

function domainLabel(website: string): string {
  try {
    return new URL(website).hostname.replace(/^www\./, "");
  } catch {
    return website;
  }
}

export function WebsiteIntelligence() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchLocation, setSearchLocation] = useState("Lauderhill, FL");
  const [radiusMiles, setRadiusMiles] = useState(25);
  const [view, setView] = useState<View>("businesses");
  const [technologyFilter, setTechnologyFilter] = useState<TechnologyFilter>("all");
  const [discovery, setDiscovery] = useState<LocalBusinessDiscoveryResult | null>(null);
  const [authorizedWebsites, setAuthorizedWebsites] = useState<Set<string>>(new Set());
  const [lastAudit, setLastAudit] = useState<LocalBusinessAuditResult | null>(null);

  const statusQuery = useQuery<LocalBusinessIntelligenceStatus>({
    queryKey: ["/api/crm/local-opportunities/status"],
    queryFn: getQueryFn({ on401: "throw" }),
    staleTime: 60_000,
  });
  const reportsQuery = useQuery<LocalBusinessAuditReportList>({
    queryKey: ["/api/crm/local-opportunities/reports"],
    queryFn: getQueryFn({ on401: "throw" }),
    staleTime: 30_000,
  });
  const leadsQuery = useQuery<LocalBusinessSavedLeadList>({
    queryKey: ["/api/crm/local-opportunities/leads"],
    queryFn: getQueryFn({ on401: "throw" }),
    staleTime: 30_000,
  });

  const discover = useDiscoverLocalBusinessOpportunities({
    mutation: {
      onSuccess: (result) => {
        setDiscovery(result);
        setView("businesses");
        setLastAudit(null);
      },
      onError: (error) => toast({ title: "Search failed", description: resultMessage(error), variant: "destructive" }),
    },
  });
  const audit = useAuditLocalBusinessWebsite({
    mutation: {
      onSuccess: async (result) => {
        setLastAudit(result);
        setView("reports");
        setAuthorizedWebsites((current) => new Set([...current].filter((website) => website !== result.website)));
        await queryClient.invalidateQueries({ queryKey: ["/api/crm/local-opportunities/reports"] });
        toast({ title: "Passive website check complete" });
      },
      onError: (error) => toast({ title: "Website check failed", description: resultMessage(error), variant: "destructive" }),
    },
  });
  const saveLead = useMutation({
    mutationFn: async (business: LocalBusinessOpportunity): Promise<LocalBusinessSavedLead> => {
      const payload: LocalBusinessSavedLeadInput = { business };
      const response = await apiRequest("POST", "/api/crm/local-opportunities/leads", payload);
      return response.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/crm/local-opportunities/leads"] });
      toast({ title: "Saved for review", description: "This prospect stays separate from CRM customer contacts." });
    },
    onError: (error) => toast({ title: "Could not save prospect", description: resultMessage(error), variant: "destructive" }),
  });

  const reports = reportsQuery.data?.reports ?? [];
  const savedLeads = leadsQuery.data?.leads ?? [];
  const reportByWebsite = useMemo(
    () => new Map(reports.map((report) => [report.website, report])),
    [reports],
  );
  const filteredBusinesses = useMemo(() => {
    const businesses = discovery?.businesses ?? [];
    if (technologyFilter === "all") return businesses;
    return businesses.filter((business) => {
      const report = reportByWebsite.get(business.website);
      return technologyFilter === "wordpress" ? report?.isWordPressOpportunity : isPhpReport(report);
    });
  }, [discovery?.businesses, reportByWebsite, technologyFilter]);
  const wordpressCount = reports.filter((report) => report.isWordPressOpportunity).length;
  const phpCount = reports.filter(isPhpReport).length;
  const savedKeys = new Set(savedLeads.map((lead) => `${lead.provider}:${lead.externalId}`));

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input: LocalBusinessDiscoveryInput = { searchLocation: searchLocation.trim(), radiusMiles };
    discover.mutate({ data: input });
  };

  const toggleAuthorization = (website: string, authorized: boolean) => {
    setAuthorizedWebsites((current) => {
      const next = new Set(current);
      if (authorized) next.add(website);
      else next.delete(website);
      return next;
    });
  };

  const checkWebsite = (website: string) => {
    audit.mutate({ data: { website, authorizationConfirmed: true } });
  };

  const status = statusQuery.data;

  return (
    <div className="space-y-4" data-testid="website-intelligence">
      <MarketingCard
        icon={Globe2}
        title="Website Intelligence"
        description="Find local computer-service businesses and review public website technology signals."
        testId="website-intelligence-search"
      >
        <div className="space-y-4">
          <form className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto]" onSubmit={submitSearch}>
            <div className="space-y-1.5">
              <Label htmlFor="website-search-location" className="text-xs font-medium text-gray-700">Search location</Label>
              <div className="relative">
                <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-600" />
                <Input
                  id="website-search-location"
                  value={searchLocation}
                  onChange={(event) => setSearchLocation(event.target.value)}
                  className="pl-9 placeholder:text-gray-600"
                  placeholder="City, state"
                  maxLength={200}
                  required
                  data-testid="website-search-location"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="website-search-radius" className="text-xs font-medium text-gray-700">Radius (miles)</Label>
              <Input
                id="website-search-radius"
                type="number"
                min={1}
                max={25}
                value={radiusMiles}
                onChange={(event) => setRadiusMiles(Number(event.target.value))}
                required
                data-testid="website-search-radius"
              />
            </div>
            <div className="flex items-end">
              <Button
                type="submit"
                className="w-full bg-csd-red hover:bg-red-700 sm:w-auto"
                disabled={discover.isPending || searchLocation.trim().length < 2 || radiusMiles < 1 || radiusMiles > 25}
                data-testid="website-search-submit"
              >
                <Search className="mr-2 h-4 w-4" />
                {discover.isPending ? "Searching…" : "Search"}
              </Button>
            </div>
          </form>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className={cn("rounded-full px-2.5 py-1 font-medium", status?.googlePlacesConfigured ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900")}>
              Google Places {status?.googlePlacesConfigured ? "ready" : "not configured"}
            </span>
            <span className="rounded-full bg-sky-100 px-2.5 py-1 font-medium text-sky-900">OpenStreetMap fallback available</span>
            <span className={cn("rounded-full px-2.5 py-1 font-medium", status?.whatCmsConfigured ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900")}>
              WhatCMS {status?.whatCmsConfigured ? "ready" : "needs API key"}
            </span>
          </div>
          {!status?.whatCmsConfigured && (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="whatcms-unconfigured">
              Add <code>WHATCMS_API_KEY</code> in Replit Secrets to enable passive technology checks. Discovery and saving prospects remain available without it.
            </p>
          )}
          <p className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2.5 text-xs leading-relaxed text-gray-700">
            Passive technology inventory only. Active security testing is not available. Only request a website check when you own the site or have permission to assess it.
          </p>
        </div>
      </MarketingCard>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Businesses found" value={discovery?.total ?? 0} />
        <Metric label="WordPress reports" value={wordpressCount} />
        <Metric label="PHP reports" value={phpCount} />
        <Metric label="Saved prospects" value={savedLeads.length} />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 pb-2" role="tablist" aria-label="Website intelligence views">
        {([
          ["businesses", "Businesses"],
          ["reports", "Audit reports"],
          ["saved", "Saved leads"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => setView(id)}
            className={cn("rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-csd-red focus-visible:ring-offset-2", view === id ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-gray-100")}
            data-testid={`website-view-${id}`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "businesses" && (
        <MarketingCard
          icon={Building2}
          title="Businesses found"
          description={discovery ? `${discovery.total} results · ${discovery.searchLocation} · ${discovery.radiusMiles} miles` : "Run a search to review public business listings"}
          testId="website-business-results"
        >
          {discovery && (
            <div className="mb-3 rounded-md bg-gray-100 px-3 py-2 text-xs text-gray-800" data-testid="website-provider-note">
              <p>{discovery.source === "google_places" ? "Google Places" : "OpenStreetMap"} · {discovery.providerNote}</p>
              {discovery.source === "openstreetmap" && (
                <p className="mt-1">
                  Data ©{" "}
                  <a className="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
                    OpenStreetMap contributors
                  </a>
                </p>
              )}
            </div>
          )}
          <div className="mb-3 flex flex-wrap gap-1.5" aria-label="Filter results by technology">
            {([
              ["all", "All businesses"],
              ["wordpress", "WordPress"],
              ["php", "PHP"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={technologyFilter === value}
                onClick={() => setTechnologyFilter(value)}
                className={cn("rounded-full border px-3 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-csd-red focus-visible:ring-offset-2", technologyFilter === value ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 text-gray-700 hover:border-gray-500")}
                data-testid={`website-filter-${value}`}
              >
                {label}
              </button>
            ))}
          </div>
          {!discovery && <EmptyState>Search an area to see businesses with public websites.</EmptyState>}
          {discovery && filteredBusinesses.length === 0 && (
            <EmptyState>{technologyFilter === "all" ? "No businesses with public websites were found in this area." : `No ${technologyFilter === "php" ? "PHP" : "WordPress"} results yet. Run an authorized passive check on a listed website first.`}</EmptyState>
          )}
          <ul className="divide-y divide-gray-100">
            {filteredBusinesses.map((business) => {
              const report = reportByWebsite.get(business.website);
              const saved = savedKeys.has(`${business.provider}:${business.externalId}`);
              const authorized = authorizedWebsites.has(business.website);
              return (
                <li key={business.id} className="py-4 first:pt-1 last:pb-1" data-testid={`website-business-${business.id}`}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <h3 className="truncate text-sm font-semibold text-gray-900">{business.name}</h3>
                      <p className="text-xs text-gray-700">{business.category}{business.location ? ` · ${business.location}` : ""}</p>
                      <a className="inline-flex max-w-full items-center gap-1 break-all text-xs font-medium text-blue-800 underline hover:text-blue-900" href={business.website} target="_blank" rel="noreferrer">
                        {domainLabel(business.website)} <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                      {report && (
                        <p className="text-xs text-gray-700">
                          {report.status === "success" ? [report.cms, ...report.technologies].filter(Boolean).join(" · ") || "Technology check completed" : report.message}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {business.mapsUrl && <ExternalLinkButton href={business.mapsUrl} label="Map" />}
                      {business.osmUrl && <ExternalLinkButton href={business.osmUrl} label="OSM" />}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={saved || saveLead.isPending}
                        onClick={() => saveLead.mutate(business)}
                        data-testid={`website-save-${business.id}`}
                      >
                        {saved ? "Saved" : "Save prospect"}
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-col gap-2 rounded-md border border-gray-200 bg-gray-50 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <label className="flex items-start gap-2 text-xs leading-relaxed text-gray-800">
                      <input
                        type="checkbox"
                        checked={authorized}
                        onChange={(event) => toggleAuthorization(business.website, event.target.checked)}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-csd-red"
                        data-testid={`website-authorize-${business.id}`}
                      />
                      I own this site or have permission to request a passive technology check.
                    </label>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!authorized || !status?.whatCmsConfigured || audit.isPending}
                      onClick={() => checkWebsite(business.website)}
                      data-testid={`website-audit-${business.id}`}
                    >
                      <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                      {audit.isPending && audit.variables?.data.website === business.website ? "Checking…" : "Check technologies"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </MarketingCard>
      )}

      {view === "reports" && (
        <MarketingCard icon={ShieldCheck} title="Audit reports" description="Passive technology results from sites you confirmed you are authorized to assess." testId="website-audit-reports">
          {lastAudit && (
            <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm" data-testid="website-last-audit">
              <p className="font-semibold text-emerald-900">{domainLabel(lastAudit.website)} · {lastAudit.status.replace("_", " ")}</p>
              <p className="mt-1 text-xs text-emerald-900">{lastAudit.message ?? ([lastAudit.cms, ...lastAudit.technologies].filter(Boolean).join(" · ") || "No technology details were returned.")}</p>
              {lastAudit.isWordPressOpportunity && <p className="mt-1 text-xs font-medium text-emerald-900">WordPress detected</p>}
            </div>
          )}
          {reportsQuery.isLoading && <EmptyState>Loading reports…</EmptyState>}
          {!reportsQuery.isLoading && reports.length === 0 && <EmptyState>No reports generated yet.</EmptyState>}
          <ul className="divide-y divide-gray-100">
            {reports.map((report) => (
              <li key={report.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid={`website-report-${report.id}`}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-900">{domainLabel(report.website)}</p>
                  <p className="text-xs text-gray-700">
                    {report.status.replace("_", " ")} · {[report.cms, ...report.technologies].filter(Boolean).join(", ") || report.message || "No technology detected"}
                  </p>
                </div>
                <time className="shrink-0 text-xs text-gray-700" dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleString()}</time>
              </li>
            ))}
          </ul>
        </MarketingCard>
      )}

      {view === "saved" && (
        <MarketingCard icon={Building2} title="Saved leads" description="Prospects are saved for review; they are not CRM customers or contacts." testId="website-saved-leads">
          {leadsQuery.isLoading && <EmptyState>Loading saved prospects…</EmptyState>}
          {!leadsQuery.isLoading && savedLeads.length === 0 && <EmptyState>No leads saved.</EmptyState>}
          <ul className="divide-y divide-gray-100">
            {savedLeads.map((lead) => (
              <li key={`${lead.provider}:${lead.externalId}`} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid={`website-lead-${lead.externalId}`}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-900">{lead.name}</p>
                  <p className="text-xs text-gray-700">{lead.category} · {domainLabel(lead.website)}</p>
                  <p className="text-xs text-gray-700">Saved {new Date(lead.savedAt).toLocaleDateString()} · {lead.provider === "google_places" ? "Google Places" : "OpenStreetMap"}</p>
                </div>
                <a href={lead.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-blue-800 underline hover:text-blue-900">
                  Open website <SquareArrowOutUpRight className="h-3 w-3" />
                </a>
              </li>
            ))}
          </ul>
        </MarketingCard>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-3 shadow-sm">
      <p className="text-xl font-bold tabular-nums text-gray-900">{value}</p>
      <p className="text-xs text-gray-700">{label}</p>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-gray-700">{children}</p>;
}

function ExternalLinkButton({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild size="sm" variant="outline">
      <a href={href} target="_blank" rel="noreferrer">
        {label}<ExternalLink className="ml-1 h-3 w-3" />
      </a>
    </Button>
  );
}
