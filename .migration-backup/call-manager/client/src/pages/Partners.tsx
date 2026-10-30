import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  listOrganizations, createOrganization, deleteOrganization,
  listOrgMembers, addOrgMember, removeOrgMember,
  listUsers,
} from '../lib/api.js';

export function Partners() {
  const qc = useQueryClient();
  const orgsQ = useQuery({ queryKey: ['organizations'], queryFn: listOrganizations });
  const usersQ = useQuery({ queryKey: ['users'], queryFn: listUsers });
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [selectedOrg, setSelectedOrg] = useState<string | null>(null);
  const [memberUserId, setMemberUserId] = useState('');
  const [memberRole, setMemberRole] = useState('viewer');

  const membersQ = useQuery({
    queryKey: ['org-members', selectedOrg],
    queryFn: () => selectedOrg ? listOrgMembers(selectedOrg) : Promise.resolve([]),
    enabled: !!selectedOrg,
  });

  const createM = useMutation({
    mutationFn: createOrganization,
    onSuccess: () => {
      toast.success('Partner organization created');
      setName(''); setParentId('');
      qc.invalidateQueries({ queryKey: ['organizations'] });
      qc.invalidateQueries({ queryKey: ['my-organizations'] });
    },
    onError: () => toast.error('Failed to create org'),
  });
  const deleteM = useMutation({
    mutationFn: deleteOrganization,
    onSuccess: () => {
      toast.success('Deleted');
      qc.invalidateQueries({ queryKey: ['organizations'] });
      setSelectedOrg(null);
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Delete failed'),
  });
  const addMemberM = useMutation({
    mutationFn: () => selectedOrg ? addOrgMember(selectedOrg, memberUserId, memberRole) : Promise.reject(),
    onSuccess: () => {
      toast.success('Member added');
      setMemberUserId('');
      qc.invalidateQueries({ queryKey: ['org-members', selectedOrg] });
    },
    onError: () => toast.error('Failed to add member'),
  });
  const removeMemberM = useMutation({
    mutationFn: (userId: string) => selectedOrg ? removeOrgMember(selectedOrg, userId) : Promise.reject(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org-members', selectedOrg] });
    },
  });

  return (
    <>
      <div className="p-6 max-w-5xl">
        <h1 className="text-xl font-semibold text-white mb-1">Partner Organizations</h1>
        <p className="text-sm text-gray-500 mb-6">Manage child organizations (e.g. resold deployments). Most installs only need the default organization.</p>

        <div className="bg-gray-900 border border-gray-800 rounded p-4 mb-6">
          <h2 className="text-sm font-medium text-white mb-3">Create new partner org</h2>
          <form
            onSubmit={(e) => { e.preventDefault(); if (name) createM.mutate({ name, parent_org_id: parentId || null }); }}
            className="flex flex-wrap gap-2"
          >
            <input
              value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Partner name"
              className="flex-1 min-w-[200px] bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white"
            />
            <select
              value={parentId} onChange={(e) => setParentId(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white"
            >
              <option value="">No parent</option>
              {(orgsQ.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <button type="submit" disabled={createM.isPending}
              className="bg-brand-600 hover:bg-brand-500 text-white px-4 py-2 rounded text-sm disabled:opacity-50">
              {createM.isPending ? 'Creating…' : 'Create'}
            </button>
          </form>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-gray-900 border border-gray-800 rounded">
            <h2 className="text-sm font-medium text-white px-4 py-3 border-b border-gray-800">All organizations</h2>
            <div className="divide-y divide-gray-800">
              {(orgsQ.data ?? []).map((o) => (
                <div key={o.id}
                  className={`px-4 py-3 cursor-pointer hover:bg-gray-800 ${selectedOrg === o.id ? 'bg-gray-800' : ''}`}
                  onClick={() => setSelectedOrg(o.id)}>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm text-white">{o.name}</div>
                      <div className="text-xs text-gray-500">
                        {o.parent_org_id ? 'child org' : 'root org'} · {new Date(o.created_at).toLocaleDateString()}
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); if (confirm(`Delete ${o.name}?`)) deleteM.mutate(o.id); }}
                      className="text-xs text-red-400 hover:text-red-300">Delete</button>
                  </div>
                </div>
              ))}
              {orgsQ.data?.length === 0 && <div className="px-4 py-6 text-sm text-gray-500">No organizations</div>}
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded">
            <h2 className="text-sm font-medium text-white px-4 py-3 border-b border-gray-800">
              {selectedOrg ? 'Members' : 'Select an org to manage members'}
            </h2>
            {selectedOrg && (
              <>
                <form
                  onSubmit={(e) => { e.preventDefault(); if (memberUserId) addMemberM.mutate(); }}
                  className="flex gap-2 px-4 py-3 border-b border-gray-800"
                >
                  <select value={memberUserId} onChange={(e) => setMemberUserId(e.target.value)}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-white">
                    <option value="">Add user…</option>
                    {(usersQ.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
                  </select>
                  <select value={memberRole} onChange={(e) => setMemberRole(e.target.value)}
                    className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-white">
                    {['owner', 'admin', 'tech', 'viewer'].map((r) => <option key={r}>{r}</option>)}
                  </select>
                  <button type="submit" className="bg-brand-600 hover:bg-brand-500 text-white px-3 py-1.5 rounded text-sm">Add</button>
                </form>
                <div className="divide-y divide-gray-800">
                  {(membersQ.data ?? []).map((m) => (
                    <div key={m.user.id} className="px-4 py-2 flex items-center justify-between">
                      <div>
                        <div className="text-sm text-white">{m.user.full_name || m.user.email}</div>
                        <div className="text-xs text-gray-500">{m.user.email} · {m.role}</div>
                      </div>
                      <button onClick={() => removeMemberM.mutate(m.user.id)}
                        className="text-xs text-red-400 hover:text-red-300">Remove</button>
                    </div>
                  ))}
                  {membersQ.data?.length === 0 && <div className="px-4 py-6 text-sm text-gray-500">No members</div>}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
