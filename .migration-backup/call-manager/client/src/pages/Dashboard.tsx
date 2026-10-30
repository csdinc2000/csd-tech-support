import { useQuery } from '@tanstack/react-query';
import { format, startOfDay, endOfDay } from 'date-fns';
import { Link } from 'react-router-dom';
import { listCalls } from '../lib/api.js';
import type { Call } from '../../../types/index.js';

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    completed: 'bg-green-900 text-green-300',
    'in-progress': 'bg-blue-900 text-blue-300',
    'no-answer': 'bg-yellow-900 text-yellow-300',
    busy: 'bg-orange-900 text-orange-300',
    failed: 'bg-red-900 text-red-300',
    canceled: 'bg-gray-700 text-gray-400',
    ringing: 'bg-purple-900 text-purple-300',
    queued: 'bg-gray-700 text-gray-400',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${colors[status] ?? 'bg-gray-700 text-gray-400'}`}>
      {status}
    </span>
  );
}

function fmt(sec: number | null): string {
  if (!sec) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function Dashboard() {
  const today = new Date();
  const todayStart = startOfDay(today).toISOString();
  const todayEnd = endOfDay(today).toISOString();

  const { data: todayData } = useQuery({
    queryKey: ['calls', 'today'],
    queryFn: () => listCalls({ from: todayStart, to: todayEnd, limit: 200 }),
    refetchInterval: 30_000,
  });

  const { data: recentData } = useQuery({
    queryKey: ['calls', 'recent'],
    queryFn: () => listCalls({ limit: 10 }),
    refetchInterval: 15_000,
  });

  const todayCalls = todayData?.data ?? [];
  const missed = todayCalls.filter(c => ['no-answer', 'busy', 'failed'].includes(c.status)).length;
  const completed = todayCalls.filter(c => c.status === 'completed');
  const avgDur = completed.length
    ? Math.round(completed.reduce((s, c) => s + (c.duration_seconds ?? 0), 0) / completed.length)
    : null;

  const recent = recentData?.data ?? [];

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-white">Dashboard</h1>
        <p className="text-sm text-gray-500">{format(today, 'EEEE, MMMM d, yyyy')}</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <StatCard label="Total calls today" value={String(todayCalls.length)} />
        <StatCard label="Missed / no-answer" value={String(missed)} accent={missed > 0 ? 'red' : undefined} />
        <StatCard label="Avg call duration" value={fmt(avgDur)} />
      </div>

      {/* Recent calls */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Recent Calls</h2>
          <Link to="/calls" className="text-xs text-brand-500 hover:text-brand-400">View all →</Link>
        </div>

        <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 border-b border-gray-800">
                <th className="px-4 py-2.5 text-left font-medium">Time</th>
                <th className="px-4 py-2.5 text-left font-medium">Dir</th>
                <th className="px-4 py-2.5 text-left font-medium">From</th>
                <th className="px-4 py-2.5 text-left font-medium">To</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5 text-left font-medium">Duration</th>
                <th className="px-4 py-2.5 text-left font-medium">IVR</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-600 text-sm">No calls yet</td>
                </tr>
              )}
              {recent.map((call: Call) => (
                <tr
                  key={call.id}
                  className="border-b border-gray-800 last:border-0 hover:bg-gray-800 transition-colors cursor-pointer"
                >
                  <td className="px-4 py-2.5 text-gray-400">
                    <Link to={`/calls/${call.id}`} className="block">
                      {format(new Date(call.started_at), 'MMM d HH:mm')}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${call.direction === 'inbound' ? 'bg-blue-900 text-blue-300' : 'bg-purple-900 text-purple-300'}`}>
                      {call.direction === 'inbound' ? '↙ in' : '↗ out'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-300 font-mono text-xs">{call.from_number}</td>
                  <td className="px-4 py-2.5 text-gray-300 font-mono text-xs">{call.to_number}</td>
                  <td className="px-4 py-2.5"><StatusBadge status={call.status} /></td>
                  <td className="px-4 py-2.5 text-gray-400">{fmt(call.duration_seconds)}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-xs">{call.ivr_selection ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: 'red' }) {
  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 px-5 py-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-3xl font-bold ${accent === 'red' ? 'text-red-400' : 'text-white'}`}>{value}</div>
    </div>
  );
}
