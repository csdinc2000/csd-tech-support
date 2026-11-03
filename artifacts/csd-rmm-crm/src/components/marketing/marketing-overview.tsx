import { useMemo } from "react";
import { format, parseISO } from "date-fns";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DollarSign, Filter, Inbox, LineChart as LineChartIcon, PhoneCall, Target, TrendingUp, Trophy, UserPlus } from "lucide-react";
import {
  buildAttribution,
  dailyTrend,
  leadFunnel,
  since,
  type ChannelCalls,
  type MarketingIntake,
  type MarketingJob,
  type MarketingLead,
} from "@/lib/marketing";
import { MarketingCard, StatTile, currency, percent } from "./shared";

// Validated categorical slots 1–3 (blue, orange, aqua). Identity is never
// color-alone: the legend names each series with its total, and the tooltip
// and attribution table carry the numbers.
const SERIES = [
  { key: "leads", label: "Leads", color: "#2a78d6" },
  { key: "intakes", label: "Service requests", color: "#eb6834" },
  { key: "calls", label: "Tracked calls", color: "#1baf7a" },
] as const;

export type MarketingData = {
  leads: MarketingLead[];
  intakes: MarketingIntake[];
  jobs: MarketingJob[];
  callsByChannel: ChannelCalls[];
  callsByDay: { day: string; count: number }[];
};

