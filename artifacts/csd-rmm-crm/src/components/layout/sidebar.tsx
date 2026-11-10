import { Link, useLocation } from "wouter";
import { useEffect, useState } from "react";
import {
  LayoutDashboard, Monitor, Ticket, Eye, Settings, BarChart3, Users, CreditCard,
  Menu, X, Activity, Shield, Zap, Network, TrendingUp, Briefcase, UserCircle,
  MessageCircle, Bot, Building2, ClipboardList, ChevronDown, LifeBuoy, PhoneCall, FileText, Mail,
  MapPin, Clock, Wrench, HeadphonesIcon, Sparkles, CalendarDays, Video, Radio, Archive, HeartPulse, Store, Package, GraduationCap, Globe2,
  Megaphone, Target, Wand2, CheckSquare, Gift, Radar, Timer, BrainCircuit, ClipboardCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAdminAccess, type StaffFeature } from "@/hooks/use-admin-access";
import csdIcon from "@assets/CSD_ICON_Favicon_Logo_1765066839385.png";

type NavItem = {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  adminOnly?: boolean;
  feature?: StaffFeature;
  features?: StaffFeature[];
  // Extra paths that should keep this item highlighted (e.g. sibling sub-views
  // that live under the same hub tab but have their own URL).
  match?: string[];
};

type NavGroup = {
  id: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  feature: StaffFeature;
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  {
    id: "dashboard",
    title: "Dashboard",
    icon: LayoutDashboard,
    feature: "dashboard",
    items: [
      { name: "Technician Board", href: "/dashboard", icon: LayoutDashboard },
      { name: "RMM Overview", href: "/dashboard/rmm", icon: Monitor },
      // Open to any approved staff member — new techs often start with only one feature.
      { name: "Training Portal", href: "/training", icon: GraduationCap, features: ["dashboard", "crm", "operations", "helpdesk", "communications", "scheduling"] },
    ],
  },
  {
    id: "customers",
    title: "Customers & CRM",
    icon: TrendingUp,
    feature: "crm",
    items: [
      { name: "Customers", href: "/crm/customers", icon: Building2, match: ["/crm", "/clients", "/crm/contacts", "/crm/leads", "/crm/pipeline", "/admin/intakes"] },
      { name: "Lead Generation Agent", href: "/sales/lead-gen", icon: Radar, match: ["/sales"] },
      { name: "Speed to Lead", href: "/sales/speed-to-lead", icon: Timer },
      { name: "Sales Copilot", href: "/sales/copilot", icon: BrainCircuit },
      { name: "Website Discovery", href: "/website-discovery", icon: Globe2 },
      { name: "Retained deleted contacts", href: "/crm/retained-contacts", icon: Archive, adminOnly: true },
      { name: "Jobs & Work Orders", href: "/crm/jobs", icon: Briefcase },
      { name: "Service Logs", href: "/service-logs", icon: ClipboardList },
    ],
  },
  {
    id: "marketing",
    title: "Marketing",
    icon: Megaphone,
    feature: "crm",
    items: [
      { name: "Marketing Hub", href: "/marketing", icon: Megaphone, match: ["/marketing/channels"] },
      { name: "Campaigns & Tracking", href: "/marketing/campaigns", icon: Target },
      { name: "Referral Program", href: "/marketing/referrals", icon: Gift },
      { name: "Marketing Tools", href: "/marketing/tools", icon: Wand2 },
      { name: "Marketing Playbook", href: "/marketing/playbook", icon: CheckSquare },
      { name: "Community Listings", href: "/marketplace", icon: Store, feature: "marketplace" },
    ],
  },
  {
    id: "communications",
    title: "Communications",
    icon: MessageCircle,
    feature: "communications",
    items: [
      { name: "Communications Hub", href: "/comms", icon: MessageCircle, match: ["/messages", "/admin/call-tracking", "/admin/phone", "/comms/voicemails", "/comms/config"] },
      { name: "Email from Support", href: "/comms/email", icon: Mail },
      { name: "PTT Dispatch", href: "/ptt", icon: Radio },
    ],
  },
  {
    id: "scheduling",
    title: "Scheduling",
    icon: CalendarDays,
    feature: "scheduling",
    items: [
      { name: "Meetings", href: "/meetings", icon: Video },
      { name: "Calendar", href: "/calendar-view", icon: CalendarDays },
      { name: "Calendar Configuration", href: "/scheduling", icon: CalendarDays, match: ["/calendar"], adminOnly: true },
    ],
  },
  {
    id: "operations",
    title: "Operations",
    icon: Wrench,
    feature: "operations",
    items: [
      { name: "Device Management", href: "/devices", icon: Monitor },
      { name: "Network Discovery", href: "/network-discovery", icon: Network },
      { name: "Real-Time Monitoring", href: "/monitoring", icon: Activity },
      { name: "Patch Management", href: "/patches", icon: Shield },
      { name: "Help Desk", href: "/tickets", icon: Ticket, feature: "helpdesk" },
      { name: "Remote Access", href: "/remote-access", icon: Eye },
      { name: "Automation", href: "/automation", icon: Zap, match: ["/automation-hub"], feature: "automation" },
      { name: "Reports", href: "/reports", icon: BarChart3, feature: "reports" },
      { name: "Tech Tools", href: "/tech-tools", icon: Wrench },
      { name: "Calendar", href: "/staff-calendar", icon: CalendarDays },
    ],
  },
  {
    id: "administration",
    title: "Administration",
    icon: HeadphonesIcon,
    feature: "compliance",
    items: [
      { name: "Billing & Plans", href: "/billing", icon: CreditCard, feature: "billing" },
      { name: "Invoices", href: "/invoices", icon: FileText, feature: "invoices" },
       { name: "Product & Service Catalog", href: "/invoices/catalog", icon: Package, feature: "invoices", adminOnly: true },
      { name: "Invoice Settings", href: "/invoices/settings", icon: Settings, feature: "invoices", adminOnly: true },
      { name: "Compliance Center", href: "/compliance", icon: Shield, feature: "compliance" },
      { name: "Helpdesk Admin", href: "/helpdesk/admin", icon: HeadphonesIcon, feature: "helpdeskAdmin" },
      { name: "Staff Administration", href: "/staff", icon: Users, feature: "staffAdmin", match: ["/staff-access", "/dispatch-settings"] },
      { name: "Provider Health", href: "/provider-health", icon: HeartPulse, adminOnly: true },
    ],
  },
  {
    id: "ai",
    title: "AI Tools",
    icon: Sparkles,
    feature: "operations",
    items: [
      { name: "ARIA Assistant", href: "/aria", icon: Bot },
      // Personal tasks + daily briefing; open to any approved staff member.
      { name: "Executive Assistant", href: "/assistant", icon: ClipboardCheck, features: ["dashboard", "crm", "operations", "helpdesk", "communications", "scheduling"] },
      { name: "ARIA Command Center", href: "/aria-command", icon: Video },
    ],
  },
];

