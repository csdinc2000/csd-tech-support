import type { ComponentType, ReactNode } from "react";
import { Redirect, useSearch } from "wouter";
import {
  LayoutDashboard, Monitor, Ticket, Eye, Settings, BarChart3, Users, CreditCard,
  Activity, Shield, Zap, Network, TrendingUp, Briefcase, MessageCircle, Bot, Building2,
  ClipboardList, FileText, Mail, Wrench, HeadphonesIcon, Sparkles, CalendarDays, Video, Radio,
  Archive, HeartPulse, Store, Package, GraduationCap, Globe2, Megaphone, Target, Wand2,
  CheckSquare, Gift, Radar, Timer, BrainCircuit, ClipboardCheck,
} from "lucide-react";
import { useAdminAccess, type StaffFeature } from "@/hooks/use-admin-access";
import Dashboard from "@/pages/dashboard";
import RmmDashboard from "@/pages/rmm-dashboard";
import Devices from "@/pages/devices";
import Tickets from "@/pages/tickets";
import RemoteAccess from "@/pages/remote-access";
import AutomationWorkspace from "@/pages/automation-workspace";
import Monitoring from "@/pages/monitoring";
import Patches from "@/pages/patches";
import Reports from "@/pages/reports";
import NetworkDiscovery from "@/pages/network-discovery";
import WebsiteDiscovery from "@/pages/website-discovery";
import CustomersHub from "@/pages/customers-hub";
import CustomerDetail from "@/pages/customer-detail";
import PhoneHub from "@/pages/phone-hub";
import EmailComposePage from "@/pages/email-compose";
import SchedulingPage from "@/pages/scheduling";
import StaffMeetingsPage from "@/pages/staff-meetings";
import StaffCalendarPage from "@/pages/staff-calendar";
import CrmJobs from "@/pages/crm-jobs";
import ServiceLogs from "@/pages/service-logs";
import TechTools from "@/pages/tech-tools";
import TrainingPortal from "@/pages/training";
import MyProfilePage from "@/pages/my-profile";
import CompliancePage from "@/pages/compliance";
import AriaPage from "@/pages/aria";
import ExecutiveAssistantPage from "@/pages/executive-assistant";
import SalesAgentsPage from "@/pages/sales-agents";
import AriaMultiCam from "@/pages/aria-multicam";
import BillingPage from "@/pages/billing";
import Invoices from "@/pages/invoices";
import InvoiceSettingsPage from "@/pages/invoice-settings";
import ImportPaypal from "@/pages/import-paypal";
import ImportContacts from "@/pages/import-contacts";
import InvoiceDetail from "@/pages/invoice-detail";
import CatalogManager from "@/pages/catalog-manager";
import RetainedDeletedContacts from "@/pages/retained-deleted-contacts";
import HelpdeskAdmin from "@/pages/helpdesk-admin";
import StaffAdminPage from "@/pages/staff-admin";
import ProviderHealthPage from "@/pages/provider-health";
import PttDispatch from "@/pages/ptt-dispatch";
import PttAccessoryProbe from "@/pages/ptt-accessory-probe";
import MarketplaceAdminPage from "@/pages/marketplace-admin";
import MarketingPage from "@/pages/marketing";

// ---------------------------------------------------------------------------
// The one list of signed-in staff pages.
//
// Each entry says who may open the page and, optionally, where it shows in the
// sidebar. AdminRouter (App.tsx) and the sidebar are both built from this list,
// so a page can't be visible in the menu but blocked on the route, or the other
// way round. To add a staff page, add it here. Server-side API gates live in
// api-server/src/security.ts.
// ---------------------------------------------------------------------------

export type RouteAccess =
  /** Any approved staff member. */
  | { kind: "approved" }
  | { kind: "feature"; feature: StaffFeature }
  /** Any one of these features. */
  | { kind: "anyFeature"; features: StaffFeature[] }
  /** Account owner (ADMIN_EMAILS). `feature` is also required when set. */
  | { kind: "owner"; feature?: StaffFeature };

export type NavGroupId =
  | "dashboard" | "customers" | "marketing" | "communications" | "scheduling"
  | "operations" | "administration" | "ai";

export type NavGroupMeta = { id: NavGroupId; title: string; icon: ComponentType<{ className?: string }> };

