import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";
import { useLocation, useSearch } from "wouter";
import { AlertCircle, CheckSquare, Gift, LayoutDashboard, LayoutGrid, Megaphone, RefreshCw, Ticket, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { PageShell } from "@/components/layout/page-shell";
import { useAdminAccess, type StaffFeature } from "@/hooks/use-admin-access";
import { cn } from "@/lib/utils";
import type { ChannelCalls, NumberCalls } from "@/lib/marketing";
import type { BoardIntake, BoardJob, ContactIndex } from "@/components/dashboard/tech-board/types";
import type { CrmContact, CrmLead } from "@shared/schema";
import { MarketingOverview, type MarketingData } from "@/components/marketing/marketing-overview";
import { MarketingCampaigns } from "@/components/marketing/marketing-campaigns";
import { MarketingTools, isMarketingTool, type MarketingTool } from "@/components/marketing/marketing-tools";
import { MarketingPlaybook } from "@/components/marketing/marketing-playbook";
import { MarketingChannels } from "@/components/marketing/marketing-channels";
import { MarketingReferrals } from "@/components/marketing/marketing-referrals";
import { MarketingVouchers } from "@/components/marketing/marketing-vouchers";
import { MarketingPortalAds } from "@/components/marketing/marketing-portal-ads";

/**
 * Marketing hub — one home for the marketing department:
 *   /marketing            Overview: KPIs, demand trend, funnel, channel attribution
 *   /marketing/campaigns  Campaigns and tracking numbers
 *   /marketing/referrals  Customer referral program (portal: /portal/referrals)
 *   /marketing/vouchers   Percentage-off discount vouchers emailed to customers
 *   /marketing/tools      Review requests, content studio, tracked links, brand kit (?tool=)
 *   /marketing/playbook   Weekly / monthly routine
 *   /marketing/channels   Every existing module marketing works from
 *   /marketing/portal-ads Popup ads on the customer portal (opened from All modules)
 *
 * Everything is computed from data the CRM already records (leads, intakes,
 * jobs, call tracking); nothing here sends a message on its own.
 */

type HubTab = "overview" | "campaigns" | "referrals" | "vouchers" | "tools" | "playbook" | "channels" | "portal-ads";

const TABS: { id: HubTab; label: string; path: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "overview", label: "Overview", path: "/marketing", icon: LayoutDashboard },
  { id: "campaigns", label: "Campaigns", path: "/marketing/campaigns", icon: Megaphone },
  { id: "referrals", label: "Referrals", path: "/marketing/referrals", icon: Gift },
  { id: "vouchers", label: "Vouchers", path: "/marketing/vouchers", icon: Ticket },
  { id: "tools", label: "Tools", path: "/marketing/tools", icon: Wand2 },
  { id: "playbook", label: "Playbook", path: "/marketing/playbook", icon: CheckSquare },
  { id: "channels", label: "All modules", path: "/marketing/channels", icon: LayoutGrid },
];

// Modules with their own URL that live under "All modules" rather than the tab bar.
const MODULE_VIEWS: { id: HubTab; path: string; parent: HubTab }[] = [
  { id: "portal-ads", path: "/marketing/portal-ads", parent: "channels" },
];

const RANGES = [30, 90, 365] as const;

// Intakes are loaded for a full year regardless of the selected range so a
// lead can always find the intake (and UTM campaign) it came from.
const INTAKE_LOOKBACK_DAYS = 365;

const QUERY_OPTIONS = { staleTime: 60_000, refetchOnWindowFocus: true } as const;

export default function MarketingPage() {
  const { can, isAdmin } = useAdminAccess();
  const { userId } = useAuth();
  return <MarketingHubView can={can} isAdmin={isAdmin} storagePrefix={`csd:marketing-playbook:${userId ?? "anonymous"}`} />;
}

