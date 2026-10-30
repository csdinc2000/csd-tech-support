import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSpamSettings, updateSpamSettings, listRecentSpam, checkSpamApi } from '../lib/api.js';

export function SpamSettings() {
  const qc = useQueryClient();
  const settingsQ = useQuery({ queryKey: ['spam-settings'], queryFn: getSpamSettings });
  const recentQ = useQuery({ queryKey: ['spam-recent'], queryFn: listRecentSpam });

  const [threshold, setThreshold] = useState(70);
  const [enabled, setEnabled] = useState(false);
  const [phone, setPhone] = useState('');
  const [checkResult, setCheckResult] = useState<{ score: number; phone_number: string } | null>(null);

  useEffect(() => {
    if (settingsQ.data) {
      setThreshold(settingsQ.data.threshold);
      setEnabled(settingsQ.data.screening_enabled);
    }
  }, [settingsQ.data]);

  const saveS = useMutation({
    mutationFn: () => updateSpamSettings({ threshold, screening_enabled: enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['spam-settings'] }),
  });

  const checkM = useMutation({
    mutationFn: () => checkSpamApi(phone, true),
    onSuccess: (r) => {
      setCheckResult({ score: r.score, phone_number: r.phone_number });
      qc.invalidateQueries({ queryKey: ['spam-recent'] });
    },
  });

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-white">Spam Filter</h1>
        <p className="text-sm text-gray-400 mt-1">
          Use Twilio Lookup to score incoming numbers. When screening is enabled, calls from
          numbers scoring at or above the threshold are challenged with a press-any-key prompt.
        </p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded p-4">
        <h2 className="text-sm font-semibold text-white mb-3">Settings</h2>
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enable auto-screening for inbound calls
          </label>
          <div className="flex items-center gap-3">
            <label className="text-sm text-gray-300">Block threshold</label>
            <input
              type="number"
              min={0}
              max={100}
              value={threshold}
              onChange={(e) => setThreshold(parseInt(e.target.value, 10) || 0)}
              className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white"
            />
            <span className="text-xs text-gray-500">(0–100, higher = more aggressive)</span>
          </div>
          <button
            onClick={() => saveS.mutate()}
            disabled={saveS.isPending}
            className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 rounded text-sm text-white"
          >
            {saveS.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded p-4">
        <h2 className="text-sm font-semibold text-white mb-3">Check a number</h2>
        <div className="flex gap-2">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+15551234567"
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white"
          />
          <button
            onClick={() => checkM.mutate()}
            disabled={checkM.isPending || !phone}
            className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 rounded text-sm text-white"
          >
            {checkM.isPending ? 'Checking…' : 'Check'}
          </button>
        </div>
        {checkResult && (
          <div className="mt-3 text-sm text-gray-300">
            <span className="font-mono">{checkResult.phone_number}</span> →{' '}
            <span className={checkResult.score >= threshold ? 'text-red-400 font-semibold' : 'text-emerald-400'}>
              score {checkResult.score}/100
            </span>
          </div>
        )}
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded p-4">
        <h2 className="text-sm font-semibold text-white mb-3">Recent checks</h2>
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase">
            <tr className="border-b border-gray-800">
              <th className="text-left py-2 px-2">Number</th>
              <th className="text-left py-2 px-2">Score</th>
              <th className="text-left py-2 px-2">Last checked</th>
            </tr>
          </thead>
          <tbody>
            {recentQ.data?.map((s) => (
              <tr key={s.phone_number} className="border-b border-gray-800 text-gray-200">
                <td className="py-2 px-2 font-mono">{s.phone_number}</td>
                <td className="py-2 px-2">
                  <span className={s.score >= threshold ? 'text-red-400 font-semibold' : 'text-emerald-400'}>
                    {s.score}
                  </span>
                </td>
                <td className="py-2 px-2 text-xs text-gray-500">{new Date(s.last_checked).toLocaleString()}</td>
              </tr>
            ))}
            {recentQ.data?.length === 0 && (
              <tr><td colSpan={3} className="text-center text-gray-500 py-6">No recent spam checks.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
