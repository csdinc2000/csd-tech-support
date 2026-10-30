import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listBusinessHours,
  saveBusinessHours,
  listHolidays,
  addHoliday,
  deleteHoliday,
} from '../lib/api.js';
import type { BusinessHours, Holiday } from '../../../types/index.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function Hours() {
  const qc = useQueryClient();
  const { data: hours = [] } = useQuery({ queryKey: ['business-hours'], queryFn: listBusinessHours });
  const { data: holidays = [] } = useQuery({ queryKey: ['holidays'], queryFn: listHolidays });

  const [rows, setRows] = useState<BusinessHours[]>([]);
  useEffect(() => {
    // Initialize 7 rows from server data, filling missing days with closed
    const byDay = new Map(hours.map((h) => [h.day_of_week, h]));
    const next: BusinessHours[] = DAYS.map((_, i) => {
      const existing = byDay.get(i);
      return (
        existing ?? {
          id: '',
          day_of_week: i,
          open_time: null,
          close_time: null,
          timezone: 'America/New_York',
          created_at: '',
        }
      );
    });
    setRows(next);
  }, [hours]);

  const saveMut = useMutation({
    mutationFn: () =>
      saveBusinessHours(
        rows.map((r) => ({
          day_of_week: r.day_of_week,
          open_time: r.open_time ? r.open_time.slice(0, 5) : null,
          close_time: r.close_time ? r.close_time.slice(0, 5) : null,
          timezone: r.timezone,
        })),
      ),
    onSuccess: () => {
      toast.success('Business hours saved');
      qc.invalidateQueries({ queryKey: ['business-hours'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [hDate, setHDate] = useState('');
  const [hLabel, setHLabel] = useState('');
  const addHolidayMut = useMutation({
    mutationFn: () => addHoliday(hDate, hLabel, true),
    onSuccess: () => {
      toast.success('Holiday added');
      setHDate('');
      setHLabel('');
      qc.invalidateQueries({ queryKey: ['holidays'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const delHolidayMut = useMutation({
    mutationFn: (id: string) => deleteHoliday(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['holidays'] }),
  });

  function update(idx: number, field: 'open_time' | 'close_time', value: string) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value || null } : r)));
  }

  function toggleClosed(idx: number, closed: boolean) {
    setRows((prev) =>
      prev.map((r, i) =>
        i === idx
          ? closed
            ? { ...r, open_time: null, close_time: null }
            : { ...r, open_time: '09:00', close_time: '18:00' }
          : r,
      ),
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-lg font-semibold text-white mb-1">Business Hours</h1>
      <p className="text-sm text-gray-500 mb-6">Configure when calls hit the open IVR vs. the after-hours IVR.</p>

      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden mb-8">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 border-b border-gray-800">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Day</th>
              <th className="px-4 py-2.5 text-left font-medium">Closed</th>
              <th className="px-4 py-2.5 text-left font-medium">Open</th>
              <th className="px-4 py-2.5 text-left font-medium">Close</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const closed = !r.open_time || !r.close_time;
              return (
                <tr key={i} className="border-b border-gray-800 last:border-0">
                  <td className="px-4 py-2.5 text-gray-300">{DAYS[i]}</td>
                  <td className="px-4 py-2.5">
                    <input
                      type="checkbox"
                      checked={closed}
                      onChange={(e) => toggleClosed(i, e.target.checked)}
                      className="accent-brand-600"
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <input
                      type="time"
                      value={r.open_time?.slice(0, 5) ?? ''}
                      onChange={(e) => update(i, 'open_time', e.target.value)}
                      disabled={closed}
                      className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200 disabled:opacity-40"
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <input
                      type="time"
                      value={r.close_time?.slice(0, 5) ?? ''}
                      onChange={(e) => update(i, 'close_time', e.target.value)}
                      disabled={closed}
                      className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200 disabled:opacity-40"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end mb-10">
        <button
          onClick={() => saveMut.mutate()}
          disabled={saveMut.isPending}
          className="bg-brand-600 hover:bg-brand-500 text-white text-sm px-4 py-2 rounded disabled:opacity-50"
        >
          {saveMut.isPending ? 'Saving…' : 'Save Hours'}
        </button>
      </div>

      <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-3">Holidays</h2>
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-3">
        <div className="flex gap-2 items-end">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Date</label>
            <input
              type="date"
              value={hDate}
              onChange={(e) => setHDate(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-gray-500 mb-1">Label</label>
            <input
              type="text"
              value={hLabel}
              onChange={(e) => setHLabel(e.target.value)}
              placeholder="Memorial Day"
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200"
            />
          </div>
          <button
            onClick={() => hDate && hLabel && addHolidayMut.mutate()}
            disabled={!hDate || !hLabel || addHolidayMut.isPending}
            className="bg-brand-600 hover:bg-brand-500 text-white text-sm px-4 py-1.5 rounded disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 border-b border-gray-800">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Date</th>
              <th className="px-4 py-2.5 text-left font-medium">Label</th>
              <th className="px-4 py-2.5 text-left font-medium">Closed?</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {holidays.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-600 text-sm">No holidays configured</td></tr>
            )}
            {holidays.map((h: Holiday) => (
              <tr key={h.id} className="border-b border-gray-800 last:border-0">
                <td className="px-4 py-2.5 text-gray-300 font-mono text-xs">{h.date}</td>
                <td className="px-4 py-2.5 text-gray-300">{h.label}</td>
                <td className="px-4 py-2.5 text-gray-400">{h.closed ? 'Yes' : 'No'}</td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    onClick={() => delHolidayMut.mutate(h.id)}
                    className="text-red-400 hover:text-red-300 text-xs"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
