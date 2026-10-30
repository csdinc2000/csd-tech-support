import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listBlacklist, addBlacklist, deleteBlacklist } from '../lib/api.js';

export function Blacklist() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['blacklist'], queryFn: listBlacklist });
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [blocksCalls, setBlocksCalls] = useState(true);
  const [blocksSms, setBlocksSms] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => addBlacklist({ phone_number: phone, reason, blocks_calls: blocksCalls, blocks_sms: blocksSms }),
    onSuccess: () => {
      setPhone(''); setReason(''); setError(null);
      qc.invalidateQueries({ queryKey: ['blacklist'] });
    },
    onError: (err: unknown) => {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? (err as Error).message);
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => deleteBlacklist(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blacklist'] }),
  });

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-xl font-semibold text-white mb-1">Blacklist</h1>
      <p className="text-sm text-gray-400 mb-6">
        Block specific numbers from calling or messaging the CSD line. Blacklisted numbers
        are hung up on instantly when they call.
      </p>

      <div className="bg-gray-900 border border-gray-800 rounded p-4 mb-6">
        <h2 className="text-sm font-semibold text-white mb-3">Add to blacklist</h2>
        {error && <div className="mb-3 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">{error}</div>}
        <div className="grid grid-cols-2 gap-3 mb-3">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+15551234567"
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white"
          />
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white"
          />
        </div>
        <div className="flex gap-4 mb-3 text-sm text-gray-300">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={blocksCalls} onChange={(e) => setBlocksCalls(e.target.checked)} />
            Block calls
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={blocksSms} onChange={(e) => setBlocksSms(e.target.checked)} />
            Block SMS
          </label>
        </div>
        <button
          onClick={() => add.mutate()}
          disabled={add.isPending || !phone}
          className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 rounded text-sm text-white"
        >
          {add.isPending ? 'Adding…' : 'Add'}
        </button>
      </div>

      <table className="w-full text-sm">
        <thead className="text-xs text-gray-500 uppercase">
          <tr className="border-b border-gray-800">
            <th className="text-left py-2 px-2">Number</th>
            <th className="text-left py-2 px-2">Reason</th>
            <th className="text-left py-2 px-2">Blocks</th>
            <th className="text-left py-2 px-2">Added</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {list.data?.map((b) => (
            <tr key={b.id} className="border-b border-gray-800 text-gray-200">
              <td className="py-2 px-2 font-mono">{b.phone_number}</td>
              <td className="py-2 px-2 text-gray-400">{b.reason ?? '—'}</td>
              <td className="py-2 px-2 text-xs">
                {b.blocks_calls && <span className="bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded mr-1">calls</span>}
                {b.blocks_sms && <span className="bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded">sms</span>}
              </td>
              <td className="py-2 px-2 text-xs text-gray-500">{new Date(b.created_at).toLocaleDateString()}</td>
              <td className="py-2 px-2 text-right">
                <button
                  onClick={() => del.mutate(b.id)}
                  className="text-red-400 hover:text-red-300 text-xs"
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
          {list.data?.length === 0 && (
            <tr><td colSpan={5} className="text-center text-gray-500 py-6">No blacklisted numbers.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
