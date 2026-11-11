import { Link } from "wouter";
import {
  BarChart3, Building2, Code2, Globe, Inbox, Mail, MapPin, MessageCircle, Package, PhoneForwarded, ShieldAlert,
  Store, Target, Ticket, UserCircle, Gift, Megaphone,
} from "lucide-react";
import type { StaffFeature } from "@/hooks/use-admin-access";

type Module = {
  id: string;
  label: string;
  description: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Staff feature the page needs; omitted for public pages. */
  feature?: StaffFeature;
  adminOnly?: boolean;
  /** Public pages open in a new tab so staff keep their place. */
  external?: boolean;
};

/**
 * Every existing module the marketing team works from, grouped by job. The
 * hub links to them rather than duplicating them, so each keeps its own
 * permissions and deep links.
 */
const MODULE_GROUPS: { id: string; title: string; modules: Module[] }[] = [
  {
    id: "pipeline",
    title: "Leads & pipeline",
    modules: [
      { id: "leads", label: "Leads", description: "Every new lead with its source", href: "/crm/leads", icon: UserCircle, feature: "crm" },
      { id: "pipeline", label: "Deals pipeline", description: "Quoted and won work by stage", href: "/crm/pipeline", icon: Target, feature: "crm" },
      { id: "requests", label: "Service requests", description: "Intake form and voice submissions", href: "/admin/intakes", icon: Inbox, feature: "crm" },
      { id: "customers", label: "Customers", description: "Contacts and accounts to re-engage", href: "/crm/customers", icon: Building2, feature: "crm" },
      { id: "referrals", label: "Referral program", description: "Review referrals and issue rewards", href: "/marketing/referrals", icon: Gift, feature: "crm" },
      { id: "vouchers", label: "Discount vouchers", description: "Email a % off code and redeem it at checkout", href: "/marketing/vouchers", icon: Ticket, feature: "crm" },
    ],
  },
  {
    id: "outreach",
    title: "Outreach",
    modules: [
      { id: "inbox", label: "Shared text inbox", description: "Texts from the main business line", href: "/messages", icon: MessageCircle, feature: "communications" },
      { id: "email", label: "Email from Support", description: "One-to-one customer email", href: "/comms/email", icon: Mail, feature: "communications" },
      { id: "tracking", label: "Call tracking", description: "Tracking numbers, campaigns and call log", href: "/admin/call-tracking", icon: PhoneForwarded, feature: "communications", adminOnly: true },
      { id: "offers", label: "Catalog offers", description: "Products and services to promote", href: "/invoices/catalog", icon: Package, feature: "invoices", adminOnly: true },
    ],
  },
  {
    id: "web",
    title: "Website & listings",
    modules: [
      { id: "landing", label: "Home page", description: "Public landing page", href: "/", icon: Globe, external: true },
      { id: "local", label: "Local service page", description: "Service-area landing page", href: "/local-service", icon: MapPin, external: true },
      { id: "seo", label: "Local SEO services", description: "Our Google Business & citations offer", href: "/local-seo-services", icon: Target, external: true },
      { id: "scam", label: "Scam check guide", description: "Shareable safety content", href: "/scam-check-guide", icon: ShieldAlert, external: true },
      { id: "portal-ads", label: "Portal popup ads", description: "Offers shown on the customer portal", href: "/marketing/portal-ads", icon: Megaphone, feature: "crm" },
      { id: "portal-referrals", label: "Refer-a-friend page", description: "Where customers join the program", href: "/portal/referrals", icon: Gift, external: true },
      { id: "intake", label: "Intake form", description: "Where tracked links should land", href: "/intake", icon: Inbox, external: true },
      { id: "embed", label: "Embeddable form", description: "Intake form for partner sites", href: "/embed", icon: Code2, external: true },
      { id: "marketplace", label: "Community marketplace", description: "Approve and feature listings", href: "/marketplace", icon: Store, feature: "marketplace" },
      { id: "reports", label: "Reports", description: "Operational and revenue reports", href: "/reports", icon: BarChart3, feature: "reports" },
    ],
  },
];

const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "");

export function MarketingChannels({ can, isAdmin }: { can: (feature: StaffFeature) => boolean; isAdmin: boolean }) {
  const groups = MODULE_GROUPS
    .map((group) => ({
      ...group,
      modules: group.modules.filter((m) => (!m.adminOnly || isAdmin) && (!m.feature || can(m.feature))),
    }))
    .filter((group) => group.modules.length > 0);

  return (
    <div className="space-y-6" data-testid="marketing-channels">
      {groups.map((group) => (
        <section key={group.id}>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">{group.title}</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {group.modules.map((module) => {
              const Icon = module.icon;
              const className = "group flex items-start gap-3 rounded-lg border border-gray-200 bg-white p-3 shadow-sm transition-colors hover:border-csd-red/40 hover:bg-red-50/40";
              const body = (
                <>
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-csd-red/10 text-csd-red">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-gray-900 group-hover:text-csd-red">{module.label}</span>
                    <span className="block text-xs text-gray-500">{module.description}</span>
                  </span>
                </>
              );
              return module.external ? (
                <a key={module.id} href={`${BASE_PATH}${module.href}`} target="_blank" rel="noreferrer" className={className} data-testid={`mkt-module-${module.id}`}>{body}</a>
              ) : (
                <Link key={module.id} href={module.href} className={className} data-testid={`mkt-module-${module.id}`}>{body}</Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
