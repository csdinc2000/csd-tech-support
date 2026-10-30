import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { getCall, patchCall, listUsers } from '../lib/api.js';
import type { User as AppUser } from '../../../types/index.js';

const DISPOSITION_TAGS = ['repair', 'followup-needed', 'resolved', 'no-answer-cb', 'warranty', 'drop-off', 'pickup', 'remote'];

export function CallDetail({ profile }: { profile: AppUser | null }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canEdit = profile?.role === 'owner' || profile?.role === 'tech';

  const { data: call, isLoading } = useQuery({
    queryKey: ['call', id],
    queryFn: () => getCall(id!),
    enabled: !!id,
  });

  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: listUsers,
    enabled: profile?.role === 'owner',
  });

  const [notes, setNotes] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [ticketNumber, setTicketNumber] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [assignedTo, setAssignedTo] = useState<string>('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (call) {
      setNotes(call.notes ?? '');
      setCustomerName(call.customer_name ?? '');
      setTicketNumber(call.ticket_number ?? '');
      setTags(call.tags ?? []);
      setAssignedTo(call.assigned_to_user_id ?? '');
    }
  }, [call]);

  const save = async () => {
    if (!id || !canEdit) return;
    setSaving(true);
    try {
      await patchCall(id, {
        notes,
        tags,
        customer_name: customerName,
        ticket_number: ticketNumber,
        assigned_to_user_id: assignedTo || null,
      });
      toast.success('Saved');
      qc.invalidateQueries({ queryKey: ['call', id] });
      qc.invalidateQueries({ queryKey: ['calls'] });
    } catch {
      toast.error('Save failed');
    } finally {
      setSaving(false);
    }
  };

  const toggleTag = (tag: string) =>
    setTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);

  const fmt = (sec: number | null) => {
    if (!sec) return '—';
    const m = Math.floor(sec / 60); const s = sec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  if (isLoading) return <div className="p-6 text-gray-500 text-sm">Loading…</div>;
  if (!call) return <div className="p-6 text-red-400 text-sm">Call not found</div>;

  const events = (call as typeof call & { events?: unknown[] }).events ?? [];
  const recordingUrl = (call as typeof call & { recording_signed_url?: string }).recording_signed_url;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <button onClick={() => navigate(-1)} className="text-xs text-gray-500 hover:text-gray-300 mb-4 transition-colors">
        ← Back
      </button>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: metadata + recording */}
        <div className="lg:col-span-1 space-y-4">
          <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Call Info</h2>
            <dl className="space-y-2 text-sm">
              <Row label="Direction" value={
                <span className={`text-xs px-1.5 py-0.5 rounded ${call.direction === 'inbound' ? 'bg-blue-900 text-blue-300' : 'bg-purple-900 text-purple-300'}`}>
                  {call.direction}
                </span>
              } />
              <Row label="Status" value={
                <span className="text-xs text-gray-300 capitalize">{call.status}</span>
              } />
              <Row label="From" value={<span className="font-mono text-xs text-gray-300">{call.from_number}</span>} />
              <Row label="To" value={<span className="font-mono text-xs text-gray-300">{call.to_number}</span>} />
              <Row label="IVR" value={<span className="text-xs text-gray-300">{call.ivr_selection ?? '—'}</span>} />
              <Row label="Duration" value={<span className="text-xs text-gray-300">{fmt(call.duration_seconds)}</span>} />
              <Row label="Started" value={<span className="text-xs text-gray-300">{format(new Date(call.started_at), 'MM/dd/yyyy HH:mm:ss')}</span>} />
              {call.ended_at && (
                <Row label="Ended" value={<span className="text-xs text-gray-300">{format(new Date(call.ended_at), 'MM/dd/yyyy HH:mm:ss')}</span>} />
              )}
              <Row label="Call SID" value={<span className="font-mono text-xs text-gray-500 break-all">{call.twilio_call_sid}</span>} />
            </dl>
          </div>

          {recordingUrl && (
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Recording</h2>
              <audio
                controls
                src={recordingUrl}
                className="w-full"
                style={{ filter: 'invert(0.85) hue-rotate(180deg)' }}
              />
              <a
                href={recordingUrl}
                download
                className="text-xs text-brand-500 hover:text-brand-400 mt-2 inline-block"
              >
                ↓ Download MP3
              </a>
            </div>
          )}
        </div>

        {/* Right column: editable fields + audit */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Tags & Assignment</h2>

            <div className="mb-4">
              <label className="block text-xs text-gray-500 mb-1">Disposition Tags</label>
              <div className="flex flex-wrap gap-1.5">
                {DISPOSITION_TAGS.map(tag => (
                  <button
                    key={tag}
                    onClick={() => canEdit && toggleTag(tag)}
                    className={`text-xs px-2 py-1 rounded border transition-colors ${
                      tags.includes(tag)
                        ? 'bg-brand-700 border-brand-600 text-white'
                        : 'bg-transparent border-gray-700 text-gray-400 hover:border-gray-500'
                    } ${!canEdit ? 'cursor-default' : ''}`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Customer Name</label>
                <input
                  type="text"
                  value={customerName}
                  onChange={e => setCustomerName(e.target.value)}
                  disabled={!canEdit}
                  className="input w-full"
                  placeholder="e.g. John Smith"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Ticket #</label>
                <input
                  type="text"
                  value={ticketNumber}
                  onChange={e => setTicketNumber(e.target.value)}
                  disabled={!canEdit}
                  className="input w-full"
                  placeholder="e.g. TKT-1042"
                />
              </div>
            </div>

            {profile?.role === 'owner' && (
              <div className="mb-3">
                <label className="block text-xs text-gray-500 mb-1">Assigned Tech</label>
                <select
                  value={assignedTo}
                  onChange={e => setAssignedTo(e.target.value)}
                  className="input w-full"
                >
                  <option value="">— Unassigned —</option>
                  {(users as AppUser[]).map(u => (
                    <option key={u.id} value={u.id}>{u.full_name || u.email} ({u.role})</option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs text-gray-500 mb-1">Notes</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                disabled={!canEdit}
                rows={5}
                className="input w-full resize-y"
                placeholder="Add notes about this call…"
              />
            </div>

            {canEdit && (
              <button
                onClick={save}
                disabled={saving}
                className="btn-primary text-sm px-4 py-1.5 mt-3 disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            )}
          </div>

          {/* Audit trail */}
          <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Audit Trail</h2>
            {events.length === 0 && <p className="text-xs text-gray-600">No events yet</p>}
            <div className="space-y-2">
              {(events as Array<{ id: string; event_type: string; created_at: string; payload: Record<string, unknown> }>).map(ev => (
                <div key={ev.id} className="flex gap-3 text-xs">
                  <span className="text-gray-600 whitespace-nowrap">{format(new Date(ev.created_at), 'MM/dd HH:mm:ss')}</span>
                  <span className="text-gray-400 font-medium">{ev.event_type}</span>
                  <span className="text-gray-600 truncate">{JSON.stringify(ev.payload).slice(0, 80)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-gray-500 shrink-0">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
