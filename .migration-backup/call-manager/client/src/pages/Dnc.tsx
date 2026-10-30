import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listDnc, addDnc, deleteDnc, importDncCsv } from '../lib/api.js';

export function Dnc() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['dnc'], queryFn: listDnc });
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [csv, setCsv] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => addDnc({ phone_number: phone, notes }),
    onSuccess: () => {
      setPhone(''); setNotes(''); setError(null);
      qc.invalidateQueries({ queryKey: ['dnc'] });
    },
    onError: (e: unknown) => setError((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? (e as Error).message),
  });

  const importM = useMutation({
    mutationFn: () => importDncCsv(csv),
    onSuccess: (r) => {
      setMsg(`Imported ${r.imported} numbers`);
      setCsv('');
      qc.invalidateQueries({ queryKey: ['dnc'] });
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => deleteDnc(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dnc'] }),
  });

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-xl font-semibold text-white mb-1">Do Not Call List</h1>
      <p className="text-sm text-gray-400 mb-6">
        Numbers on this list cannot be called or texted from CSD Call Manager. Outbound
        attempts will be rejected with a clear error.
      </p>

      <div className="bg-gray-900 border border-gray-800 rounded p-4 mb-6">
        <h2 className="text-sm font-semibold text-white mb-3">Add a number</h2>
        {error && <div className="mb-3 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">{error}</div>}
        <div className="grid grid-cols-2 gap-3 mb-3">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+15551234567"
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white"
          />
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes (optional)"
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white"
          />
        </div>
        <button
          onClick={() => add.mutate()}
          disabled={add.isPending || !phone}
          className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 rounded text-sm text-white"
        >
          {add.isPending ? 'Adding…' : 'Add'}
        </button>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded p-4 mb-6">
        <h2 className="text-sm font-semibold text-white mb-2">CSV import</h2>
        <p className="text-xs text-gray-500 mb-2">
          One per line: <code className="bg-gray-800 px-1">+15551234567,optional notes</code>
        </p>
        {msg && <div className="mb-2 text-xs text-emerald-400">{msg}</div>}
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          rows={4}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white font-mono"
          placeholder="+15551234567,opted out via web form"
        />
        <button
          onClick={() => importM.mutate()}
          disabled={importM.isPending || !csv.trim()}
          className="mt-2 px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 rounded text-sm text-white"
        >
          {importM.isPending ? 'Importing…' : 'Import'}
        </button>
      </div>

      <table className="w-full text-sm">
        <thead className="text-xs text-gray-500 uppercase">
          <tr className="border-b border-gray-800">
            <th className="text-left py-2 px-2">Number</th>
            <th className="text-left py-2 px-2">Source</th>
            <th className="text-left py-2 px-2">Notes</th>
            <th className="text-left py-2 px-2">Added</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {list.data?.map((d) => (
            <tr key={d.id} className="border-b border-gray-800 text-gray-200">
              <td className="py-2 px-2 font-mono">{d.phone_number}</td>
              <td className="py-2 px-2 text-xs text-gray-400">{d.source}</td>
              <td className="py-2 px-2 text-gray-400">{d.notes ?? '—'}</td>
              <td className="py-2 px-2 text-xs text-gray-500">{new Date(d.created_at).toLocaleDateString()}</td>
              <td className="py-2 px-2 text-right">
                <button onClick={() => del.mutate(d.id)} className="text-red-400 hover:text-red-300 text-xs">Remove</button>
              </td>
            </tr>
          ))}
          {list.data?.length === 0 && (
            <tr><td colSpan={5} className="text-center text-gray-500 py-6">DNC list is empty.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
