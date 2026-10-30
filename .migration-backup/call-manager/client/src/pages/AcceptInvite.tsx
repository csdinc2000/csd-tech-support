import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { acceptInvitation } from '../lib/api.js';
import { supabase } from '../lib/supabase.js';

export function AcceptInvite() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') ?? '';
  const navigate = useNavigate();

  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) { setError('Missing invitation token'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    setSubmitting(true); setError(null);
    try {
      await acceptInvitation({ token, password, full_name: fullName });
      // Auto sign-in: client-side login flow handles email lookup via the token's email
      // We just redirect to login with a success message.
      setDone(true);
      toast.success('Account created. Please sign in.');
      setTimeout(() => navigate('/login'), 1500);
    } catch (err: unknown) {
      setError((err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Failed to accept invitation');
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 text-gray-200 p-6">
        <div className="bg-gray-900 border border-gray-800 rounded p-6 max-w-md">
          <h1 className="text-lg font-semibold text-red-400 mb-2">Invalid invitation link</h1>
          <p className="text-sm text-gray-400">This page needs a token in the URL. Please use the link from your invitation email.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 text-gray-200 p-6">
      <div className="bg-gray-900 border border-gray-800 rounded p-6 w-full max-w-md">
        <h1 className="text-lg font-semibold text-white mb-1">Accept invitation</h1>
        <p className="text-sm text-gray-500 mb-6">Set up your CSD Call Manager account.</p>

        {done ? (
          <p className="text-sm text-green-400">Account created. Redirecting you to sign in…</p>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your full name"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="Choose a password (min 8 chars)" autoComplete="new-password"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
            {error && <div className="text-xs text-red-400">{error}</div>}
            <button type="submit" disabled={submitting}
              className="w-full bg-brand-600 hover:bg-brand-500 text-white py-2 rounded text-sm disabled:opacity-50">
              {submitting ? 'Creating account…' : 'Accept invitation'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// Silence unused-import warnings for supabase (kept for future auto sign-in)
void supabase;