function isItemActive(item: NavItem, location: string) {
  const { href } = item;
  // "/dashboard" has its own sub-views (e.g. /dashboard/rmm) so it only matches exactly.
  if (href === "/dashboard") return location === "/" || location === "/dashboard";
  // The Marketing hub's other tabs have their own nav items.
  if (href === "/marketing") return location === href || !!item.match?.includes(location);
  if (location === href) return true;
  // Sibling sub-views that share this item's hub tab but carry their own URL.
  if (item.match?.includes(location)) return true;
  // active for nested routes (e.g. /crm/leads stays active under CRM Dashboard? No — only match exact or sub-route of THIS item)
  if (href !== "/" && location.startsWith(href + "/")) return true;
  return false;
}

function NavLink({ item, location, onClick }: { item: NavItem; location: string; onClick?: () => void }) {
  const Icon = item.icon;
  const active = isItemActive(item, location);
  return (
    <Link
      href={item.href}
      onClick={onClick}
      className={cn(
        "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all",
        active
          ? "bg-red-500/10 text-white"
          : "text-gray-300 hover:bg-white/5 hover:text-white",
      )}
      data-testid={`nav-${item.href.replace(/\//g, "-")}`}
    >
      <span
        className={cn(
          "absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-r-full transition-all",
          active ? "bg-csd-red opacity-100" : "opacity-0 group-hover:opacity-30 group-hover:bg-gray-400",
        )}
        aria-hidden="true"
      />
      <Icon
        className={cn(
          "h-4 w-4 shrink-0 transition-colors",
          active ? "text-csd-red" : "text-gray-400 group-hover:text-gray-200",
        )}
      />
      <span className="truncate">{item.name}</span>
      {item.badge && (
        <span className="ml-auto rounded-full bg-csd-red/90 px-1.5 py-0.5 text-[10px] font-semibold text-white">
          {item.badge}
        </span>
      )}
    </Link>
  );
}

function NavGroupBlock({
  group,
  location,
  open,
  onToggle,
  onItemClick,
}: {
  group: NavGroup;
  location: string;
  open: boolean;
  onToggle: () => void;
  onItemClick?: () => void;
}) {
  const GroupIcon = group.icon;
  const hasActive = group.items.some((i) => isItemActive(i, location));
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "group flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors",
          hasActive ? "text-gray-200" : "text-gray-400 hover:text-gray-200",
        )}
        aria-expanded={open}
      >
        <GroupIcon className="h-3.5 w-3.5 text-gray-500 group-hover:text-gray-300" />
        <span className="flex-1 text-left">{group.title}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-gray-500 transition-transform duration-200",
            open ? "rotate-0" : "-rotate-90",
          )}
        />
      </button>
      <div
        className={cn(
          "grid transition-all duration-200 ease-out",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <nav className="mt-1 space-y-0.5 pl-1">
            {group.items.map((item) => (
              <NavLink key={item.href} item={item} location={location} onClick={onItemClick} />
            ))}
          </nav>
        </div>
      </div>
    </div>
  );
}