/** Provider-free so browser tests can mount it with mocked APIs. */
export function MarketingHubView({
  can,
  isAdmin,
  storagePrefix,
}: {
  can: (feature: StaffFeature) => boolean;
  isAdmin: boolean;
  storagePrefix: string;
}) {
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const moduleView = MODULE_VIEWS.find((view) => view.path === location);
  const tab: HubTab = moduleView?.id ?? TABS.find((t) => t.path === location)?.id ?? "overview";
  const activeTab = moduleView?.parent ?? tab;
  const toolParam = new URLSearchParams(search).get("tool");
  const tool: MarketingTool = isMarketingTool(toolParam) ? toolParam : "reviews";
  const [days, setDays] = useState<number>(30);
  const canViewCalls = can("communications");

  const intakeWindow = useMemo(() => {
    const end = new Date();
    const start = new Date(end.getTime() - INTAKE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    return `startDate=${encodeURIComponent(start.toISOString())}&endDate=${encodeURIComponent(end.toISOString())}`;
  }, []);

  const leadsQuery = useQuery<CrmLead[]>({ queryKey: ["/api/crm/leads"], ...QUERY_OPTIONS });
  const intakesQuery = useQuery<{ intakes: BoardIntake[] }>({ queryKey: [`/api/intake?${intakeWindow}&limit=5000`], ...QUERY_OPTIONS });
  const jobsQuery = useQuery<BoardJob[]>({ queryKey: ["/api/crm/jobs"], ...QUERY_OPTIONS });
  const contactsQuery = useQuery<CrmContact[]>({ queryKey: ["/api/crm/contacts"], ...QUERY_OPTIONS, enabled: tab === "tools" });
  const byChannelQuery = useQuery<ChannelCalls[]>({ queryKey: ["/api/call-tracking/analytics/by-channel"], ...QUERY_OPTIONS, enabled: canViewCalls });
  const byNumberQuery = useQuery<NumberCalls[]>({ queryKey: ["/api/call-tracking/analytics/by-number"], ...QUERY_OPTIONS, enabled: canViewCalls });
  const byDayQuery = useQuery<{ day: string; count: number }[]>({ queryKey: [`/api/call-tracking/analytics/by-day?days=${days}`], ...QUERY_OPTIONS, enabled: canViewCalls });

  const data = useMemo<MarketingData>(() => ({
    leads: leadsQuery.data ?? [],
    intakes: intakesQuery.data?.intakes ?? [],
    jobs: jobsQuery.data ?? [],
    callsByChannel: byChannelQuery.data ?? [],
    callsByDay: byDayQuery.data ?? [],
  }), [leadsQuery.data, intakesQuery.data, jobsQuery.data, byChannelQuery.data, byDayQuery.data]);
  const contacts = useMemo<ContactIndex>(
    () => new Map((contactsQuery.data ?? []).map((contact) => [contact.id, contact])),
    [contactsQuery.data],
  );

  const queries = [leadsQuery, intakesQuery, jobsQuery, ...(tab === "tools" ? [contactsQuery] : []), ...(canViewCalls ? [byChannelQuery, byNumberQuery, byDayQuery] : [])];
  const isLoading = leadsQuery.isLoading || intakesQuery.isLoading;
  const isFetching = queries.some((q) => q.isFetching);
  const error = queries.find((q) => q.error)?.error as Error | undefined;
  const refresh = () => { void Promise.all(queries.map((q) => q.refetch())); };
  const showRange = tab === "overview" || tab === "campaigns";

  return (
    <PageShell>
      <PageHeader
        icon={Megaphone}
        eyebrow="Marketing department"
        title="Marketing Hub"
        description="Where customers come from, which campaigns pay off, and the tools to bring in more."
        actions={
          <Button variant="outline" size="sm" onClick={refresh} disabled={isFetching} aria-label="Refresh marketing data">
            <RefreshCw className={cn("h-4 w-4 sm:mr-1.5", isFetching && "animate-spin")} />
            <span className="max-sm:sr-only">{isFetching ? "Refreshing" : "Refresh"}</span>
          </Button>
        }
      />

      <div className="space-y-4 p-3 sm:p-4 md:p-6" data-testid="marketing-hub">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <nav
            aria-label="Marketing sections"
            className="-mx-3 flex gap-1 overflow-x-auto border-y border-gray-200 bg-white px-3 py-1.5 [scrollbar-width:none] sm:mx-0 sm:rounded-lg sm:border sm:px-1.5"
          >
            {TABS.map((item) => {
              const Icon = item.icon;
              const active = item.id === activeTab;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setLocation(item.path)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors",
                    active ? "bg-csd-red text-white shadow-sm" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
                  )}
                  data-testid={`mkt-tab-${item.id}`}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </button>
              );
            })}
          </nav>
          {showRange && (
            <div role="radiogroup" aria-label="Date range" className="inline-flex self-start rounded-lg border border-gray-200 bg-white p-1 md:self-auto">
              {RANGES.map((range) => (
                <button
                  key={range}
                  type="button"
                  role="radio"
                  aria-checked={days === range}
                  onClick={() => setDays(range)}
                  className={cn(
                    "rounded-md px-3 py-1 text-xs font-medium tabular-nums transition-colors",
                    days === range ? "bg-gray-900 text-white" : "text-gray-600 hover:text-gray-900",
                  )}
                  data-testid={`mkt-range-${range}`}
                >
                  {range === 365 ? "12 months" : `${range} days`}
                </button>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 sm:flex-row sm:items-center sm:justify-between">
            <span className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              Some marketing data could not be loaded: {error.message}
            </span>
            <Button size="sm" variant="outline" className="self-start sm:self-auto" onClick={refresh}>Retry</Button>
          </div>
        )}

        {tab === "overview" && <MarketingOverview data={data} days={days} canViewCalls={canViewCalls} isLoading={isLoading} />}
        {tab === "campaigns" && (
          <MarketingCampaigns data={data} numbers={byNumberQuery.data ?? []} days={days} canViewCalls={canViewCalls} isLoading={isLoading} />
        )}
        {tab === "referrals" && <MarketingReferrals isAdmin={isAdmin} />}
        {tab === "vouchers" && <MarketingVouchers />}
        {tab === "tools" && (
          <MarketingTools
            tool={tool}
            onToolChange={(next) => setLocation(`/marketing/tools?tool=${next}`)}
            jobs={jobsQuery.data ?? []}
            contacts={contacts}
            can={(feature) => can(feature as StaffFeature)}
          />
        )}
        {tab === "playbook" && <MarketingPlaybook storagePrefix={storagePrefix} can={(feature) => can(feature as StaffFeature)} />}
        {tab === "channels" && <MarketingChannels can={can} isAdmin={isAdmin} />}
        {tab === "portal-ads" && <MarketingPortalAds />}
      </div>
    </PageShell>
  );
}
