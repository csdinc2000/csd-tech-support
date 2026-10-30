import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase.js';
import { listMyOrganizations } from '../lib/api.js';
import type { User as AppUser } from '../../../types/index.js';

interface NavItem { to: string; label: string; icon: string; ownerOnly?: boolean; multiOrgOnly?: boolean }
const NAV: NavItem[] = [
  { to: '/',           label: 'Dashboard',  icon: '⊞' },
  { to: '/calls',      label: 'Call Log',   icon: '☎' },
  { to: '/voicemails', label: 'Voicemails', icon: '✉' },
  { to: '/messages',   label: 'Messages',   icon: '💬' },
  { to: '/analytics',  label: 'Analytics',  icon: '📊' },
  { to: '/dial',       label: 'Dial',       icon: '✆' },
  { to: '/admin/hours',           label: 'Hours',           icon: '🕒', ownerOnly: true },
  { to: '/admin/ivr',             label: 'IVR',             icon: '☷', ownerOnly: true },
  { to: '/admin/queues',          label: 'Queues',          icon: '⇉', ownerOnly: true },
  { to: '/admin/templates',       label: 'SMS Templates',   icon: '✎', ownerOnly: true },
  { to: '/admin/blacklist',       label: 'Blacklist',       icon: '⊘', ownerOnly: true },
  { to: '/admin/dnc',             label: 'DNC List',        icon: '✕', ownerOnly: true },
  { to: '/admin/spam',            label: 'Spam',            icon: '🛡', ownerOnly: true },
  { to: '/users',                 label: 'Users',           icon: '⊙', ownerOnly: true },
  { to: '/admin/email-templates', label: 'Email Templates', icon: '✉', ownerOnly: true },
  { to: '/admin/integrations',    label: 'Integrations',    icon: '◎', ownerOnly: true },
  { to: '/admin/ai/assistants',   label: 'AI Assistants',   icon: '🤖', ownerOnly: true },
  { to: '/admin/ai/campaigns',    label: 'AI Campaigns',    icon: '📢', ownerOnly: true },
  { to: '/ai/sessions',           label: 'AI Sessions',     icon: '💭' },
  { to: '/admin/partners',        label: 'Partners',        icon: '⌬', ownerOnly: true, multiOrgOnly: true },
  { to: '/notifications', label: 'Notifications', icon: '🔔' },
  { to: '/profile',       label: 'Profile',       icon: '👤' },
  { to: '/settings',      label: 'Settings',      icon: '⚙' },
];

export function Layout({ children, profile }: { children: React.ReactNode; profile: AppUser | null }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const myOrgsQ = useQuery({
    queryKey: ['my-organizations'],
    queryFn: listMyOrganizations,
    enabled: !!profile,
    staleTime: 60_000,
  });
  const showPartners = (myOrgsQ.data?.length ?? 0) > 1;

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    navigate('/login');
  };

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100 font-sans">
      {/* Sidebar */}
      <aside className="w-52 shrink-0 flex flex-col bg-gray-900 border-r border-gray-800">
        <div className="px-4 py-4 border-b border-gray-800">
          <span className="text-sm font-bold tracking-wide text-white">CSD Call Manager</span>
          <div className="text-xs text-gray-500 mt-0.5">Computer Systems Depot</div>
        </div>

        <nav className="flex-1 py-3 space-y-0.5 px-2">
          {NAV.filter(n => (!n.ownerOnly || profile?.role === 'owner') && (!n.multiOrgOnly || showPartners)).map(n => {
            const active = pathname === n.to || (n.to !== '/' && pathname.startsWith(n.to));
            return (
              <Link
                key={n.to}
                to={n.to}
                className={`flex items-center gap-2.5 px-3 py-2 rounded text-sm transition-colors ${
                  active
                    ? 'bg-brand-600 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-800'
                }`}
              >
                <span className="text-base leading-none">{n.icon}</span>
                {n.label}
              </Link>
            );
          })}
        </nav>

        <div className="px-4 py-3 border-t border-gray-800 text-xs text-gray-500">
          <div className="truncate">{profile?.email ?? ''}</div>
          <div className="capitalize mt-0.5 text-gray-600">{profile?.role}</div>
          <button
            onClick={handleSignOut}
            className="mt-2 text-red-400 hover:text-red-300 transition-colors"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto bg-gray-950">
        {children}
      </main>
    </div>
  );
}
