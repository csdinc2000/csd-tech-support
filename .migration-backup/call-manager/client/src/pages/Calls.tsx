import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Link } from 'react-router-dom';
import { listCalls, buildCsvExportUrl } from '../lib/api.js';
import type { CallListParams, Call } from '../../../types/index.js';

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

const STATUSES = ['', 'queued', 'ringing', 'in-progress', 'completed', 'busy', 'no-answer', 'failed', 'canceled'];
const LIMIT = 50;

export function Calls() {
  const [params, setParams] = useState<CallListParams & { page: number }>({ page: 1, limit: LIMIT });
  const [search, setSearch] = useState('');
  const [direction, setDirection] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const queryParams: CallListParams = {
    page: params.page,
    limit: LIMIT,
    search: search || undefined,
    direction: (direction as CallListParams['direction']) || undefined,
    status: (status as CallListParams['status']) || undefined,
    from: from || undefined,
    to: to || undefined,
  };

  const { data, isLoading } = useQuery({
    queryKey: ['calls', queryParams],
    queryFn: () => listCalls(queryParams),
  });

  const calls = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / LIMIT);

  const applyFilters = () => setParams(p => ({ ...p, page: 1 }));
  const resetFilters = () => {
    setSearch(''); setDirection(''); setStatus(''); setFrom(''); setTo('');
    setParams({ page: 1, limit: LIMIT });
  };

  const csvUrl = buildCsvExportUrl(queryParams);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold text-white">Call Log</h1>
        <a
          href={csvUrl}
          className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
        >
          ↓ Export CSV
        </a>
      </div>

      {/* Filters */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 mb-4">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <input
            type="text"
            placeholder="Search number / name / ticket"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && applyFilters()}
            className="col-span-2 md:col-span-3 lg:col-span-2 input"
          />
          <select value={direction} onChange={e => setDirection(e.target.value)} className="input">
            <option value="">All directions</option>
            <option value="inbound">Inbound</option>
            <option value="outbound">Outbound</option>
          </select>
          <select value={status} onChange={e => setStatus(e.target.value)} className="input">
            {STATUSES.map(s => <option key={s} value={s}>{s || 'All statuses'}</option>)}
          </select>
          <input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} className="input" title="From date" />
          <input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} className="input" title="To date" />
        </div>
        <div className="flex gap-2 mt-3">
          <button onClick={applyFilters} className="btn-primary text-xs px-3 py-1.5">Apply</button>
          <button onClick={resetFilters} className="btn-secondary text-xs px-3 py-1.5">Reset</button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500 border-b border-gray-800 bg-gray-900">
              <th className="px-4 py-2.5 text-left font-medium">Time</th>
              <th className="px-4 py-2.5 text-left font-medium">Dir</th>
              <th className="px-4 py-2.5 text-left font-medium">From</th>
              <th className="px-4 py-2.5 text-left font-medium">To</th>
              <th className="px-4 py-2.5 text-left font-medium">Status</th>
              <th className="px-4 py-2.5 text-left font-medium">Dur</th>
              <th className="px-4 py-2.5 text-left font-medium">IVR</th>
              <th className="px-4 py-2.5 text-left font-medium">Customer</th>
              <th className="px-4 py-2.5 text-left font-medium">Ticket</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-600">Loading…</td></tr>
            )}
            {!isLoading && calls.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-600">No calls match the current filters</td></tr>
            )}
            {calls.map((call: Call) => (
              <tr key={call.id} className="border-b border-gray-800 last:border-0 hover:bg-gray-800/60 transition-colors cursor-pointer">
                <td className="px-4 py-2.5 text-gray-400 whitespace-nowrap">
                  <Link to={`/calls/${call.id}`} className="block">
                    {format(new Date(call.started_at), 'MM/dd HH:mm')}
                  </Link>
                </td>
                <td className="px-4 py-2.5">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${call.direction === 'inbound' ? 'bg-blue-900 text-blue-300' : 'bg-purple-900 text-purple-300'}`}>
                    {call.direction === 'inbound' ? '↙' : '↗'} {call.direction}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-gray-300 font-mono text-xs whitespace-nowrap">{call.from_number}</td>
                <td className="px-4 py-2.5 text-gray-300 font-mono text-xs whitespace-nowrap">{call.to_number}</td>
                <td className="px-4 py-2.5"><StatusBadge status={call.status} /></td>
                <td className="px-4 py-2.5 text-gray-400 text-xs">{fmt(call.duration_seconds)}</td>
                <td className="px-4 py-2.5 text-gray-500 text-xs">{call.ivr_selection ?? '—'}</td>
                <td className="px-4 py-2.5 text-gray-400 text-xs truncate max-w-[100px]">{call.customer_name ?? '—'}</td>
                <td className="px-4 py-2.5 text-gray-400 text-xs">{call.ticket_number ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-4 text-sm text-gray-500">
        <span>{total} total calls</span>
        <div className="flex gap-2">
          <button
            disabled={params.page <= 1}
            onClick={() => setParams(p => ({ ...p, page: p.page - 1 }))}
            className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed text-gray-300 transition-colors"
          >
            ← Prev
          </button>
          <span className="px-2 py-1">Page {params.page} of {Math.max(1, totalPages)}</span>
          <button
            disabled={params.page >= totalPages}
            onClick={() => setParams(p => ({ ...p, page: p.page + 1 }))}
            className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed text-gray-300 transition-colors"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}
