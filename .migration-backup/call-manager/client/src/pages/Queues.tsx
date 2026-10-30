import { useState } from 'react';
import toast from 'react-hot-toast';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listQueues,
  createQueue,
  updateQueue,
  deleteQueue,
  addQueueMember,
  removeQueueMember,
  listUsers,
} from '../lib/api.js';
import type { CallQueue, QueueStrategy } from '../../../types/index.js';

const STRATEGIES: QueueStrategy[] = ['ring_all', 'round_robin', 'least_recent'];

export function Queues() {
  const qc = useQueryClient();
  const { data: queues = [] } = useQuery({ queryKey: ['queues'], queryFn: listQueues });
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: listUsers });

  const techs = users.filter((u) => u.role === 'owner' || u.role === 'tech');

  const createMut = useMutation({
    mutationFn: (name: string) => createQueue({ name, strategy: 'ring_all', max_wait_seconds: 60, on_timeout_action: 'voicemail' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queues'] });
      setNewName('');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [newName, setNewName] = useState('');

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-lg font-semibold text-white mb-1">Call Queues</h1>
      <p className="text-sm text-gray-500 mb-6">Group techs into queues and choose how Twilio rings them.</p>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6 flex gap-2 items-center">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New queue name (e.g. tier1_support)"
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200"
        />
        <button
          onClick={() => newName && createMut.mutate(newName)}
          disabled={!newName || createMut.isPending}
          className="bg-brand-600 hover:bg-brand-500 text-white text-sm px-4 py-1.5 rounded disabled:opacity-50"
        >
          + Create Queue
        </button>
      </div>

      <div className="space-y-4">
        {queues.length === 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center text-gray-500 text-sm">
            No queues configured yet.
          </div>
        )}
        {queues.map((q) => (
          <QueueCard key={q.id} queue={q} techs={techs} />
        ))}
      </div>
    </div>
  );
}

function QueueCard({ queue, techs }: { queue: CallQueue; techs: { id: string; full_name: string; email: string; phone: string | null }[] }) {
  const qc = useQueryClient();
  const [name, setName] = useState(queue.name);
  const [strategy, setStrategy] = useState(queue.strategy);
  const [wait, setWait] = useState(queue.max_wait_seconds);
  const [onTimeout, setOnTimeout] = useState(queue.on_timeout_action);
  const [target, setTarget] = useState(queue.on_timeout_target ?? '');

  const saveMut = useMutation({
    mutationFn: () =>
      updateQueue(queue.id, {
        name,
        strategy,
        max_wait_seconds: wait,
        on_timeout_action: onTimeout,
        on_timeout_target: target || null,
      }),
    onSuccess: () => {
      toast.success('Queue saved');
      qc.invalidateQueries({ queryKey: ['queues'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const delMut = useMutation({
    mutationFn: () => deleteQueue(queue.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queues'] }),
  });
  const addMemberMut = useMutation({
    mutationFn: (userId: string) => addQueueMember(queue.id, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queues'] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const rmMemberMut = useMutation({
    mutationFn: (userId: string) => removeQueueMember(queue.id, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queues'] }),
  });

  const memberIds = new Set(queue.members?.map((m) => m.user_id) ?? []);
  const available = techs.filter((t) => !memberIds.has(t.id));

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Strategy</label>
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as QueueStrategy)} className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200">
            {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Max wait (seconds)</label>
          <input type="number" min={5} max={600} value={wait} onChange={(e) => setWait(parseInt(e.target.value, 10) || 60)} className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">On timeout</label>
          <select value={onTimeout} onChange={(e) => setOnTimeout(e.target.value as 'voicemail' | 'forward')} className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200">
            <option value="voicemail">voicemail</option>
            <option value="forward">forward</option>
          </select>
        </div>
        {onTimeout === 'forward' && (
          <div className="col-span-2">
            <label className="block text-xs text-gray-500 mb-1">Forward to (E.164)</label>
            <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="+15551234567" className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200" />
          </div>
        )}
      </div>

      <div className="border-t border-gray-800 pt-4 mb-4">
        <h4 className="text-xs uppercase tracking-wide text-gray-500 mb-2">Members</h4>
        {queue.members && queue.members.length > 0 ? (
          <div className="space-y-1 mb-3">
            {queue.members.map((m) => (
              <div key={m.user_id} className="flex items-center justify-between bg-gray-950 border border-gray-800 rounded px-3 py-2">
                <div className="text-sm text-gray-300">
                  {m.user?.full_name || m.user_id}
                  <span className="text-gray-500 ml-2 text-xs font-mono">{m.user?.phone ?? '(no phone)'}</span>
                </div>
                <button onClick={() => rmMemberMut.mutate(m.user_id)} className="text-red-400 hover:text-red-300 text-xs">Remove</button>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-gray-600 italic mb-3">No members yet</div>
        )}

        {available.length > 0 && (
          <select
            onChange={(e) => e.target.value && addMemberMut.mutate(e.target.value)}
            value=""
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200"
          >
            <option value="">+ Add member…</option>
            {available.map((t) => (
              <option key={t.id} value={t.id}>{t.full_name || t.email} {t.phone ? `(${t.phone})` : '(no phone)'}</option>
            ))}
          </select>
        )}
      </div>

      <div className="flex justify-between">
        <button onClick={() => delMut.mutate()} className="text-red-400 hover:text-red-300 text-sm">Delete queue</button>
        <button onClick={() => saveMut.mutate()} className="bg-brand-600 hover:bg-brand-500 text-white text-sm px-4 py-1.5 rounded">Save Queue</button>
      </div>
    </div>
  );
}
