import { useEffect, useMemo, useState } from 'react';
import {
  listAiCampaigns, getAiCampaign, createAiCampaign, setAiCampaignStatus,
  deleteAiCampaign, listAiAssistants,
} from '../lib/api.js';
import type { OutboundCampaign, CampaignCall, AiAssistant } from '../../../types/index.js';

export function AiCampaigns() {
  const [items, setItems] = useState<OutboundCampaign[]>([]);
  const [assistants, setAssistants] = useState<AiAssistant[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [assistantId, setAssistantId] = useState('');
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('20:00');
  const [rate, setRate] = useState(30);
  const [csv, setCsv] = useState('');
  const [selected, setSelected] = useState<(OutboundCampaign & { calls: CampaignCall[] }) | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      const [c, a] = await Promise.all([listAiCampaigns(), listAiAssistants()]);
      setItems(c.items); setAssistants(a.items.filter(x => x.is_active));
      if (a.items.length && !assistantId) setAssistantId(a.items[0].id);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Load failed'); }
  }
  useEffect(() => { refresh(); }, []);

  const targets = useMemo(() => {
    return csv.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
      const [phone, customer_name] = line.split(',').map(s => s?.trim());
      return { phone_number: phone, customer_name: customer_name || undefined };
    }).filter(t => t.phone_number);
  }, [csv]);

  async function create() {
    setErr(null);
    if (!name || !assistantId || targets.length === 0) { setErr('Name, assistant, and at least one target are required.'); return; }
    try {
      await createAiCampaign({ name, assistant_id: assistantId, call_window_start: start, call_window_end: end, max_calls_per_hour: rate, targets });
      setCreating(false); setName(''); setCsv(''); await refresh();
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Create failed';
      setErr(m);
    }
  }

  async function changeStatus(id: string, status: OutboundCampaign['status']) {
    try { await setAiCampaignStatus(id, status); await refresh(); if (selected?.id === id) view(id); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Status change failed'); }
  }

  async function view(id: string) {
    const c = await getAiCampaign(id); setSelected(c);
  }

  async function remove(id: string) {
    if (!confirm('Delete this campaign and all per-call rows?')) return;
    await deleteAiCampaign(id); setSelected(null); await refresh();
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold">Outbound AI Campaigns</h1>
        <button onClick={() => setCreating(true)} className="px-3 py-1.5 bg-brand-600 hover:bg-brand-500 rounded text-sm">+ New campaign</button>
      </div>

      <div className="mb-4 p-3 bg-blue-900/20 border border-blue-700/40 rounded text-blue-100 text-xs">
        <b>Compliance:</b> DNC checks are mandatory and cannot be disabled. Calls only run between 8am–9pm in the
        called party's local time zone (TCPA). Each number is called at most once per 7 days unless explicitly
        marked as <code>owner_override</code>.
      </div>

      {err && <div className="mb-3 p-2 bg-red-900/40 border border-red-700/50 rounded text-red-200 text-sm">{err}</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded">
          <table className="w-full text-sm">
            <thead className="text-left text-gray-400 border-b border-gray-800">
              <tr><th className="p-3">Name</th><th className="p-3">Status</th><th className="p-3">Window</th><th className="p-3 text-right">Actions</th></tr>
            </thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-gray-500">No campaigns yet.</td></tr>}
              {items.map(c => (
                <tr key={c.id} className={`border-t border-gray-800 ${selected?.id === c.id ? 'bg-gray-800/50' : ''}`}>
                  <td className="p-3"><button onClick={() => view(c.id)} className="text-brand-400 hover:text-brand-300">{c.name}</button></td>
                  <td className="p-3"><StatusBadge status={c.status} /></td>
                  <td className="p-3 text-xs text-gray-400">{c.call_window_start.slice(0, 5)}–{c.call_window_end.slice(0, 5)}</td>
                  <td className="p-3 text-right space-x-1.5 text-xs">
                    {c.status === 'draft' && <button onClick={() => changeStatus(c.id, 'running')} className="text-green-400 hover:text-green-300">Start</button>}
                    {c.status === 'running' && <button onClick={() => changeStatus(c.id, 'paused')} className="text-yellow-400 hover:text-yellow-300">Pause</button>}
                    {c.status === 'paused' && <button onClick={() => changeStatus(c.id, 'running')} className="text-green-400 hover:text-green-300">Resume</button>}
                    <button onClick={() => remove(c.id)} className="text-red-400 hover:text-red-300">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded p-4 text-sm min-h-[20rem]">
          {!selected && <div className="text-gray-500 text-center py-8">Select a campaign to see per-call status.</div>}
          {selected && (
            <>
              <div className="mb-3"><b>{selected.name}</b> — <StatusBadge status={selected.status} /></div>
              <div className="text-xs text-gray-400 mb-3">{selected.calls.length} calls • {selected.calls.filter(c => c.status === 'completed').length} completed • {selected.calls.filter(c => c.status === 'dnc_blocked').length} DNC blocked • {selected.calls.filter(c => c.status === 'cooldown_blocked').length} cooldown</div>
              <div className="max-h-96 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="text-left text-gray-500"><tr><th className="py-1">Phone</th><th>Status</th><th>Reason</th></tr></thead>
                  <tbody>
                    {selected.calls.map(cc => (
                      <tr key={cc.id} className="border-t border-gray-800/50">
                        <td className="py-1">{cc.phone_number}</td>
                        <td><StatusBadge status={cc.status} /></td>
                        <td className="text-gray-500 truncate max-w-xs">{cc.failure_reason ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      {creating && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded max-w-xl w-full max-h-[90vh] overflow-auto">
            <div className="p-4 border-b border-gray-800 flex items-baseline justify-between"><h2 className="font-semibold">New campaign</h2><button onClick={() => setCreating(false)} className="text-gray-500">✕</button></div>
            <div className="p-4 space-y-3 text-sm">
              <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1.5" /></Field>
              <Field label="Assistant (must be active)">
                <select value={assistantId} onChange={e => setAssistantId(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1.5">
                  <option value="">— select —</option>
                  {assistants.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Window start"><input type="time" min="08:00" max="20:59" value={start} onChange={e => setStart(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1.5" /></Field>
                <Field label="Window end"><input type="time" min="08:01" max="21:00" value={end} onChange={e => setEnd(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1.5" /></Field>
                <Field label="Max/hour"><input type="number" min={1} max={500} value={rate} onChange={e => setRate(parseInt(e.target.value, 10) || 30)} className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1.5" /></Field>
              </div>
              <Field label="Targets (one per line: phone[,name])">
                <textarea value={csv} onChange={e => setCsv(e.target.value)} placeholder="+15555550100,Jane Doe" className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1.5 h-32 font-mono text-xs" />
                <div className="text-xs text-gray-500 mt-1">{targets.length} parsed</div>
              </Field>
            </div>
            <div className="p-4 border-t border-gray-800 flex justify-end gap-2">
              <button onClick={() => setCreating(false)} className="px-3 py-1.5 text-sm text-gray-400">Cancel</button>
              <button onClick={create} className="px-3 py-1.5 text-sm bg-brand-600 hover:bg-brand-500 rounded">Create (draft)</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-700/50 text-gray-300',
    running: 'bg-green-700/50 text-green-200',
    paused: 'bg-yellow-700/50 text-yellow-200',
    completed: 'bg-blue-700/50 text-blue-200',
    pending: 'bg-gray-700/50 text-gray-300',
    dialing: 'bg-blue-700/50 text-blue-200',
    failed: 'bg-red-700/50 text-red-200',
    dnc_blocked: 'bg-red-700/50 text-red-200',
    cooldown_blocked: 'bg-orange-700/50 text-orange-200',
    outside_hours: 'bg-yellow-700/50 text-yellow-200',
  };
  return <span className={`px-1.5 py-0.5 rounded text-xs ${colors[status] ?? 'bg-gray-700'}`}>{status.replace(/_/g, ' ')}</span>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="block text-xs text-gray-400 mb-1">{label}</label>{children}</div>;
}
