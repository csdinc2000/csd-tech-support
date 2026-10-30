import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listTemplates, createTemplate, updateTemplate, deleteTemplate, type MessageTemplate } from '../lib/api.js';

export function Templates() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['templates'], queryFn: listTemplates });
  const [editing, setEditing] = useState<MessageTemplate | null>(null);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');

  const startNew = () => {
    setEditing({ id: '', name: '', body: '', shared: true, created_by: null, created_at: '' });
    setName('');
    setBody('');
  };

  const startEdit = (t: MessageTemplate) => {
    setEditing(t);
    setName(t.name);
    setBody(t.body);
  };

  const save = useMutation({
    mutationFn: () =>
      editing?.id
        ? updateTemplate(editing.id, { name, body })
        : createTemplate({ name, body }),
    onSuccess: () => {
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => deleteTemplate(id),
    onSuccess: () => {
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Message Templates</h1>
          <p className="text-sm text-gray-400 mt-1">
            Use <code className="bg-gray-800 px-1">{'{{customer_name}}'}</code> and{' '}
            <code className="bg-gray-800 px-1">{'{{ticket_number}}'}</code> placeholders.
          </p>
        </div>
        <button onClick={startNew} className="px-4 py-2 bg-brand-600 hover:bg-brand-500 rounded text-sm text-white">
          + New
        </button>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div>
          {list.data?.length === 0 && <div className="text-sm text-gray-500">No templates yet.</div>}
          <div className="space-y-2">
            {list.data?.map((t) => (
              <button
                key={t.id}
                onClick={() => startEdit(t)}
                className={`w-full text-left p-3 rounded border ${
                  editing?.id === t.id ? 'border-brand-500 bg-gray-800' : 'border-gray-800 bg-gray-900 hover:bg-gray-800'
                }`}
              >
                <div className="text-sm text-white font-medium">{t.name}</div>
                <div className="text-xs text-gray-400 truncate mt-1">{t.body}</div>
              </button>
            ))}
          </div>
        </div>

        <div>
          {editing && (
            <div className="bg-gray-900 border border-gray-800 rounded p-4 space-y-3">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Template name"
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white"
              />
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
                placeholder="Hi {{customer_name}}, your ticket #{{ticket_number}} is ready for pickup."
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white font-mono"
              />
              <div className="flex justify-between">
                <button
                  onClick={() => save.mutate()}
                  disabled={save.isPending || !name || !body}
                  className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 rounded text-sm text-white"
                >
                  {save.isPending ? 'Saving…' : editing.id ? 'Update' : 'Create'}
                </button>
                {editing.id && (
                  <button onClick={() => del.mutate(editing.id)} className="text-red-400 hover:text-red-300 text-sm">
                    Delete
                  </button>
                )}
              </div>
            </div>
          )}
          {!editing && <div className="text-sm text-gray-500">Pick a template to edit, or create a new one.</div>}
        </div>
      </div>
    </div>
  );
}
