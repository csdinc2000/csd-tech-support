import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { getIntegrationsHealth, testTwilio, testEmail } from '../lib/api.js';

export function Integrations() {
  const healthQ = useQuery({
    queryKey: ['integrations-health'],
    queryFn: getIntegrationsHealth,
    refetchInterval: 30_000,
  });
  const [testEmailTo, setTestEmailTo] = useState('');

  const twilioM = useMutation({
    mutationFn: testTwilio,
    onSuccess: (r) => r.ok ? toast.success(`Twilio OK: ${r.friendly_name}`) : toast.error(r.error ?? 'Failed'),
  });
  const emailM = useMutation({
    mutationFn: () => testEmail(testEmailTo),
    onSuccess: (r) => r.ok ? toast.success('Email sent')
      : r.suppressed ? toast('Email provider not configured (RESEND_API_KEY missing)', { icon: '⚠️' })
      : toast.error(r.error ?? 'Failed'),
  });

  const h = healthQ.data;
  const dot = (ok: boolean) => (
    <span className={`inline-block w-2 h-2 rounded-full mr-2 ${ok ? 'bg-green-500' : 'bg-red-500'}`} />
  );

  return (
    <>
      <div className="p-6 max-w-4xl">
        <h1 className="text-xl font-semibold text-white mb-1">Integrations & System Health</h1>
        <p className="text-sm text-gray-500 mb-6">Live status of the services CSD Call Manager depends on. Refreshes every 30 seconds.</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <Card title="Supabase">
            {h?.supabase
              ? <div className="text-sm">{dot(h.supabase.ok)}{h.supabase.ok ? 'Connected' : (h.supabase.error ?? 'Error')}</div>
              : <div className="text-sm text-gray-500">…</div>}
          </Card>

          <Card title="Twilio">
            {h?.twilio
              ? (
                <div className="text-sm space-y-1">
                  <div>{dot(h.twilio.ok)}{h.twilio.ok ? `${h.twilio.friendly_name} (${h.twilio.status})` : (h.twilio.error ?? 'Error')}</div>
                  {h.twilio.phone_number && <div className="text-xs text-gray-500">{h.twilio.phone_number}</div>}
                </div>
              )
              : <div className="text-sm text-gray-500">…</div>}
            <button onClick={() => twilioM.mutate()} disabled={twilioM.isPending}
              className="mt-3 text-xs bg-gray-700 hover:bg-gray-600 text-white px-2 py-1 rounded">
              {twilioM.isPending ? 'Testing…' : 'Test connection'}
            </button>
          </Card>

          <Card title="Email (Resend)">
            {h?.email
              ? <div className="text-sm">{dot(h.email.ok)}{h.email.ok ? `Configured (${h.email.provider})` : 'RESEND_API_KEY not set — emails are recorded but not sent'}</div>
              : <div className="text-sm text-gray-500">…</div>}
            <div className="mt-3 flex gap-2">
              <input value={testEmailTo} onChange={(e) => setTestEmailTo(e.target.value)} placeholder="email@example.com"
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white" />
              <button onClick={() => emailM.mutate()} disabled={emailM.isPending || !testEmailTo}
                className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-2 py-1 rounded disabled:opacity-50">
                Test send
              </button>
            </div>
          </Card>

          <Card title="Webhook activity">
            <div className="text-sm space-y-1 text-gray-300">
              <div><span className="text-gray-500">Last voice webhook:</span> {h?.last_voice_webhook ? new Date(h.last_voice_webhook).toLocaleString() : 'never'}</div>
              <div><span className="text-gray-500">Last inbound SMS:</span> {h?.last_inbound_sms ? new Date(h.last_inbound_sms).toLocaleString() : 'never'}</div>
            </div>
          </Card>
        </div>

        <div className="text-xs text-gray-500">
          Last refreshed: {h ? new Date(h.timestamp).toLocaleString() : '—'}
        </div>
      </div>
    </>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded p-4">
      <h3 className="text-sm font-medium text-white mb-3">{title}</h3>
      {children}
    </div>
  );
}
