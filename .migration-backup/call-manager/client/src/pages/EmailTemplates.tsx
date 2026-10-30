import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  listEmailTemplates, createEmailTemplate, updateEmailTemplate,
  deleteEmailTemplate, previewEmailTemplate, testSendEmailTemplate,
} from '../lib/api.js';
import type { EmailTemplate } from '../lib/api.js';

const TRIGGERS: EmailTemplate['trigger'][] = [
  'manual', 'missed_call', 'voicemail_received', 'new_customer', 'daily_digest', 'invitation',
];

const PLACEHOLDER_HINTS: Record<string, string[]> = {
  missed_call: ['recipient_name', 'from_number', 'customer_name', 'call_time', 'call_url'],
  voicemail_received: ['recipient_name', 'from_number', 'customer_name', 'call_time', 'duration', 'voicemail_url'],
  daily_digest: ['recipient_name', 'date', 'call_count', 'voicemail_count', 'message_count', 'dashboard_url', 'unsubscribe_url'],
  invitation: ['inviter_name', 'org_name', 'role', 'accept_url', 'expires_at'],
  new_customer: ['recipient_name', 'customer_name', 'phone_number'],
  manual: ['recipient_name'],
};

const SAMPLE_CONTEXT: Record<string, Record<string, unknown>> = {
  missed_call: { recipient_name: 'Aaron', from_number: '+15551112222', customer_name: 'Jane Doe', call_time: 'Mar 5, 2026 3:42 PM', call_url: 'https://example.com/calls/1' },
  voicemail_received: { recipient_name: 'Aaron', from_number: '+15551112222', customer_name: 'Jane Doe', call_time: 'Mar 5, 2026 3:42 PM', duration: 27, voicemail_url: 'https://example.com/voicemails' },
  daily_digest: { recipient_name: 'Aaron', date: '2026-03-05', call_count: 14, voicemail_count: 3, message_count: 21, dashboard_url: 'https://example.com/', unsubscribe_url: 'https://example.com/unsubscribe/abc' },
  invitation: { inviter_name: 'Aaron', org_name: 'Computer Systems Depot', role: 'tech', accept_url: 'https://example.com/accept-invite?token=abc', expires_at: '2026-03-12' },
  new_customer: { recipient_name: 'Aaron', customer_name: 'Jane Doe', phone_number: '+15551112222' },
  manual: { recipient_name: 'Aaron' },
};

