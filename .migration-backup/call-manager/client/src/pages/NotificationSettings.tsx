import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  getNotificationSettings, updateNotificationSettings, testNotification, listNotificationLog,
} from '../lib/api.js';
import type { NotificationSettings as NS } from '../lib/api.js';

export function NotificationSettings() {
  const qc = useQueryClient();
  const settingsQ = useQuery({ queryKey: ['notification-settings'], queryFn: getNotificationSettings });
  const logQ = useQuery({ queryKey: ['notification-log'], queryFn: listNotificationLog });
  const [draft, setDraft] = useState<NS | null>(null);

  useEffect(() => { if (settingsQ.data) setDraft(settingsQ.data); }, [settingsQ.data]);

  const saveM = useMutation({
    mutationFn: (s: Partial<NS>) => updateNotificationSettings(s),
    onSuccess: () => {
      toast.success('Saved');
      qc.invalidateQueries({ queryKey: ['notification-settings'] });
    },
    onError: () => toast.error('Save failed'),
  });

  const testM = useMutation({
    mutationFn: (channels: { email?: boolean; sms?: boolean }) => testNotification(channels),
    onSuccess: (r) => {
      toast.success(`Test dispatched: ${r.sent} sent, ${r.queued} queued, ${r.failed} failed`);
      qc.invalidateQueries({ queryKey: ['notification-log'] });
    },
  });

  if (!draft) return <div className="p-6 text-gray-500">Loading…</div>;

  const set = <K extends keyof NS>(k: K, v: NS[K]) => setDraft({ ...draft, [k]: v });
  const time = (v: string | null) => v ? v.slice(0, 5) : '';

  return (
    <>
      <div className="p-6 max-w-3xl">
        <h1 className="text-xl font-semibold text-white mb-1">Notification Settings</h1>
        <p className="text-sm text-gray-500 mb-6">Choose how you want to be notified about call activity.</p>

        <div className="bg-gray-900 border border-gray-800 rounded p-5 space-y-5">
          <Section title="Missed calls">
            <Toggle label="Email me" v={draft.missed_call_email} on={(v) => set('missed_call_email', v)} />
            <Toggle label="Text me (SMS)" v={draft.missed_call_sms} on={(v) => set('missed_call_sms', v)} />
          </Section>
          <Section title="Voicemails">
            <Toggle label="Email me" v={draft.voicemail_email} on={(v) => set('voicemail_email', v)} />
            <Toggle label="Text me (SMS)" v={draft.voicemail_sms} on={(v) => set('voicemail_sms', v)} />
          </Section>
          <Section title="Daily digest">
            <Toggle label="Email me a daily digest" v={draft.daily_digest_email} on={(v) => set('daily_digest_email', v)} />
            <div className="flex items-center gap-2 text-sm text-gray-300 ml-6">
              <span>Send at:</span>
              <input type="time" value={time(draft.daily_digest_time)}
                onChange={(e) => set('daily_digest_time', (e.target.value || '08:00') as NS['daily_digest_time'])}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white" />
              <span className="text-xs text-gray-500">(in your timezone)</span>
            </div>
          </Section>
          <Section title="Quiet hours">
            <p className="text-xs text-gray-500 ml-1 mb-2">During these hours, notifications are queued and delivered after they end.</p>
            <div className="flex items-center gap-2 text-sm text-gray-300 ml-1">
              <span>From</span>
              <input type="time" value={time(draft.quiet_hours_start)}
                onChange={(e) => set('quiet_hours_start', (e.target.value || null) as NS['quiet_hours_start'])}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white" />
              <span>to</span>
              <input type="time" value={time(draft.quiet_hours_end)}
                onChange={(e) => set('quiet_hours_end', (e.target.value || null) as NS['quiet_hours_end'])}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white" />
            </div>
          </Section>

          <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-800">
            <button onClick={() => saveM.mutate(draft)} disabled={saveM.isPending}
              className="bg-brand-600 hover:bg-brand-500 text-white px-4 py-2 rounded text-sm disabled:opacity-50">
              {saveM.isPending ? 'Saving…' : 'Save settings'}
            </button>
            <button onClick={() => testM.mutate({ email: true })} disabled={testM.isPending}
              className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded text-sm">Test email</button>
            <button onClick={() => testM.mutate({ sms: true })} disabled={testM.isPending}
              className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded text-sm">Test SMS</button>
          </div>
        </div>

        <h2 className="text-sm font-medium text-white mt-8 mb-2">Recent notifications</h2>
        <div className="bg-gray-900 border border-gray-800 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-800/50 text-xs text-gray-400">
              <tr>
                <th className="text-left px-3 py-2">When</th>
                <th className="text-left px-3 py-2">Channel</th>
                <th className="text-left px-3 py-2">Trigger</th>
                <th className="text-left px-3 py-2">To</th>
                <th className="text-left px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {(logQ.data ?? []).slice(0, 20).map((n) => (
                <tr key={n.id} className="border-t border-gray-800">
                  <td className="px-3 py-2 text-gray-400">{new Date(n.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2 text-gray-300">{n.channel}</td>
                  <td className="px-3 py-2 text-gray-300">{n.trigger}</td>
                  <td className="px-3 py-2 text-gray-300">{n.to_address}</td>
                  <td className={`px-3 py-2 ${n.status === 'sent' ? 'text-green-400' : n.status === 'failed' ? 'text-red-400' : 'text-gray-400'}`}>
                    {n.status}{n.error_message ? ` — ${n.error_message}` : ''}
                  </td>
                </tr>
              ))}
              {logQ.data?.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-500">No notifications yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm font-medium text-white mb-2">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
function Toggle({ label, v, on }: { label: string; v: boolean; on: (b: boolean) => void }) {
  return (
    <label className="flex items-center gap-3 text-sm text-gray-300 cursor-pointer">
      <input type="checkbox" checked={v} onChange={(e) => on(e.target.checked)}
        className="h-4 w-4 rounded border-gray-700 bg-gray-800 accent-blue-600" />
      {label}
    </label>
  );
}
