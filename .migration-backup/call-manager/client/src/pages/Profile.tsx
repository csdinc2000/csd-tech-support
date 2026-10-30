import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { useMutation } from '@tanstack/react-query';
import { updateUser } from '../lib/api.js';
import { supabase } from '../lib/supabase.js';
import type { User as AppUser } from '../../../types/index.js';

const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu', 'UTC',
];

export function Profile({ profile }: { profile: AppUser | null }) {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [newPassword, setNewPassword] = useState('');

  useEffect(() => {
    if (!profile) return;
    setFullName(profile.full_name ?? '');
    setPhone(profile.phone ?? '');
    setTimezone((profile as AppUser & { timezone?: string }).timezone ?? 'America/New_York');
  }, [profile]);

  const saveM = useMutation({
    mutationFn: () => profile ? updateUser(profile.id, { full_name: fullName, phone, timezone } as Parameters<typeof updateUser>[1]) : Promise.reject(),
    onSuccess: () => toast.success('Profile saved'),
    onError: () => toast.error('Save failed'),
  });

  const passwordM = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
    },
    onSuccess: () => { toast.success('Password updated'); setNewPassword(''); },
    onError: (e: { message?: string }) => toast.error(e.message ?? 'Password change failed'),
  });

  if (!profile) return <div className="p-6 text-gray-500">Loading…</div>;

  return (
    <>
      <div className="p-6 max-w-2xl">
        <h1 className="text-xl font-semibold text-white mb-6">Profile</h1>

        <div className="bg-gray-900 border border-gray-800 rounded p-5 space-y-4">
          <Field label="Email">
            <div className="text-sm text-gray-400">{profile.email}</div>
            <div className="text-xs text-gray-600">Email is set at signup and cannot be changed here.</div>
          </Field>
          <Field label="Full name">
            <input value={fullName} onChange={(e) => setFullName(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
          </Field>
          <Field label="Phone (for SMS notifications)">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+15555550100"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
          </Field>
          <Field label="Timezone">
            <select value={timezone} onChange={(e) => setTimezone(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white">
              {TIMEZONES.map((tz) => <option key={tz}>{tz}</option>)}
            </select>
          </Field>
          <div>
            <button onClick={() => saveM.mutate()} disabled={saveM.isPending}
              className="bg-brand-600 hover:bg-brand-500 text-white px-4 py-2 rounded text-sm disabled:opacity-50">
              {saveM.isPending ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded p-5 mt-6 space-y-3">
          <h2 className="text-sm font-medium text-white">Change password</h2>
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
            placeholder="New password (min 8 chars)" autoComplete="new-password"
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
          <button onClick={() => passwordM.mutate()}
            disabled={passwordM.isPending || newPassword.length < 8}
            className="bg-brand-600 hover:bg-brand-500 text-white px-4 py-2 rounded text-sm disabled:opacity-50">
            {passwordM.isPending ? 'Updating…' : 'Update password'}
          </button>
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}
