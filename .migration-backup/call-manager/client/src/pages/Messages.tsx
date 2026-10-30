import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listMessageThreads,
  getMessageThread,
  sendMessage,
  listTemplates,
  openMessagesStream,
  type Message,
  type MessageTemplate,
} from '../lib/api.js';

function formatTs(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function Messages() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pickedTemplate, setPickedTemplate] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const threadsQ = useQuery({ queryKey: ['msg-threads'], queryFn: listMessageThreads });
  const templatesQ = useQuery({ queryKey: ['templates'], queryFn: listTemplates });
  const threadQ = useQuery({
    queryKey: ['msg-thread', selected],
    queryFn: () => (selected ? getMessageThread(selected) : Promise.resolve(null)),
    enabled: !!selected,
  });

  // SSE for real-time updates
  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    (async () => {
      try {
        es = await openMessagesStream();
        es.addEventListener('message:new', () => {
          if (cancelled) return;
          qc.invalidateQueries({ queryKey: ['msg-threads'] });
          if (selected) qc.invalidateQueries({ queryKey: ['msg-thread', selected] });
        });
        es.addEventListener('message:status', () => {
          if (cancelled) return;
          if (selected) qc.invalidateQueries({ queryKey: ['msg-thread', selected] });
        });
      } catch (err) {
        console.warn('SSE unavailable', err);
      }
    })();
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [qc, selected]);

  // Scroll to bottom on new thread / messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [threadQ.data?.messages.length, selected]);

  const sendM = useMutation({
    mutationFn: (payload: { to_number: string; body?: string; template_id?: string }) => sendMessage(payload),
    onSuccess: () => {
      setDraft('');
      setPickedTemplate('');
      setOriginalTemplateBody('');
      setError(null);
      qc.invalidateQueries({ queryKey: ['msg-threads'] });
      if (selected) qc.invalidateQueries({ queryKey: ['msg-thread', selected] });
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        (err as Error).message;
      setError(msg ?? 'Send failed');
    },
  });

  // Resolve {{customer_name}} / {{ticket_number}} client-side from the thread
  // contact so the user sees the actual text that will be sent.
  const resolvePlaceholders = (text: string): string => {
    const c = threadQ.data?.contact;
    return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
      if (key === 'customer_name') return c?.customer_name ?? '';
      if (key === 'ticket_number') return c?.ticket_number ?? '';
      return '';
    });
  };

  // Track the unedited template body so we can decide whether to send the
  // template_id (server re-renders fresh) or the user-edited body.
  const [originalTemplateBody, setOriginalTemplateBody] = useState('');

  const applyTemplate = (id: string) => {
    setPickedTemplate(id);
    const t = templatesQ.data?.find((x) => x.id === id);
    if (t) {
      const resolved = resolvePlaceholders(t.body);
      setDraft(resolved);
      setOriginalTemplateBody(resolved);
    }
  };

  const handleSend = () => {
    if (!selected) return;
    if (!draft.trim()) {
      setError('Message body required');
      return;
    }
    // If the user didn't edit the template-filled draft, send template_id so the
    // server renders against the most current contact data. Otherwise send the
    // edited body verbatim.
    const usedTemplateUntouched = pickedTemplate && draft === originalTemplateBody;
    sendM.mutate(
      usedTemplateUntouched
        ? { to_number: selected, template_id: pickedTemplate }
        : { to_number: selected, body: draft },
    );
  };

  return (
    <div className="flex h-full">
      {/* Threads list */}
      <aside className="w-80 shrink-0 border-r border-gray-800 bg-gray-900 flex flex-col">
        <div className="px-4 py-3 border-b border-gray-800">
          <h1 className="text-sm font-semibold text-white">Messages</h1>
          <NewThreadInput onPick={setSelected} />
        </div>
        <div className="flex-1 overflow-auto">
          {threadsQ.isLoading && <div className="p-4 text-sm text-gray-500">Loading…</div>}
          {threadsQ.data?.length === 0 && (
            <div className="p-4 text-sm text-gray-500">No conversations yet.</div>
          )}
          {threadsQ.data?.map((t) => {
            const active = t.thread_key === selected;
            const m = t.last_message;
            return (
              <button
                key={t.thread_key}
                onClick={() => setSelected(t.thread_key)}
                className={`w-full text-left px-4 py-3 border-b border-gray-800 hover:bg-gray-800 transition ${active ? 'bg-gray-800' : ''}`}
              >
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-white font-medium">{t.thread_key}</span>
                  <span className="text-xs text-gray-500">{formatTs(m.created_at)}</span>
                </div>
                <div className="text-xs text-gray-400 truncate mt-0.5">
                  {m.direction === 'outbound' ? '→ ' : ''}
                  {m.body || '(no text)'}
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Conversation pane */}
      <section className="flex-1 flex flex-col bg-gray-950">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
            Select a conversation, or start a new one.
          </div>
        ) : (
          <>
            <header className="px-6 py-3 border-b border-gray-800">
              <div className="text-sm text-white font-semibold">{selected}</div>
              {threadQ.data?.contact?.customer_name && (
                <div className="text-xs text-gray-400">
                  {threadQ.data.contact.customer_name}
                  {threadQ.data.contact.ticket_number ? ` · #${threadQ.data.contact.ticket_number}` : ''}
                </div>
              )}
            </header>

            <div ref={scrollRef} className="flex-1 overflow-auto p-6 space-y-2">
              {threadQ.data?.messages.map((m) => <MessageBubble key={m.id} m={m} />)}
            </div>

            <footer className="border-t border-gray-800 p-4 bg-gray-900">
              {error && (
                <div className="mb-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">
                  {error}
                </div>
              )}
              <div className="flex gap-2 mb-2">
                <select
                  value={pickedTemplate}
                  onChange={(e) => applyTemplate(e.target.value)}
                  className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300"
                >
                  <option value="">— Templates —</option>
                  {templatesQ.data?.map((t: MessageTemplate) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Type a message…"
                  rows={2}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white resize-none focus:outline-none focus:border-brand-500"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSend();
                  }}
                />
                <button
                  onClick={handleSend}
                  disabled={sendM.isPending || !draft.trim()}
                  className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 rounded text-sm text-white"
                >
                  {sendM.isPending ? 'Sending…' : 'Send'}
                </button>
              </div>
              <div className="text-xs text-gray-600 mt-1">⌘/Ctrl+Enter to send</div>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

function MessageBubble({ m }: { m: Message }) {
  const out = m.direction === 'outbound';
  return (
    <div className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-md rounded-lg px-3 py-2 text-sm ${
          out ? 'bg-brand-600 text-white' : 'bg-gray-800 text-gray-100'
        }`}
      >
        <div className="whitespace-pre-wrap break-words">{m.body}</div>
        {m.media_urls?.map((u) => (
          <a key={u} href={u} target="_blank" rel="noreferrer" className="block underline mt-1 text-xs opacity-90">
            attachment
          </a>
        ))}
        <div className="text-[10px] mt-1 opacity-60 flex justify-end gap-2">
          <span>{formatTs(m.created_at)}</span>
          {out && <span className="capitalize">{m.status}</span>}
          {m.error_code && <span className="text-red-200">err {m.error_code}</span>}
        </div>
      </div>
    </div>
  );
}

function NewThreadInput({ onPick }: { onPick: (n: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div className="mt-2 flex gap-1">
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="+15551234567"
        className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white"
      />
      <button
        onClick={() => {
          if (v.trim()) {
            onPick(v.trim());
            setV('');
          }
        }}
        className="px-2 py-1 bg-brand-600 hover:bg-brand-500 rounded text-xs text-white"
      >
        Open
      </button>
    </div>
  );
}
