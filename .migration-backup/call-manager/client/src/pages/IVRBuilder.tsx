import { useState } from 'react';
import toast from 'react-hot-toast';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listIvrMenus,
  createIvrMenu,
  updateIvrMenu,
  deleteIvrMenu,
  createIvrOption,
  updateIvrOption,
  deleteIvrOption,
  listQueues,
  listAiAssistants,
} from '../lib/api.js';
import type { IvrMenu, IvrOption, IvrAction, AiAssistant } from '../../../types/index.js';

const ACTIONS: IvrAction[] = ['forward', 'voicemail', 'submenu', 'queue', 'hangup', 'ai_assistant'];

export function IVRBuilder() {
  const qc = useQueryClient();
  const { data: menus = [] } = useQuery({ queryKey: ['ivr-menus'], queryFn: listIvrMenus });
  const { data: queues = [] } = useQuery({ queryKey: ['queues'], queryFn: listQueues });
  const { data: assistantsResp } = useQuery({ queryKey: ['ai-assistants'], queryFn: listAiAssistants });
  const assistants: AiAssistant[] = assistantsResp?.items ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = menus.find((m: IvrMenu) => m.id === selectedId) || menus[0];

  const createMut = useMutation({
    mutationFn: () =>
      createIvrMenu({
        name: `menu_${Date.now()}`,
        greeting_text: 'Press 1 for support, 2 for sales.',
        timeout_seconds: 7,
        is_default: false,
        business_hours_state: 'either',
      }),
    onSuccess: (m) => {
      qc.invalidateQueries({ queryKey: ['ivr-menus'] });
      setSelectedId(m.id);
    },
  });

  const updateMenuMut = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<IvrMenu> }) => updateIvrMenu(id, updates),
    onSuccess: () => {
      toast.success('Menu saved');
      qc.invalidateQueries({ queryKey: ['ivr-menus'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMenuMut = useMutation({
    mutationFn: deleteIvrMenu,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ivr-menus'] });
      setSelectedId(null);
    },
  });

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-white mb-1">IVR Builder</h1>
          <p className="text-sm text-gray-500">Configure menu greetings, digits, and actions. Changes apply to live calls immediately.</p>
        </div>
        <button
          onClick={() => createMut.mutate()}
          className="bg-brand-600 hover:bg-brand-500 text-white text-sm px-3 py-1.5 rounded"
        >
          + New Menu
        </button>
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* Menus list */}
        <aside className="col-span-3">
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            {menus.length === 0 && (
              <div className="px-4 py-8 text-center text-gray-600 text-sm">No menus yet</div>
            )}
            {menus.map((m: IvrMenu) => (
              <button
                key={m.id}
                onClick={() => setSelectedId(m.id)}
                className={`w-full text-left px-4 py-3 border-b border-gray-800 last:border-0 transition-colors ${
                  selected?.id === m.id ? 'bg-brand-900/40' : 'hover:bg-gray-800'
                }`}
              >
                <div className="text-sm text-white font-medium">{m.name}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {m.business_hours_state}
                  {m.is_default && ' · default'}
                  {' · '}
                  {m.options?.length ?? 0} options
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* Editor */}
        <section className="col-span-9">
          {selected ? (
            <MenuEditor
              key={selected.id}
              menu={selected}
              queues={queues}
              onSaveMenu={(updates) => updateMenuMut.mutate({ id: selected.id, updates })}
              onDeleteMenu={() => deleteMenuMut.mutate(selected.id)}
              menus={menus}
              assistants={assistants}
            />
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center text-gray-500 text-sm">
              Select or create a menu to begin.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function MenuEditor({
  menu,
  queues,
  menus,
  assistants,
  onSaveMenu,
  onDeleteMenu,
}: {
  menu: IvrMenu;
  queues: { id: string; name: string }[];
  menus: IvrMenu[];
  assistants: AiAssistant[];
  onSaveMenu: (updates: Partial<IvrMenu>) => void;
  onDeleteMenu: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(menu.name);
  const [greeting, setGreeting] = useState(menu.greeting_text);
  const [audioUrl, setAudioUrl] = useState(menu.greeting_audio_url ?? '');
  const [timeout, setTimeout] = useState(menu.timeout_seconds);
  const [isDefault, setIsDefault] = useState(menu.is_default);
  const [state, setState] = useState(menu.business_hours_state);

  const addOptMut = useMutation({
    mutationFn: () =>
      createIvrOption({
        menu_id: menu.id,
        digit: '1',
        label: 'New option',
        action: 'forward',
        target: 'OWNER_FORWARD',
        sort_order: (menu.options?.length ?? 0) + 1,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ivr-menus'] }),
  });

  const updateOptMut = useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<IvrOption> }) => updateIvrOption(id, updates),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ivr-menus'] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteOptMut = useMutation({
    mutationFn: deleteIvrOption,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ivr-menus'] }),
  });

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-5">
      <div className="grid grid-cols-2 gap-4 mb-4">
        <Field label="Name (slug)">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200"
          />
        </Field>
        <Field label="Business hours state">
          <select
            value={state}
            onChange={(e) => setState(e.target.value as IvrMenu['business_hours_state'])}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200"
          >
            <option value="open">open</option>
            <option value="closed">closed</option>
            <option value="either">either</option>
          </select>
        </Field>
        <Field label="Timeout (seconds)">
          <input
            type="number"
            min={1}
            max={60}
            value={timeout}
            onChange={(e) => setTimeout(parseInt(e.target.value, 10))}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200"
          />
        </Field>
        <Field label="Default for this state?">
          <label className="flex items-center gap-2 mt-1">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="accent-brand-600"
            />
            <span className="text-xs text-gray-400">Yes — calls in this state route here</span>
          </label>
        </Field>
        <Field label="Greeting text" className="col-span-2">
          <textarea
            rows={3}
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200"
          />
        </Field>
        <Field label="Greeting audio URL (optional)" className="col-span-2">
          <input
            value={audioUrl}
            onChange={(e) => setAudioUrl(e.target.value)}
            placeholder="https://…/greeting.mp3 (overrides text)"
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200"
          />
        </Field>
      </div>

      <div className="flex justify-between mb-6">
        <button
          onClick={onDeleteMenu}
          className="text-red-400 hover:text-red-300 text-sm"
        >
          Delete menu
        </button>
        <button
          onClick={() =>
            onSaveMenu({
              name,
              greeting_text: greeting,
              greeting_audio_url: audioUrl || null,
              timeout_seconds: timeout,
              is_default: isDefault,
              business_hours_state: state,
            })
          }
          className="bg-brand-600 hover:bg-brand-500 text-white text-sm px-4 py-1.5 rounded"
        >
          Save Menu
        </button>
      </div>

      <div className="border-t border-gray-800 pt-5">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Digit Options</h3>
          <button
            onClick={() => addOptMut.mutate()}
            className="bg-gray-800 hover:bg-gray-700 text-white text-xs px-3 py-1 rounded"
          >
            + Add option
          </button>
        </div>

        <div className="space-y-2">
          {(menu.options ?? []).map((o) => (
            <OptionRow
              key={o.id}
              option={o}
              menus={menus}
              queues={queues}
              assistants={assistants}
              onSave={(updates) => updateOptMut.mutate({ id: o.id, updates })}
              onDelete={() => deleteOptMut.mutate(o.id)}
            />
          ))}
          {(menu.options ?? []).length === 0 && (
            <div className="text-center text-gray-600 text-sm py-6 border border-dashed border-gray-800 rounded">
              No options yet — add one above.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OptionRow({
  option,
  menus,
  queues,
  assistants,
  onSave,
  onDelete,
}: {
  option: IvrOption;
  menus: IvrMenu[];
  queues: { id: string; name: string }[];
  assistants: AiAssistant[];
  onSave: (updates: Partial<IvrOption>) => void;
  onDelete: () => void;
}) {
  const [digit, setDigit] = useState(option.digit);
  const [label, setLabel] = useState(option.label);
  const [action, setAction] = useState<IvrAction>(option.action);
  const [target, setTarget] = useState(option.target ?? '');
  const [sortOrder, setSortOrder] = useState(option.sort_order);

  const targetEditor = () => {
    if (action === 'forward') {
      return (
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="+15551234567 or OWNER_FORWARD"
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200"
        />
      );
    }
    if (action === 'submenu') {
      return (
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200"
        >
          <option value="">— select menu —</option>
          {menus.filter((m) => m.id !== option.menu_id).map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      );
    }
    if (action === 'queue') {
      return (
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200"
        >
          <option value="">— select queue —</option>
          {queues.map((q) => (
            <option key={q.id} value={q.id}>{q.name}</option>
          ))}
        </select>
      );
    }
    if (action === 'ai_assistant') {
      const active = assistants.filter((a) => a.is_active && a.vapi_assistant_id);
      return (
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200"
        >
          <option value="">— select assistant —</option>
          {active.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      );
    }
    return <span className="text-xs text-gray-500 italic">No target needed</span>;
  };

  return (
    <div className="bg-gray-950 border border-gray-800 rounded p-3 grid grid-cols-12 gap-2 items-center">
      <input
        value={digit}
        onChange={(e) => setDigit(e.target.value.slice(0, 1))}
        className="col-span-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-center text-gray-200 font-mono"
      />
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Label"
        className="col-span-3 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200"
      />
      <select
        value={action}
        onChange={(e) => setAction(e.target.value as IvrAction)}
        className="col-span-2 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200"
      >
        {ACTIONS.map((a) => (
          <option key={a} value={a}>{a}</option>
        ))}
      </select>
      <div className="col-span-3">{targetEditor()}</div>
      <input
        type="number"
        value={sortOrder}
        onChange={(e) => setSortOrder(parseInt(e.target.value, 10) || 0)}
        className="col-span-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200 text-center"
      />
      <div className="col-span-2 flex justify-end gap-2">
        <button
          onClick={() => onSave({ digit, label, action, target: target || null, sort_order: sortOrder })}
          className="bg-brand-600 hover:bg-brand-500 text-white text-xs px-2 py-1 rounded"
        >
          Save
        </button>
        <button onClick={onDelete} className="text-red-400 hover:text-red-300 text-xs">
          ✕
        </button>
      </div>
    </div>
  );
}

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  );
}