export function MarketingOverview({
  data,
  days,
  canViewCalls,
  isLoading,
}: {
  data: MarketingData;
  days: number;
  canViewCalls: boolean;
  isLoading: boolean;
}) {
  const now = useMemo(() => new Date(), [data]);
  const leads = useMemo(() => since(data.leads, days, now), [data.leads, days, now]);
  const intakes = useMemo(() => since(data.intakes, days, now), [data.intakes, days, now]);
  const attribution = useMemo(
    () => buildAttribution({ leads, intakes, calls: data.callsByChannel, jobs: data.jobs }),
    [leads, intakes, data.callsByChannel, data.jobs],
  );
  const funnel = useMemo(() => leadFunnel(leads), [leads]);
  const trend = useMemo(
    () => dailyTrend({ leads, intakes, callsByDay: data.callsByDay, days: Math.min(days, 90), now }),
    [leads, intakes, data.callsByDay, days, now],
  );

  const won = leads.filter((lead) => lead.status === "won").length;
  const closed = won + leads.filter((lead) => lead.status === "lost").length;
  const pipeline = attribution.reduce((sum, row) => sum + row.pipelineValue, 0);
  const revenue = attribution.reduce((sum, row) => sum + row.revenue, 0);
  const trackedCalls = data.callsByDay.reduce((sum, entry) => sum + entry.count, 0);
  const totals = { leads: leads.length, intakes: intakes.length, calls: trackedCalls };
  const dash = (value: React.ReactNode) => (isLoading ? "–" : value);

  return (
    <div className="space-y-4" data-testid="marketing-overview">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 xl:grid-cols-6">
        <StatTile icon={UserPlus} label="New leads" value={dash(leads.length)} hint={`Last ${days} days`} testId="mkt-stat-leads" />
        <StatTile icon={Inbox} label="Service requests" value={dash(intakes.length)} hint="Intake forms & voice" testId="mkt-stat-intakes" />
        <StatTile icon={PhoneCall} label="Tracked calls" value={canViewCalls ? dash(trackedCalls) : "—"} hint={canViewCalls ? "All tracking numbers" : "Needs Communications"} testId="mkt-stat-calls" />
        <StatTile icon={Trophy} label="Close rate" value={dash(percent(closed ? won / closed : null))} hint={`${won} won of ${closed} closed`} testId="mkt-stat-close" />
        <StatTile icon={Target} label="Open pipeline" value={dash(currency(pipeline))} hint="Estimated, open leads" testId="mkt-stat-pipeline" />
        <StatTile icon={DollarSign} label="Lead revenue" value={dash(currency(revenue))} hint="Completed jobs from leads" testId="mkt-stat-revenue" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MarketingCard
          icon={LineChartIcon}
          title="Demand trend"
          description={days > 90 ? "Daily, last 90 days" : `Daily, last ${days} days`}
          className="lg:col-span-2"
          testId="mkt-trend"
        >
          <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-700" aria-label="Chart legend">
            {SERIES.filter((s) => s.key !== "calls" || canViewCalls).map((series) => (
              <li key={series.key} className="flex items-center gap-1.5">
                <span className="h-0.5 w-4 rounded-full" style={{ backgroundColor: series.color }} aria-hidden="true" />
                {series.label}
                <span className="font-semibold tabular-nums text-gray-900">{totals[series.key]}</span>
              </li>
            ))}
          </ul>
          <div className="h-56 sm:h-64" role="img" aria-label={`Daily leads, service requests${canViewCalls ? " and tracked calls" : ""}`}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid vertical={false} stroke="#eceae4" />
                <XAxis
                  dataKey="day"
                  tickFormatter={(day: string) => format(parseISO(day), "MMM d")}
                  tick={{ fontSize: 11, fill: "#6b7280" }}
                  tickLine={false}
                  axisLine={{ stroke: "#e5e7eb" }}
                  minTickGap={24}
                />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#6b7280" }} tickLine={false} axisLine={false} width={40} />
                <Tooltip
                  labelFormatter={(day: string) => format(parseISO(day), "EEE, MMM d")}
                  contentStyle={{ borderRadius: 8, borderColor: "#e5e7eb", fontSize: 12 }}
                  cursor={{ stroke: "#9ca3af", strokeDasharray: "3 3" }}
                />
                {SERIES.filter((s) => s.key !== "calls" || canViewCalls).map((series) => (
                  <Line
                    key={series.key}
                    type="linear"
                    dataKey={series.key}
                    name={series.label}
                    stroke={series.color}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </MarketingCard>

        <MarketingCard icon={Filter} title="Lead funnel" description={`${funnel.lost} lost in this period`} testId="mkt-funnel">
          <ol className="space-y-3">
            {funnel.stages.map((stage) => (
              <li key={stage.id}>
                <div className="mb-1 flex items-baseline justify-between text-xs">
                  <span className="font-medium text-gray-700">{stage.label}</span>
                  <span className="tabular-nums text-gray-500">
                    <span className="font-semibold text-gray-900">{stage.reached}</span> · {percent(stage.rate)}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                  <div className="h-full rounded-full bg-csd-red" style={{ width: `${Math.max(stage.rate * 100, stage.reached ? 2 : 0)}%` }} />
                </div>
              </li>
            ))}
          </ol>
        </MarketingCard>
      </div>

      <MarketingCard
        icon={TrendingUp}
        title="Channel attribution"
        description={canViewCalls ? "Leads and requests in this period; calls are all-time per channel" : "Leads and service requests in this period"}
        bodyClassName="p-0"
        testId="mkt-attribution"
      >
        {attribution.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-gray-500">{isLoading ? "Loading…" : "No marketing activity in this period yet."}</p>
        ) : (
          <>
            {/* Phones: one card per channel. */}
            <ul className="divide-y divide-gray-100 md:hidden">
              {attribution.map((row) => (
                <li key={row.channel} className="px-4 py-3" data-testid={`mkt-channel-${row.channel}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-gray-900">{row.channel}</span>
                    <span className="text-xs text-gray-500">{row.touches} {row.touches === 1 ? "touch" : "touches"}</span>
                  </div>
                  <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                    <MobileFact label="Leads" value={row.leads} />
                    <MobileFact label="Won" value={`${row.won} · ${percent(row.winRate)}`} />
                    <MobileFact label="Revenue" value={currency(row.revenue)} />
                    <MobileFact label="Requests" value={row.intakes} />
                    {canViewCalls && <MobileFact label="Calls" value={row.calls} />}
                    <MobileFact label="Pipeline" value={currency(row.pipelineValue)} />
                  </dl>
                </li>
              ))}
            </ul>
            {/* Tablet and up: a full table. */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                  <tr>
                    <th className="px-4 py-2">Channel</th>
                    <th className="px-3 py-2 text-right">Leads</th>
                    <th className="px-3 py-2 text-right">Won</th>
                    <th className="px-3 py-2 text-right">Win rate</th>
                    <th className="px-3 py-2 text-right">Requests</th>
                    {canViewCalls && <th className="px-3 py-2 text-right">Calls</th>}
                    <th className="px-3 py-2 text-right">Pipeline</th>
                    <th className="px-4 py-2 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 tabular-nums">
                  {attribution.map((row) => (
                    <tr key={row.channel} className="hover:bg-gray-50" data-testid={`mkt-channel-row-${row.channel}`}>
                      <td className="px-4 py-2.5 font-medium text-gray-900">{row.channel}</td>
                      <td className="px-3 py-2.5 text-right">{row.leads}</td>
                      <td className="px-3 py-2.5 text-right">{row.won}</td>
                      <td className="px-3 py-2.5 text-right">{percent(row.winRate)}</td>
                      <td className="px-3 py-2.5 text-right">{row.intakes}</td>
                      {canViewCalls && <td className="px-3 py-2.5 text-right">{row.calls}</td>}
                      <td className="px-3 py-2.5 text-right">{currency(row.pipelineValue)}</td>
                      <td className="px-4 py-2.5 text-right font-semibold text-gray-900">{currency(row.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </MarketingCard>
    </div>
  );
}

function MobileFact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wider text-gray-400">{label}</dt>
      <dd className="truncate font-semibold tabular-nums text-gray-800">{value}</dd>
    </div>
  );
}
