import { useMemo } from "react";
import { Link } from "wouter";
import { ExternalLink, Hash, Link2, Megaphone, PhoneForwarded } from "lucide-react";
import { Button } from "@/components/ui/button";
import { campaignPerformance, channelLabel, since, type NumberCalls } from "@/lib/marketing";
import { formatPhone } from "@/components/dashboard/tech-board/types";
import type { MarketingData } from "./marketing-overview";
import { MarketingCard, currency } from "./shared";

export function MarketingCampaigns({
  data,
  numbers,
  days,
  canViewCalls,
  isLoading,
}: {
  data: MarketingData;
  numbers: NumberCalls[];
  days: number;
  canViewCalls: boolean;
  isLoading: boolean;
}) {
  const rows = useMemo(() => {
    const now = new Date();
    return campaignPerformance({ leads: since(data.leads, days, now), intakes: since(data.intakes, days, now), numbers });
  }, [data.leads, data.intakes, numbers, days]);
  const untagged = numbers.filter((n) => n.phoneNumber && !n.campaignName?.trim());

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3" data-testid="marketing-campaigns">
      <MarketingCard
        icon={Megaphone}
        title="Campaign performance"
        description={`Leads and requests tagged with a campaign, last ${days} days${canViewCalls ? "; calls all-time per tracking number" : ""}`}
        className="xl:col-span-2"
        bodyClassName="p-0"
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/marketing/tools?tool=utm"><Link2 className="mr-1.5 h-3.5 w-3.5" />Build tracked link</Link>
          </Button>
        }
      >
        {rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-gray-500">
            {isLoading ? "Loading…" : (
              <>
                <p>No campaign-tagged activity yet.</p>
                <p className="mt-1 text-xs">Add <code className="rounded bg-gray-100 px-1">utm_campaign</code> to your links and a campaign name to each tracking number.</p>
              </>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {rows.map((row) => (
              <li key={row.campaign} className="px-4 py-3" data-testid={`mkt-campaign-${row.campaign}`}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-gray-900">{row.campaign}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {row.channels.map((channel) => (
                        <span key={channel} className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700">{channel}</span>
                      ))}
                    </div>
                  </div>
                  <dl className="grid shrink-0 grid-cols-4 gap-3 text-right text-xs sm:gap-5">
                    <Metric label="Leads" value={row.leads} />
                    <Metric label="Won" value={row.won} />
                    <Metric label={canViewCalls ? "Calls" : "Requests"} value={canViewCalls ? row.calls : row.intakes} />
                    <Metric label="Pipeline" value={currency(row.pipelineValue)} />
                  </dl>
                </div>
              </li>
            ))}
          </ul>
        )}
      </MarketingCard>

      <MarketingCard
        icon={PhoneForwarded}
        title="Tracking numbers"
        description="One number per ad, listing or flyer"
        bodyClassName="p-0"
        actions={canViewCalls ? (
          <Button asChild size="sm" variant="outline">
            <Link href="/admin/call-tracking"><ExternalLink className="mr-1.5 h-3.5 w-3.5" />Manage</Link>
          </Button>
        ) : undefined}
      >
        {!canViewCalls ? (
          <p className="px-4 py-8 text-center text-sm text-gray-500">Call tracking requires Communications access.</p>
        ) : numbers.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-gray-500">{isLoading ? "Loading…" : "No tracked calls yet."}</p>
        ) : (
          <>
            {untagged.length > 0 && (
              <p className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800">
                {untagged.length} number{untagged.length === 1 ? " has" : "s have"} no campaign name, so their calls can't be attributed.
              </p>
            )}
            <ul className="divide-y divide-gray-100">
              {numbers.map((number, i) => (
                <li key={`${number.phoneNumber ?? "none"}-${i}`} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium text-gray-900">
                      <Hash className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                      {number.phoneNumber ? formatPhone(number.phoneNumber) : "Main line / untracked"}
                    </p>
                    <p className="truncate text-xs text-gray-500">
                      {[number.campaignName, number.sourceChannel ? channelLabel(number.sourceChannel) : null].filter(Boolean).join(" · ") || "Unattributed"}
                    </p>
                  </div>
                  <div className="shrink-0 text-right text-xs">
                    <p className="font-semibold tabular-nums text-gray-900">{number.totalCalls}</p>
                    <p className="text-gray-400">{number.uniqueCallers} unique</p>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </MarketingCard>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-gray-400">{label}</dt>
      <dd className="font-semibold tabular-nums text-gray-900">{value}</dd>
    </div>
  );
}
