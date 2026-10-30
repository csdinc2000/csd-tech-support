import { useState } from 'react';
import { format, subDays, startOfDay, endOfDay } from 'date-fns';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import {
  getAnalyticsSummary,
  getAnalyticsTimeseries,
  getIvrDistribution,
  getTopNumbers,
  getTechPerformance,
  buildAnalyticsCsvUrl,
} from '../lib/api.js';
import type { User as AppUser } from '../../../types/index.js';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899'];

export function Analytics({ profile }: { profile: AppUser | null }) {
  const today = new Date();
  const [from, setFrom] = useState(format(subDays(today, 30), 'yyyy-MM-dd'));
  const [to, setTo] = useState(format(today, 'yyyy-MM-dd'));

  const fromIso = startOfDay(new Date(from)).toISOString();
  const toIso = endOfDay(new Date(to)).toISOString();

  const { data: summary } = useQuery({ queryKey: ['analytics-summary', from, to], queryFn: () => getAnalyticsSummary(fromIso, toIso) });
  const { data: ts } = useQuery({ queryKey: ['analytics-ts', from, to], queryFn: () => getAnalyticsTimeseries(fromIso, toIso, 'day') });
  const { data: ivrDist = [] } = useQuery({ queryKey: ['analytics-ivr', from, to], queryFn: () => getIvrDistribution(fromIso, toIso) });
  const { data: topNumbers = [] } = useQuery({ queryKey: ['analytics-top', from, to], queryFn: () => getTopNumbers(fromIso, toIso) });
  const { data: techs = [] } = useQuery({
    queryKey: ['analytics-tech', from, to],
    queryFn: () => getTechPerformance(fromIso, toIso),
    enabled: profile?.role === 'owner',
  });

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-white mb-1">Analytics</h1>
          <p className="text-sm text-gray-500">Call patterns and performance for the selected window.</p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
          </div>
          <a
            href={buildAnalyticsCsvUrl(fromIso, toIso)}
            className="bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white text-sm px-3 py-1.5 rounded"
          >
            Export CSV
          </a>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-6">
        <Kpi label="Total calls" value={summary?.total_calls ?? '—'} />
        <Kpi label="Answered %" value={summary ? `${summary.answered_pct}%` : '—'} accent="green" />
        <Kpi label="Missed %" value={summary ? `${summary.missed_pct}%` : '—'} accent={summary && summary.missed_pct > 25 ? 'red' : undefined} />
        <Kpi label="Avg duration" value={summary ? fmtSec(summary.avg_duration_seconds) : '—'} />
        <Kpi label="Voicemails" value={summary?.voicemails ?? '—'} />
        <Kpi label="Outbound" value={summary?.outbound_total ?? '—'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <ChartCard title="Calls per day">
          {ts && ts.points.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={ts.points}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="bucket" stroke="#6b7280" fontSize={11} />
                <YAxis stroke="#6b7280" fontSize={11} />
                <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar stackId="a" dataKey="inbound_answered" fill="#10b981" name="Inbound answered" />
                <Bar stackId="a" dataKey="inbound_missed" fill="#ef4444" name="Inbound missed" />
                <Bar stackId="a" dataKey="outbound" fill="#3b82f6" name="Outbound" />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty />}
        </ChartCard>

        <ChartCard title="Hour-of-day heatmap">
          {ts && ts.hour_of_day.some((h) => h.calls > 0) ? (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={ts.hour_of_day}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="hour" stroke="#6b7280" fontSize={11} />
                <YAxis stroke="#6b7280" fontSize={11} />
                <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151' }} />
                <Line type="monotone" dataKey="calls" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : <Empty />}
        </ChartCard>

        <ChartCard title="IVR option distribution">
          {ivrDist.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={ivrDist}
                  dataKey="count"
                  nameKey="selection"
                  cx="50%"
                  cy="50%"
                  outerRadius={90}
                  label={({ selection, count }) => `${selection}: ${count}`}
                  fontSize={11}
                >
                  {ivrDist.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ background: '#111827', border: '1px solid #374151' }} />
              </PieChart>
            </ResponsiveContainer>
          ) : <Empty />}
        </ChartCard>

        <ChartCard title="Top inbound numbers">
          <div className="overflow-y-auto max-h-[260px]">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 sticky top-0 bg-gray-900">
                <tr><th className="text-left px-2 py-1.5">Number</th><th className="text-left px-2 py-1.5">Calls</th><th className="text-left px-2 py-1.5">Last call</th></tr>
              </thead>
              <tbody>
                {topNumbers.length === 0 && <tr><td colSpan={3} className="text-center text-gray-600 py-6 text-sm">No data</td></tr>}
                {topNumbers.map((t) => (
                  <tr key={t.number} className="border-b border-gray-800 last:border-0">
                    <td className="px-2 py-1.5 font-mono text-xs text-gray-300">{t.number}</td>
                    <td className="px-2 py-1.5 text-gray-300">{t.count}</td>
                    <td className="px-2 py-1.5 text-gray-500 text-xs">{format(new Date(t.last_call), 'MMM d HH:mm')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>
      </div>

      {profile?.role === 'owner' && (
        <ChartCard title="Tech performance (owner-only)">
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500">
              <tr>
                <th className="text-left px-2 py-1.5">Tech</th>
                <th className="text-left px-2 py-1.5">Calls handled</th>
                <th className="text-left px-2 py-1.5">Avg duration</th>
                <th className="text-left px-2 py-1.5">Voicemails returned</th>
              </tr>
            </thead>
            <tbody>
              {techs.length === 0 && <tr><td colSpan={4} className="text-center text-gray-600 py-6 text-sm">No data</td></tr>}
              {techs.map((t) => (
                <tr key={t.user_id} className="border-b border-gray-800 last:border-0">
                  <td className="px-2 py-1.5 text-gray-300">{t.full_name || t.email}</td>
                  <td className="px-2 py-1.5 text-gray-300">{t.calls_handled}</td>
                  <td className="px-2 py-1.5 text-gray-300">{fmtSec(t.avg_duration_seconds)}</td>
                  <td className="px-2 py-1.5 text-gray-300">{t.voicemails_returned}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ChartCard>
      )}
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string | number; accent?: 'green' | 'red' }) {
  const color = accent === 'green' ? 'text-green-400' : accent === 'red' ? 'text-red-400' : 'text-white';
  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 px-4 py-3">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Empty() {
  return <div className="text-center text-gray-600 text-sm py-12">No data in this date range</div>;
}

function fmtSec(s: number): string {
  if (!s) return '0s';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}