export function EmailTemplates() {
  const qc = useQueryClient();
  const tplsQ = useQuery({ queryKey: ['email-templates'], queryFn: listEmailTemplates });

  const [editing, setEditing] = useState<Partial<EmailTemplate> | null>(null);
  const [previewSubject, setPreviewSubject] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [testTo, setTestTo] = useState('');

  const trigger = (editing?.trigger ?? 'manual') as keyof typeof PLACEHOLDER_HINTS;
  const sampleCtx = useMemo(() => SAMPLE_CONTEXT[trigger] ?? {}, [trigger]);

  // Live preview
  useEffect(() => {
    if (!editing) return;
    const t = setTimeout(async () => {
      try {
        const r = await previewEmailTemplate({
          subject: editing.subject ?? '',
          body_html: editing.body_html ?? '',
          body_text: editing.body_text ?? '',
          context: sampleCtx,
        });
        setPreviewSubject(r.subject);
        setPreviewHtml(r.body_html);
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(t);
  }, [editing, sampleCtx]);

  const saveM = useMutation({
    mutationFn: async () => {
      if (!editing) throw new Error('nothing');
      if (editing.id) return updateEmailTemplate(editing.id, editing);
      return createEmailTemplate(editing);
    },
    onSuccess: (saved) => {
      toast.success('Saved');
      setEditing(saved);
      qc.invalidateQueries({ queryKey: ['email-templates'] });
    },
    onError: () => toast.error('Save failed'),
  });

  const deleteM = useMutation({
    mutationFn: deleteEmailTemplate,
    onSuccess: () => {
      toast.success('Deleted'); setEditing(null);
      qc.invalidateQueries({ queryKey: ['email-templates'] });
    },
  });

  const testSendM = useMutation({
    mutationFn: () => editing?.id ? testSendEmailTemplate(editing.id, { to: testTo || undefined, context: sampleCtx }) : Promise.reject(),
    onSuccess: (r) => {
      if (r.ok) toast.success(`Test sent to ${r.to}`);
      else if (r.suppressed) toast(`Email provider not configured. Would have sent to ${r.to}.`, { icon: '⚠️' });
      else toast.error(r.error ?? 'Send failed');
    },
  });

  return (
    <>
      <div className="p-6 max-w-7xl">
        <h1 className="text-xl font-semibold text-white mb-1">Email Templates</h1>
        <p className="text-sm text-gray-500 mb-6">Use <code>{'{{placeholder}}'}</code> for variables and <code>{'{{#section}}…{{/section}}'}</code> for conditional blocks.</p>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="bg-gray-900 border border-gray-800 rounded">
            <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-sm font-medium text-white">Templates</h2>
              <button onClick={() => setEditing({ name: 'New template', subject: '', body_html: '', body_text: '', trigger: 'manual' })}
                className="text-xs bg-brand-600 hover:bg-brand-500 text-white px-2 py-1 rounded">+ New</button>
            </div>
            <div className="divide-y divide-gray-800">
              {(tplsQ.data ?? []).map((t) => (
                <button key={t.id} onClick={() => setEditing(t)}
                  className={`w-full text-left px-4 py-2 hover:bg-gray-800 ${editing?.id === t.id ? 'bg-gray-800' : ''}`}>
                  <div className="text-sm text-white truncate">{t.name}</div>
                  <div className="text-xs text-gray-500">{t.trigger}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="lg:col-span-2 bg-gray-900 border border-gray-800 rounded p-4">
            {!editing && <div className="text-sm text-gray-500">Pick a template to edit, or create a new one.</div>}
            {editing && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <input
                    value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    placeholder="Template name"
                    className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
                  <select
                    value={editing.trigger ?? 'manual'}
                    onChange={(e) => setEditing({ ...editing, trigger: e.target.value as EmailTemplate['trigger'] })}
                    className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white">
                    {TRIGGERS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="text-xs text-gray-500">
                  Placeholders for {trigger}: {(PLACEHOLDER_HINTS[trigger] ?? []).map((p) => <code key={p} className="bg-gray-800 px-1.5 py-0.5 rounded mr-1">{`{{${p}}}`}</code>)}
                </div>
                <input
                  value={editing.subject ?? ''} onChange={(e) => setEditing({ ...editing, subject: e.target.value })}
                  placeholder="Subject" className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
                <textarea
                  value={editing.body_html ?? ''} onChange={(e) => setEditing({ ...editing, body_html: e.target.value })}
                  placeholder="HTML body" rows={8}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white font-mono" />
                <textarea
                  value={editing.body_text ?? ''} onChange={(e) => setEditing({ ...editing, body_text: e.target.value })}
                  placeholder="Plain-text body (used for SMS too)" rows={3}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white font-mono" />

                <div className="flex flex-wrap gap-2">
                  <button onClick={() => saveM.mutate()} disabled={saveM.isPending}
                    className="bg-brand-600 hover:bg-brand-500 text-white px-4 py-2 rounded text-sm disabled:opacity-50">
                    {saveM.isPending ? 'Saving…' : (editing.id ? 'Save' : 'Create')}
                  </button>
                  {editing.id && (
                    <>
                      <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="(optional) test send to"
                        className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-white" />
                      <button onClick={() => testSendM.mutate()} disabled={testSendM.isPending}
                        className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded text-sm">
                        Test send
                      </button>
                      <button onClick={() => editing.id && confirm('Delete?') && deleteM.mutate(editing.id)}
                        className="text-red-400 hover:text-red-300 px-3 py-1.5 text-sm">Delete</button>
                    </>
                  )}
                </div>

                <div className="border-t border-gray-800 pt-3">
                  <div className="text-xs text-gray-500 mb-2">Live preview (sample data)</div>
                  <div className="bg-white text-gray-900 rounded p-4 text-sm">
                    <div className="font-semibold border-b border-gray-200 pb-2 mb-2">{previewSubject}</div>
                    <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
