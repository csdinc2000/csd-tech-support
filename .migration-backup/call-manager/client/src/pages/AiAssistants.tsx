import { useEffect, useState } from 'react';
import {
  listAiAssistants, createAiAssistant, updateAiAssistant, deleteAiAssistant,
  testCallAssistant, getAiSpend, setAiSpendCap,
} from '../lib/api.js';
import type { AiAssistant, AiTool, AiSpend } from '../../../types/index.js';

const VOICES = ['jennifer', 'rachel', 'sarah', 'antoni', 'josh', 'adam'];
const MODELS = ['gpt-4o-mini', 'gpt-4o', 'claude-3-5-sonnet'];
const ALL_TOOLS: AiTool[] = ['transfer_to_human', 'check_business_hours', 'schedule_callback', 'lookup_ticket'];

const empty: Partial<AiAssistant> = {
  name: '', purpose: 'custom', system_prompt: '', first_message: '',
  voice_id: 'jennifer', model: 'gpt-4o-mini',
  tools_enabled: ['transfer_to_human', 'check_business_hours'],
  is_active: false,
};

export function AiAssistants() {
  const [items, setItems] = useState<AiAssistant[]>([]);
  const [vapiOk, setVapiOk] = useState(true);
  const [editing, setEditing] = useState<Partial<AiAssistant> | null>(null);
  const [spend, setSpend] = useState<AiSpend | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testNum, setTestNum] = useState('');

  async function refresh() {
    try {
      const [a, s] = await Promise.all([listAiAssistants(), getAiSpend()]);
      setItems(a.items); setVapiOk(a.vapi_configured); setSpend(s);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Load failed'); }
  }
  useEffect(() => { refresh(); }, []);

  async function save() {
    if (!editing?.name || !editing?.first_message) { setErr('Name and first message are required.'); return; }
    setBusy(true); setErr(null);
    try {
      if (editing.id) await updateAiAssistant(editing.id, editing);
      else await createAiAssistant(editing);
      setEditing(null); await refresh();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Save failed'); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!confirm('Delete this assistant?')) return;
    await deleteAiAssistant(id); await refresh();
  }

  async function placeTest(id: string) {
    if (!testNum.trim()) { setErr('Enter your phone number to receive the test call.'); return; }
    setBusy(true); setErr(null);
    try { await testCallAssistant(id, testNum.trim()); alert('Test call placed. Your phone should ring shortly.'); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Test call failed'); }
    finally { setBusy(false); }
  }

  async function changeCap() {
    const dollars = prompt('New daily AI spend cap (USD):', spend ? (spend.cap_cents / 100).toFixed(2) : '20');
    if (!dollars) return;
    const cents = Math.round(parseFloat(dollars) * 100);
    if (!Number.isFinite(cents) || cents < 0) return;
    await setAiSpendCap(cents); await refresh();
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold">AI Assistants</h1>
        <button onClick={() => setEditing(empty)} className="px-3 py-1.5 bg-brand-600 hover:bg-brand-500 rounded text-sm">+ New assistant</button>
      </div>

      {!vapiOk && (
        <div className="mb-4 p-3 bg-yellow-900/30 border border-yellow-700/50 rounded text-yellow-200 text-sm">
          VAPI is not configured (missing <code>VAPI_API_KEY</code>). You can author and save assistants here, but real
          calls will not work until the key is set in Replit Secrets.
        </div>
      )}

      {spend && (
        <div className="mb-4 p-3 bg-gray-900 border border-gray-800 rounded text-sm flex items-center gap-4">
          <div>Daily AI spend: <b>${(spend.spent_today_cents / 100).toFixed(2)}</b> / ${(spend.cap_cents / 100).toFixed(2)}</div>
          {spend.paused_for_cap && <span className="text-red-400 font-semibold">Campaigns paused (cap reached)</span>}
          <button onClick={changeCap} className="ml-auto text-brand-400 hover:text-brand-300 text-xs">Change cap</button>
        </div>
      )}

      {err && <div className="mb-3 p-2 bg-red-900/40 border border-red-700/50 rounded text-red-200 text-sm">{err}</div>}

      <div className="bg-gray-900 border border-gray-800 rounded">
        <table className="w-full text-sm">
          <thead className="text-left text-gray-400 border-b border-gray-800">
            <tr><th className="p-3">Name</th><th className="p-3">Purpose</th><th className="p-3">Voice</th><th className="p-3">Active</th><th className="p-3">VAPI</th><th className="p-3 text-right">Actions</th></tr>
          </thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-gray-500">No assistants yet.</td></tr>}
            {items.map(a => (
              <tr key={a.id} className="border-t border-gray-800">
                <td className="p-3"><button onClick={() => setEditing(a)} className="text-brand-400 hover:text-brand-300">{a.name}</button></td>
                <td className="p-3 text-gray-400">{a.purpose.replace(/_/g, ' ')}</td>
                <td className="p-3 text-gray-400">{a.voice_id}</td>
                <td className="p-3">{a.is_active ? <span className="text-green-400">●</span> : <span className="text-gray-600">○</span>}</td>
                <td className="p-3 text-xs text-gray-500">{a.vapi_assistant_id ? '✓ synced' : '— not synced'}</td>
                <td className="p-3 text-right space-x-2">
                  <button onClick={() => placeTest(a.id)} disabled={!vapiOk || !a.vapi_assistant_id || busy} className="text-xs text-brand-400 hover:text-brand-300 disabled:opacity-30">Test call</button>
                  <button onClick={() => remove(a.id)} className="text-xs text-red-400 hover:text-red-300">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="p-3 border-t border-gray-800 text-xs text-gray-500 flex items-center gap-2">
          <span>Test call goes to:</span>
          <input value={testNum} onChange={e => setTestNum(e.target.value)} placeholder="+15555550100" className="bg-gray-950 border border-gray-800 rounded px-2 py-1 text-gray-200" />
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded max-w-2xl w-full max-h-[90vh] overflow-auto">
            <div className="p-4 border-b border-gray-800 flex items-baseline justify-between">
              <h2 className="font-semibold">{editing.id ? 'Edit assistant' : 'New assistant'}</h2>
              <button onClick={() => setEditing(null)} className="text-gray-500 hover:text-gray-300">✕</button>
            </div>
            <div className="p-4 space-y-3 text-sm">
              <Field label="Name"><input value={editing.name ?? ''} onChange={e => setEditing({ ...editing, name: e.target.value })} className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1.5" /></Field>
              <Field label="Purpose">
                <select value={editing.purpose} onChange={e => setEditing({ ...editing, purpose: e.target.value as AiAssistant['purpose'] })} className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1.5">
                  <option value="inbound_receptionist">Inbound receptionist</option>
                  <option value="outbound_qualifier">Outbound qualifier</option>
                  <option value="callback_scheduler">Callback scheduler</option>
                  <option value="custom">Custom</option>
                </select>
              </Field>
              <Field label="Voice">
                <select value={editing.voice_id} onChange={e => setEditing({ ...editing, voice_id: e.target.value })} className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1.5">
                  {VOICES.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </Field>
              <Field label="Model">
                <select value={editing.model} onChange={e => setEditing({ ...editing, model: e.target.value })} className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1.5">
                  {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </Field>
              <Field label="First message (caller hears this; disclosure auto-prepended if missing)">
                <textarea value={editing.first_message ?? ''} onChange={e => setEditing({ ...editing, first_message: e.target.value })} className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1.5 h-20" />
              </Field>
              <Field label="System prompt">
                <textarea value={editing.system_prompt ?? ''} onChange={e => setEditing({ ...editing, system_prompt: e.target.value })} className="w-full bg-gray-950 border border-gray-800 rounded px-2 py-1.5 h-40 font-mono text-xs" />
              </Field>
              <Field label="Tools (transfer_to_human is always enabled)">
                <div className="flex flex-wrap gap-2">
                  {ALL_TOOLS.map(t => {
                    const enabled = editing.tools_enabled?.includes(t) || t === 'transfer_to_human';
                    return (
                      <label key={t} className={`px-2 py-1 rounded border text-xs cursor-pointer ${enabled ? 'border-brand-600 bg-brand-600/20 text-brand-200' : 'border-gray-700 text-gray-400'} ${t === 'transfer_to_human' ? 'opacity-80' : ''}`}>
                        <input type="checkbox" disabled={t === 'transfer_to_human'} className="mr-1.5" checked={enabled}
                          onChange={e => {
                            const set = new Set(editing.tools_enabled ?? []);
                            if (e.target.checked) set.add(t); else set.delete(t);
                            set.add('transfer_to_human');
                            setEditing({ ...editing, tools_enabled: Array.from(set) as AiTool[] });
                          }}
                        />{t}
                      </label>
                    );
                  })}
                </div>
              </Field>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!editing.is_active} onChange={e => setEditing({ ...editing, is_active: e.target.checked })} /> Active (callers can reach this assistant)</label>
            </div>
            <div className="p-4 border-t border-gray-800 flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
              <button onClick={save} disabled={busy} className="px-3 py-1.5 text-sm bg-brand-600 hover:bg-brand-500 rounded disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="block text-xs text-gray-400 mb-1">{label}</label>{children}</div>;
}
