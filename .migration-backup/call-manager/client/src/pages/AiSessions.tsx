import { useEffect, useState } from 'react';
import { listAiSessions, getAiSession } from '../lib/api.js';
import type { AiCallSession } from '../../../types/index.js';

interface TranscriptTurn { role?: string; message?: string; content?: string; text?: string }

export function AiSessions() {
  const [items, setItems] = useState<AiCallSession[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AiCallSession | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true); setErr(null);
    try {
      const r = await listAiSessions(search.trim() || undefined);
      setItems(r.items);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load sessions');
    } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); }, []);

  async function open(id: string) {
    setErr(null);
    try {
      const s = await getAiSession(id);
      setSelected(s);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load session');
    }
  }

  const turns = (selected?.transcript as TranscriptTurn[] | undefined) ?? [];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-xl font-semibold mb-4">AI Call Sessions</h1>

      {err && <div className="mb-3 p-2 bg-red-900/40 border border-red-700/50 rounded text-red-200 text-sm">{err}</div>}

      <div className="flex gap-2 mb-4">
        <input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && refresh()} placeholder="Search summary or customer name…" className="flex-1 bg-gray-950 border border-gray-800 rounded px-3 py-2 text-sm" />
        <button onClick={refresh} className="px-3 py-2 bg-brand-600 hover:bg-brand-500 rounded text-sm">Search</button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <div className="md:col-span-2 bg-gray-900 border border-gray-800 rounded">
          <table className="w-full text-sm">
            <thead className="text-left text-gray-400 border-b border-gray-800"><tr><th className="p-2">When</th><th className="p-2">Outcome</th><th className="p-2">Cost</th></tr></thead>
            <tbody>
              {loading && <tr><td colSpan={3} className="p-6 text-center text-gray-500">Loading…</td></tr>}
              {!loading && items.length === 0 && <tr><td colSpan={3} className="p-6 text-center text-gray-500">No sessions yet.</td></tr>}
              {items.map(s => (
                <tr key={s.id} className={`border-t border-gray-800 cursor-pointer hover:bg-gray-800/50 ${selected?.id === s.id ? 'bg-gray-800/70' : ''}`} onClick={() => open(s.id)}>
                  <td className="p-2 text-xs text-gray-300">{new Date(s.created_at).toLocaleString()}</td>
                  <td className="p-2 text-xs">{s.outcome ?? '—'}</td>
                  <td className="p-2 text-xs text-gray-400">{s.cost_cents != null ? `$${(s.cost_cents / 100).toFixed(2)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="md:col-span-3 bg-gray-900 border border-gray-800 rounded p-4 text-sm min-h-[20rem]">
          {!selected && <div className="text-gray-500 text-center py-8">Select a session to view its transcript.</div>}
          {selected && (
            <>
              <div className="mb-2 flex items-baseline gap-3">
                <b>{selected.outcome ?? 'completed'}</b>
                <span className="text-xs text-gray-500">{selected.duration_sec ? `${selected.duration_sec}s` : ''}</span>
                <span className="text-xs text-gray-500 ml-auto">{new Date(selected.created_at).toLocaleString()}</span>
              </div>
              {selected.summary && <div className="mb-3 p-2 bg-gray-950 rounded text-xs text-gray-300"><b>Summary:</b> {selected.summary}</div>}
              {selected.extracted_data && (
                <div className="mb-3 p-2 bg-gray-950 rounded text-xs">
                  <b>Extracted:</b>
                  <pre className="mt-1 text-gray-400 whitespace-pre-wrap">{JSON.stringify(selected.extracted_data, null, 2)}</pre>
                </div>
              )}
              <div className="space-y-2 max-h-96 overflow-auto">
                {turns.length === 0 && <div className="text-xs text-gray-500">No transcript stored.</div>}
                {turns.map((t, i) => (
                  <div key={i} className={`p-2 rounded text-xs ${t.role === 'user' ? 'bg-blue-900/20 border-l-2 border-blue-700' : 'bg-gray-800/50 border-l-2 border-gray-700'}`}>
                    <div className="text-gray-500 font-mono">{t.role ?? 'turn'}</div>
                    <div className="text-gray-200 mt-0.5">{t.message ?? t.content ?? t.text ?? ''}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
