import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  listUsers, updateUser, inviteUser,
  setUserActive, listRoleAudit,
  listInvitations, createInvitation, deleteInvitation,
} from '../lib/api.js';
import type { User as AppUser, UserRole } from '../../../types/index.js';

const ROLES = ['owner', 'tech', 'viewer'];

export function Users() {
  const qc = useQueryClient();
  const { data: users = [], isLoading } = useQuery<AppUser[]>({
    queryKey: ['users'],
    queryFn: listUsers,
  });
  const { data: invites = [] } = useQuery({ queryKey: ['invitations'], queryFn: listInvitations });

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState('viewer');
  const [inviting, setInviting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState('viewer');
  const [auditUserId, setAuditUserId] = useState<string | null>(null);

  const auditQ = useQuery({
    queryKey: ['role-audit', auditUserId],
    queryFn: () => auditUserId ? listRoleAudit(auditUserId) : Promise.resolve([]),
    enabled: !!auditUserId,
  });

  const startEdit = (u: AppUser) => {
    setEditingId(u.id);
    setEditRole(u.role as string);
  };

  const saveRole = async (id: string) => {
    try {
      await updateUser(id, { role: editRole as UserRole });
      toast.success('Role updated');
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['role-audit'] });
      setEditingId(null);
    } catch {
      toast.error('Update failed');
    }
  };

  const activeM = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => setUserActive(id, active),
    onSuccess: () => {
      toast.success('Updated');
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: () => toast.error('Failed'),
  });

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail) return;
    setInviting(true);
    try {
      // Use the new Phase-4 token + Resend flow (which falls back to the
      // Supabase magic-link invite if RESEND_API_KEY is missing).
      const r = await createInvitation({ email: inviteEmail, role: inviteRole });
      if (r.email_sent) toast.success(`Invite sent to ${inviteEmail}`);
      else if (r.email_suppressed) {
        toast(`Invite created but email provider not configured. Share: ${r.accept_url}`, { icon: '⚠️', duration: 8000 });
      } else {
        toast.error(r.email_error ?? 'Invite created but email failed');
      }
      // Optionally also call the older inviteUser to send a Supabase magic link
      try { await inviteUser(inviteEmail, inviteRole, inviteName); } catch { /* ignore */ }
      setInviteEmail(''); setInviteName(''); setInviteRole('viewer');
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['invitations'] });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invite failed';
      toast.error(msg);
    } finally {
      setInviting(false);
    }
  };

  const revokeInvite = async (id: string) => {
    if (!confirm('Revoke this invitation?')) return;
    await deleteInvitation(id);
    qc.invalidateQueries({ queryKey: ['invitations'] });
  };

  const roleColor = (role: string) => ({
    owner: 'bg-yellow-900 text-yellow-300',
    tech: 'bg-blue-900 text-blue-300',
    viewer: 'bg-gray-700 text-gray-400',
  }[role] ?? 'bg-gray-700 text-gray-400');

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-lg font-semibold text-white mb-6">User Management</h1>

      {/* Invite form */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 mb-6">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Invite New User</h2>
        <form onSubmit={handleInvite} className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <input type="email" placeholder="Email address" value={inviteEmail}
            onChange={e => setInviteEmail(e.target.value)} required className="input sm:col-span-2" />
          <input type="text" placeholder="Full name (optional)" value={inviteName}
            onChange={e => setInviteName(e.target.value)} className="input" />
          <select value={inviteRole} onChange={e => setInviteRole(e.target.value)} className="input">
            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <button type="submit" disabled={inviting || !inviteEmail}
            className="btn-primary text-sm py-1.5 sm:col-span-4 disabled:opacity-50">
            {inviting ? 'Sending…' : 'Send Invite'}
          </button>
        </form>
      </div>

      {/* Pending invitations */}
      {invites.filter((i) => !i.accepted_at).length > 0 && (
        <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden mb-6">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide px-4 py-3">Pending Invitations</h2>
          <table className="w-full text-sm">
            <tbody>
              {invites.filter((i) => !i.accepted_at).map((i) => (
                <tr key={i.id} className="border-t border-gray-800">
                  <td className="px-4 py-2 text-gray-300">{i.email}</td>
                  <td className="px-4 py-2 text-gray-500 text-xs">{i.role}</td>
                  <td className="px-4 py-2 text-gray-500 text-xs">expires {new Date(i.expires_at).toLocaleDateString()}</td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => revokeInvite(i.id)} className="text-xs text-red-400 hover:text-red-300">Revoke</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Users table */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500 border-b border-gray-800">
              <th className="px-4 py-2.5 text-left font-medium">Name</th>
              <th className="px-4 py-2.5 text-left font-medium">Email</th>
              <th className="px-4 py-2.5 text-left font-medium">Role</th>
              <th className="px-4 py-2.5 text-left font-medium">Phone</th>
              <th className="px-4 py-2.5 text-left font-medium">Status</th>
              <th className="px-4 py-2.5 text-left font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-600">Loading…</td></tr>
            )}
            {(users as Array<AppUser & { is_active?: boolean }>).map(u => (
              <tr key={u.id} className="border-b border-gray-800 last:border-0">
                <td className="px-4 py-2.5 text-gray-300">{u.full_name || '—'}</td>
                <td className="px-4 py-2.5 text-gray-400 text-xs font-mono">{u.email}</td>
                <td className="px-4 py-2.5">
                  {editingId === u.id ? (
                    <select value={editRole} onChange={e => setEditRole(e.target.value)} className="input py-0.5 text-xs">
                      {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : (
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${roleColor(u.role)}`}>{u.role}</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-gray-500 text-xs font-mono">{u.phone ?? '—'}</td>
                <td className="px-4 py-2.5 text-xs">
                  {u.is_active === false
                    ? <span className="bg-red-900 text-red-300 px-1.5 py-0.5 rounded">Deactivated</span>
                    : <span className="bg-green-900 text-green-300 px-1.5 py-0.5 rounded">Active</span>}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex gap-3 items-center">
                    {editingId === u.id ? (
                      <>
                        <button onClick={() => saveRole(u.id)} className="text-xs text-green-400 hover:text-green-300">Save</button>
                        <button onClick={() => setEditingId(null)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
                      </>
                    ) : (
                      <button onClick={() => startEdit(u)} className="text-xs text-brand-500 hover:text-brand-400">Edit role</button>
                    )}
                    <button
                      onClick={() => activeM.mutate({ id: u.id, active: u.is_active === false })}
                      className="text-xs text-amber-400 hover:text-amber-300">
                      {u.is_active === false ? 'Reactivate' : 'Deactivate'}
                    </button>
                    <button onClick={() => setAuditUserId(auditUserId === u.id ? null : u.id)}
                      className="text-xs text-gray-400 hover:text-gray-200">
                      {auditUserId === u.id ? 'Hide audit' : 'Audit'}
                    </button>
                  </div>
                  {auditUserId === u.id && (
                    <div className="mt-2 bg-gray-950 border border-gray-800 rounded p-2 text-xs text-gray-400 max-w-md">
                      {(auditQ.data ?? []).length === 0 && <div>No role changes recorded.</div>}
                      {(auditQ.data ?? []).map((a) => (
                        <div key={a.id} className="border-b border-gray-800 last:border-0 py-1">
                          <span className="text-gray-500">{new Date(a.created_at).toLocaleString()}</span>{' '}
                          <span className="text-gray-300">{a.old_role ?? '∅'} → {a.new_role}</span>{' '}
                          {a.changer && <span className="text-gray-600">by {a.changer.email}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