export const NAV_GROUPS: readonly NavGroupMeta[] = [
  { id: "dashboard", title: "Dashboard", icon: LayoutDashboard },
  { id: "customers", title: "Customers & CRM", icon: TrendingUp },
  { id: "marketing", title: "Marketing", icon: Megaphone },
  { id: "communications", title: "Communications", icon: MessageCircle },
  { id: "scheduling", title: "Scheduling", icon: CalendarDays },
  { id: "operations", title: "Operations", icon: Wrench },
  { id: "administration", title: "Administration", icon: HeadphonesIcon },
  { id: "ai", title: "AI Tools", icon: Sparkles },
];

export type NavEntry = {
  group: NavGroupId;
  name: string;
  icon: ComponentType<{ className?: string }>;
  /** Other URLs that keep this item highlighted (hub tabs with their own URL). */
  match?: string[];
  /** Highlight on exact URL (or `match`) only, not on sub-paths. */
  exact?: boolean;
};

export type StaffRoute = {
  path: string;
  access: RouteAccess;
  render: () => ReactNode;
  nav?: NavEntry;
};

export type StaffRedirect = { path: string; render: () => ReactNode };

const approved: RouteAccess = { kind: "approved" };
const feature = (f: StaffFeature): RouteAccess => ({ kind: "feature", feature: f });
const owner = (f?: StaffFeature): RouteAccess => ({ kind: "owner", feature: f });

const page = (Component: ComponentType) => () => <Component />;

// The "reconnect Google Calendar" link goes to owner-only settings.
function TeamCalendar() {
  const { isAdmin } = useAdminAccess();
  return <StaffCalendarPage showSettingsLink={isAdmin} />;
}

function LegacyDispatchSettingsRedirect() {
  const params = new URLSearchParams(useSearch());
  params.set("tab", "dispatch");
  return <Redirect to={`/staff?${params.toString()}`} />;
}

// Hub pages pick their tab from the URL, so each tab URL is a real route.
const CUSTOMERS_HUB_TABS = ["/crm", "/clients", "/crm/contacts", "/crm/leads", "/crm/pipeline", "/admin/intakes"];
const PHONE_HUB_TABS = ["/messages", "/admin/call-tracking", "/admin/phone", "/comms/voicemails", "/comms/config"];
const MARKETING_TABS = ["/marketing/campaigns", "/marketing/referrals", "/marketing/vouchers", "/marketing/tools", "/marketing/playbook", "/marketing/channels", "/marketing/portal-ads"];
const SALES_TABS = ["/sales/lead-gen", "/sales/speed-to-lead", "/sales/copilot"];

// Old or duplicate URLs: kept working, sent to the canonical page.
export const STAFF_REDIRECTS: readonly StaffRedirect[] = [
  { path: "/client-portal", render: () => <Redirect to="/portal" /> },
  { path: "/customer-portal", render: () => <Redirect to="/portal" /> },
  { path: "/automation-hub", render: () => <Redirect to="/automation" /> },
  { path: "/calendar", render: () => <Redirect to="/scheduling" /> },
  { path: "/calendar-view", render: () => <Redirect to="/staff-calendar" /> },
  { path: "/dispatch-settings", render: () => <LegacyDispatchSettingsRedirect /> },
  { path: "/staff-access", render: () => <Redirect to="/staff?tab=access" /> },
];

