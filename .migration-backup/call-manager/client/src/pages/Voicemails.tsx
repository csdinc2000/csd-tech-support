import { useState } from 'react';
import { format } from 'date-fns';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listVoicemails, patchVoicemail } from '../lib/api.js';
import type { Voicemail } from '../../../types/index.js';

export function Voicemails() {
  const qc = useQueryClient();
  const [unlistenedOnly, setUnlistenedOnly] = useState(true);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['voicemails', { unlistened: unlistenedOnly }],
    queryFn: () => listVoicemails({ unlistened: unlistenedOnly || undefined }),
    refetchInterval: 30_000,
  });

  const markMut = useMutation({
    mutationFn: ({ id, is_listened }: { id: string; is_listened: boolean }) =>
      patchVoicemail(id, { is_listened }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['voicemails'] }),
  });

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-white mb-1">Voicemails</h1>
          <p className="text-sm text-gray-500">Most recent first. Mark as listened to clear from the unlistened view.</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-400">
          <input
            type="checkbox"
            checked={unlistenedOnly}
            onChange={(e) => setUnlistenedOnly(e.target.checked)}
            className="accent-brand-600"
          />
          Unlistened only
        </label>
      </div>

      {isLoading && <div className="text-gray-500 text-sm">Loading…</div>}
      {!isLoading && items.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-12 text-center text-gray-500 text-sm">
          No voicemails {unlistenedOnly ? 'unlistened' : 'in the system'}.
        </div>
      )}

      <div className="space-y-3">
        {items.map((vm: Voicemail) => (
          <div
            key={vm.id}
            className={`bg-gray-900 border rounded-lg p-4 ${vm.is_listened ? 'border-gray-800 opacity-70' : 'border-brand-700'}`}
          >
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="text-sm text-white font-medium font-mono">
                  {vm.call?.from_number ?? '(unknown)'}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {format(new Date(vm.created_at), 'EEE MMM d, HH:mm')} · {vm.duration_seconds}s
                </div>
              </div>
              <div className="flex items-center gap-3">
                {vm.call_id && (
                  <Link to={`/calls/${vm.call_id}`} className="text-xs text-brand-500 hover:text-brand-400">
                    View call →
                  </Link>
                )}
                <button
                  onClick={() => markMut.mutate({ id: vm.id, is_listened: !vm.is_listened })}
                  className={`text-xs px-2 py-1 rounded ${
                    vm.is_listened
                      ? 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                      : 'bg-brand-600 text-white hover:bg-brand-500'
                  }`}
                >
                  {vm.is_listened ? 'Mark unlistened' : 'Mark listened'}
                </button>
              </div>
            </div>

            {vm.recording_signed_url ? (
              <audio
                controls
                src={vm.recording_signed_url}
                className="w-full h-9 mb-2"
                onPlay={() => !vm.is_listened && markMut.mutate({ id: vm.id, is_listened: true })}
              />
            ) : (
              <div className="text-xs text-gray-600 italic mb-2">Recording not available</div>
            )}

            {vm.transcription ? (
              <div className="text-sm text-gray-400 bg-gray-950 border border-gray-800 rounded p-3">
                <div className="text-xs uppercase tracking-wide text-gray-600 mb-1">Transcription</div>
                {vm.transcription}
              </div>
            ) : (
              <div className="text-xs text-gray-600 italic">Transcription pending…</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
