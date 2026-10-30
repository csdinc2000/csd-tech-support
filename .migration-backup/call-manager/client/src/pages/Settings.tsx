import { useState } from 'react';
import toast from 'react-hot-toast';
import { supabase } from '../lib/supabase.js';
import { updateUser } from '../lib/api.js';
import type { User as AppUser } from '../../../types/index.js';

export function Settings({ profile }: { profile: AppUser | null }) {
  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    setSavingProfile(true);
    try {
      await updateUser(profile.id, { full_name: fullName, phone });
      toast.success('Profile updated');
    } catch {
      toast.error('Failed to update profile');
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    setSavingPassword(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      toast.success('Password changed');
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to change password';
      toast.error(msg);
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="p-6 max-w-xl mx-auto">
      <h1 className="text-lg font-semibold text-white mb-6">Settings</h1>

      {/* Profile */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 mb-4">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Personal Profile</h2>
        <form onSubmit={saveProfile} className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Email</label>
            <input type="email" value={profile?.email ?? ''} disabled className="input w-full opacity-50" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Full Name</label>
            <input
              type="text"
              value={fullName}
              onChange={e => setFullName(e.target.value)}
              className="input w-full"
              placeholder="Your name"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Phone (for future click-to-call routing)</label>
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              className="input w-full"
              placeholder="+15551234567"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Role</label>
            <input type="text" value={profile?.role ?? ''} disabled className="input w-full opacity-50 capitalize" />
          </div>
          <button type="submit" disabled={savingProfile} className="btn-primary text-sm px-4 py-1.5 disabled:opacity-50">
            {savingProfile ? 'Saving…' : 'Save Profile'}
          </button>
        </form>
      </div>

      {/* Password */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Change Password</h2>
        <form onSubmit={savePassword} className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">New Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className="input w-full"
              placeholder="At least 8 characters"
              minLength={8}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Confirm New Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              className="input w-full"
              placeholder="Repeat new password"
            />
          </div>
          <button type="submit" disabled={savingPassword || !newPassword} className="btn-primary text-sm px-4 py-1.5 disabled:opacity-50">
            {savingPassword ? 'Changing…' : 'Change Password'}
          </button>
        </form>
        <p className="text-xs text-gray-600 mt-3">
          For magic-link accounts, setting a password here enables password login.
        </p>
      </div>
    </div>
  );
}