// Order matters where paths overlap (literal paths before `:id`).
export const STAFF_ROUTES: readonly StaffRoute[] = [
  // Dashboard
  { path: "/dashboard", access: feature("dashboard"), render: page(Dashboard),
    nav: { group: "dashboard", name: "Technician Board", icon: LayoutDashboard, exact: true } },
  { path: "/dashboard/rmm", access: feature("dashboard"), render: page(RmmDashboard),
    nav: { group: "dashboard", name: "RMM Overview", icon: Monitor } },
  // Open to any approved staff member — new techs often start with only one feature.
  { path: "/training", access: approved, render: page(TrainingPortal),
    nav: { group: "dashboard", name: "Training Portal", icon: GraduationCap } },

  // Customers & CRM
  ...CUSTOMERS_HUB_TABS.map((path) => ({ path, access: feature("crm"), render: page(CustomersHub) })),
  { path: "/crm/customers", access: feature("crm"), render: page(CustomersHub),
    nav: { group: "customers", name: "Customers", icon: Building2, match: CUSTOMERS_HUB_TABS } },
  { path: "/crm/customers/:id", access: feature("crm"), render: page(CustomerDetail) },
  { path: "/crm/contacts/import", access: feature("crm"), render: page(ImportContacts) },
  { path: "/crm/jobs", access: feature("crm"), render: page(CrmJobs),
    nav: { group: "customers", name: "Jobs & Work Orders", icon: Briefcase } },
  { path: "/crm/retained-contacts", access: owner("crm"), render: page(RetainedDeletedContacts),
    nav: { group: "customers", name: "Retained deleted contacts", icon: Archive } },
  { path: "/sales", access: feature("crm"), render: page(SalesAgentsPage) },
  { path: "/sales/lead-gen", access: feature("crm"), render: page(SalesAgentsPage),
    nav: { group: "customers", name: "Lead Generation Agent", icon: Radar, match: ["/sales"] } },
  { path: "/sales/speed-to-lead", access: feature("crm"), render: page(SalesAgentsPage),
    nav: { group: "customers", name: "Speed to Lead", icon: Timer } },
  { path: "/sales/copilot", access: feature("crm"), render: page(SalesAgentsPage),
    nav: { group: "customers", name: "Sales Copilot", icon: BrainCircuit } },
  { path: "/website-discovery", access: feature("crm"), render: page(WebsiteDiscovery),
    nav: { group: "customers", name: "Website Discovery", icon: Globe2 } },
  { path: "/service-logs", access: feature("operations"), render: page(ServiceLogs),
    nav: { group: "customers", name: "Service Logs", icon: ClipboardList } },

  // Marketing
  { path: "/marketing", access: feature("crm"), render: page(MarketingPage),
    nav: { group: "marketing", name: "Marketing Hub", icon: Megaphone, match: ["/marketing/channels", "/marketing/portal-ads"], exact: true } },
  ...MARKETING_TABS.map((path) => ({
    path,
    access: feature("crm"),
    render: page(MarketingPage),
    nav: ({
      "/marketing/campaigns": { group: "marketing", name: "Campaigns & Tracking", icon: Target },
      "/marketing/referrals": { group: "marketing", name: "Referral Program", icon: Gift },
      "/marketing/tools": { group: "marketing", name: "Marketing Tools", icon: Wand2 },
      "/marketing/playbook": { group: "marketing", name: "Marketing Playbook", icon: CheckSquare },
    } as Record<string, NavEntry | undefined>)[path],
  })),
  { path: "/marketplace", access: feature("marketplace"), render: page(MarketplaceAdminPage),
    nav: { group: "marketing", name: "Community Listings", icon: Store } },

  // Communications
  { path: "/comms", access: feature("communications"), render: page(PhoneHub),
    nav: { group: "communications", name: "Communications Hub", icon: MessageCircle, match: PHONE_HUB_TABS } },
  ...PHONE_HUB_TABS.map((path) => ({ path, access: feature("communications"), render: page(PhoneHub) })),
  { path: "/comms/email", access: feature("communications"), render: page(EmailComposePage),
    nav: { group: "communications", name: "Email from Support", icon: Mail } },
  { path: "/ptt/accessory-probe", access: feature("communications"), render: page(PttAccessoryProbe) },
  { path: "/ptt", access: feature("communications"), render: page(PttDispatch),
    nav: { group: "communications", name: "PTT Dispatch", icon: Radio } },

  // Scheduling
  { path: "/meetings", access: feature("scheduling"), render: page(StaffMeetingsPage),
    nav: { group: "scheduling", name: "Meetings", icon: Video } },
  // One team calendar for technicians (operations) and schedulers.
  { path: "/staff-calendar", access: { kind: "anyFeature", features: ["scheduling", "operations"] },
    render: () => <TeamCalendar />,
    nav: { group: "scheduling", name: "Calendar", icon: CalendarDays } },
  { path: "/scheduling", access: owner("scheduling"), render: page(SchedulingPage),
    nav: { group: "scheduling", name: "Calendar Configuration", icon: CalendarDays, match: ["/calendar"] } },

  // Operations
  { path: "/devices", access: feature("operations"), render: page(Devices),
    nav: { group: "operations", name: "Device Management", icon: Monitor } },
  { path: "/network-discovery", access: feature("operations"), render: page(NetworkDiscovery),
    nav: { group: "operations", name: "Network Discovery", icon: Network } },
  { path: "/monitoring", access: feature("operations"), render: page(Monitoring),
    nav: { group: "operations", name: "Real-Time Monitoring", icon: Activity } },
  { path: "/patches", access: feature("operations"), render: page(Patches),
    nav: { group: "operations", name: "Patch Management", icon: Shield } },
  { path: "/tickets", access: feature("helpdesk"), render: page(Tickets),
    nav: { group: "operations", name: "Help Desk", icon: Ticket } },
  { path: "/remote-access", access: feature("operations"), render: page(RemoteAccess),
    nav: { group: "operations", name: "Remote Access", icon: Eye } },
  { path: "/automation", access: feature("automation"), render: page(AutomationWorkspace),
    nav: { group: "operations", name: "Automation", icon: Zap, match: ["/automation-hub"] } },
  { path: "/reports", access: feature("reports"), render: page(Reports),
    nav: { group: "operations", name: "Reports", icon: BarChart3 } },
  { path: "/tech-tools", access: feature("operations"), render: page(TechTools),
    nav: { group: "operations", name: "Tech Tools", icon: Wrench } },

  // Administration
  { path: "/billing", access: feature("billing"), render: page(BillingPage),
    nav: { group: "administration", name: "Billing & Plans", icon: CreditCard } },
  { path: "/invoices", access: feature("invoices"), render: page(Invoices),
    nav: { group: "administration", name: "Invoices", icon: FileText } },
  { path: "/invoices/catalog", access: owner("invoices"), render: page(CatalogManager),
    nav: { group: "administration", name: "Product & Service Catalog", icon: Package } },
  { path: "/invoices/settings", access: owner("invoices"), render: page(InvoiceSettingsPage),
    nav: { group: "administration", name: "Invoice Settings", icon: Settings } },
  { path: "/invoices/import-paypal", access: feature("invoices"), render: page(ImportPaypal) },
  { path: "/invoices/new", access: feature("invoices"), render: page(InvoiceDetail) },
  { path: "/invoices/:id", access: feature("invoices"), render: page(InvoiceDetail) },
  { path: "/compliance", access: feature("compliance"), render: page(CompliancePage),
    nav: { group: "administration", name: "Compliance Center", icon: Shield } },
  { path: "/helpdesk/admin", access: feature("helpdeskAdmin"), render: page(HelpdeskAdmin),
    nav: { group: "administration", name: "Helpdesk Admin", icon: HeadphonesIcon } },
  { path: "/staff", access: feature("staffAdmin"), render: page(StaffAdminPage),
    nav: { group: "administration", name: "Staff Administration", icon: Users, match: ["/staff-access", "/dispatch-settings"] } },
  { path: "/provider-health", access: owner(), render: page(ProviderHealthPage),
    nav: { group: "administration", name: "Provider Health", icon: HeartPulse } },

  // AI tools and personal pages (any approved staff unless noted)
  { path: "/aria", access: approved, render: page(AriaPage),
    nav: { group: "ai", name: "ARIA Assistant", icon: Bot } },
  { path: "/assistant", access: approved, render: page(ExecutiveAssistantPage),
    nav: { group: "ai", name: "Executive Assistant", icon: ClipboardCheck } },
  { path: "/aria-command", access: feature("operations"), render: page(AriaMultiCam),
    nav: { group: "ai", name: "ARIA Command Center", icon: Video } },
  { path: "/profile", access: approved, render: page(MyProfilePage) },
];

export type AccessContext = { can: (feature: StaffFeature) => boolean; isAdmin: boolean };

export function canAccessRoute(access: RouteAccess, { can, isAdmin }: AccessContext): boolean {
  switch (access.kind) {
    case "approved":
      return true;
    case "feature":
      return can(access.feature);
    case "anyFeature":
      return access.features.some((f) => can(f));
    case "owner":
      return isAdmin && (!access.feature || can(access.feature));
  }
}

export type NavItem = NavEntry & { href: string; access: RouteAccess };

export function navItemsByGroup(): Map<NavGroupId, NavItem[]> {
  const groups = new Map<NavGroupId, NavItem[]>();
  for (const route of STAFF_ROUTES) {
    if (!route.nav) continue;
    const items = groups.get(route.nav.group) ?? [];
    items.push({ ...route.nav, href: route.path, access: route.access });
    groups.set(route.nav.group, items);
  }
  return groups;
}