function SidebarBody({
  location,
  openGroups,
  toggleGroup,
  onItemClick,
  can,
  isAdmin,
}: {
  location: string;
  openGroups: Record<string, boolean>;
  toggleGroup: (id: string) => void;
  onItemClick?: () => void;
  can: (feature: StaffFeature) => boolean;
  isAdmin: boolean;
}) {
  const visibleGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        if (item.adminOnly && !isAdmin) return false;
        if (item.features) return item.features.some(f => can(f));
        return can(item.feature ?? group.feature);
      }),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="flex-1">
        <div className="p-3">
          {visibleGroups.map((group) => (
            <NavGroupBlock
              key={group.id}
              group={group}
              location={location}
              open={openGroups[group.id] ?? true}
              onToggle={() => toggleGroup(group.id)}
              onItemClick={onItemClick}
            />
          ))}

          <div className="mt-6 rounded-lg border border-white/5 bg-gradient-to-br from-white/[0.03] to-transparent p-3">
            <div className="mb-2 flex items-center gap-2">
              <img src={csdIcon} alt="CSD" className="h-8 w-8 rounded" />
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-white">Computer Systems Depot</div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500">Since 1996</div>
              </div>
            </div>
            <a
              href="tel:954-637-7300"
              className="mb-2 flex items-center gap-2 rounded-md bg-csd-red/10 px-2 py-1.5 text-sm font-semibold text-red-300 transition-colors hover:bg-csd-red hover:text-white"
            >
              <PhoneCall className="h-3.5 w-3.5" />
              954-637-7300
            </a>
            <div className="space-y-1.5 text-[11px] text-gray-400">
              <div className="flex items-start gap-1.5">
                <Clock className="mt-0.5 h-3 w-3 shrink-0 text-gray-500" />
                <span>Mon–Fri 5:00 PM – 11:00 PM</span>
              </div>
              <div className="flex items-start gap-1.5">
                <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-gray-500" />
                <span>
                  5601 NW 13 Street
                  <br />
                  Lauderhill, FL 33313
                </span>
              </div>
            </div>
          </div>

          <a
            href="/intake"
            className="mt-3 flex items-center justify-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-medium text-gray-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <LifeBuoy className="h-3.5 w-3.5" />
            New Service Intake
          </a>
        </div>
      </ScrollArea>
    </div>
  );
}

const STORAGE_KEY = "csd:sidebar-groups";

function useGroupState() {
  const initial: Record<string, boolean> = navGroups.reduce(
    (acc, g) => ({ ...acc, [g.id]: true }),
    {} as Record<string, boolean>,
  );
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(initial);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setOpenGroups({ ...initial, ...JSON.parse(stored) });
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleGroup = (id: string) => {
    setOpenGroups((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  return { openGroups, toggleGroup };
}

export default function Sidebar() {
  const [location] = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const isMobile = useIsMobile();
  const { openGroups, toggleGroup } = useGroupState();
  const { can, isAdmin } = useAdminAccess();

  // Close mobile drawer on route change
  useEffect(() => {
    setIsOpen(false);
  }, [location]);

  if (isMobile) {
    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          className="fixed left-3 top-3 z-50 h-10 w-10 bg-gray-900 p-0 text-white shadow-lg hover:bg-gray-800 lg:hidden"
          onClick={() => setIsOpen(!isOpen)}
          aria-label={isOpen ? "Close menu" : "Open menu"}
        >
          {isOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </Button>

        {isOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
            onClick={() => setIsOpen(false)}
            aria-hidden="true"
          />
        )}

        <aside
          className={cn(
            "fixed left-0 top-0 z-40 h-full w-72 transform bg-gray-950 text-white shadow-2xl transition-transform duration-300 ease-out lg:hidden",
            isOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="flex h-16 items-center border-b border-white/10 px-4 pl-16">
            <img src={csdIcon} alt="CSD" className="h-7 w-7 rounded" />
            <span className="ml-2 text-sm font-semibold">CSD Platform</span>
          </div>
          <SidebarBody
            location={location}
            openGroups={openGroups}
            toggleGroup={toggleGroup}
            can={can}
            isAdmin={isAdmin}
            onItemClick={() => setIsOpen(false)}
          />
        </aside>
      </>
    );
  }

  return (
    <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] w-64 shrink-0 flex-col border-r border-white/5 bg-gray-950 text-white lg:flex">
      <SidebarBody location={location} openGroups={openGroups} toggleGroup={toggleGroup} can={can} isAdmin={isAdmin} />
    </aside>
  );
}
