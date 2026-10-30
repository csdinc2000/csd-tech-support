import {
  Activity, BookOpen, Bot, Briefcase, Building2, CalendarDays, ClipboardList, Download, Eye,
  GraduationCap, LifeBuoy, Mail, MessageCircle, Monitor, Network, ShieldAlert, ShieldCheck,
  Ticket, Wrench,
} from "lucide-react";
import type { StaffFeature } from "@/hooks/use-admin-access";

export type TechLink = {
  id: string;
  label: string;
  description: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Staff feature the target route requires; omitted for pages any approved staff member can open. */
  feature?: StaffFeature;
};

export type TechLinkGroup = { id: string; title: string; links: TechLink[] };

/**
 * One catalog of the pages technicians jump between, shared by the
 * Technician Board quick links and the Training Portal so both stay in sync
 * with the routes (and feature gates) in App.tsx.
 */
export const TECH_LINK_GROUPS: TechLinkGroup[] = [
  {
    id: "work",
    title: "Daily work",
    links: [
      { id: "jobs", label: "Jobs & Work Orders", description: "Open, update and close repair jobs", href: "/crm/jobs", icon: Briefcase, feature: "crm" },
      { id: "helpdesk", label: "Help Desk", description: "Support tickets and replies", href: "/tickets", icon: Ticket, feature: "helpdesk" },
      { id: "customers", label: "Customers", description: "Look up accounts, contacts and history", href: "/crm/customers", icon: Building2, feature: "crm" },
      { id: "service-logs", label: "Service Logs", description: "Record what was done on each device", href: "/service-logs", icon: ClipboardList, feature: "operations" },
      { id: "calendar", label: "Tech Calendar", description: "Your appointments and on-site visits", href: "/staff-calendar", icon: CalendarDays, feature: "operations" },
      { id: "comms", label: "Communications Hub", description: "Calls, texts and voicemail", href: "/comms", icon: MessageCircle, feature: "communications" },
      { id: "email", label: "Email from Support", description: "Send a customer email from the support inbox", href: "/comms/email", icon: Mail, feature: "communications" },
    ],
  },
  {
    id: "remote",
    title: "Remote & devices",
    links: [
      { id: "remote-access", label: "Remote Access", description: "Connect to a customer machine", href: "/remote-access", icon: Eye, feature: "operations" },
      { id: "devices", label: "Device Management", description: "Enrolled endpoints and agent status", href: "/devices", icon: Monitor, feature: "operations" },
      { id: "monitoring", label: "Real-Time Monitoring", description: "Alerts, CPU, disk and uptime", href: "/monitoring", icon: Activity, feature: "operations" },
      { id: "patches", label: "Patch Management", description: "Pending and failed updates", href: "/patches", icon: ShieldCheck, feature: "operations" },
      { id: "network", label: "Network Discovery", description: "Scan and map a customer network", href: "/network-discovery", icon: Network, feature: "operations" },
      { id: "download-agent", label: "Agent Download", description: "Link to send customers for the RMM agent", href: "/download", icon: Download },
    ],
  },
  {
    id: "reference",
    title: "Reference & training",
    links: [
      { id: "training", label: "Training Portal", description: "Onboarding path and SOPs for new techs", href: "/training", icon: GraduationCap },
      { id: "tech-tools", label: "Tech Tools", description: "Bench commands, 7-Gate checklist, calculators", href: "/tech-tools", icon: Wrench, feature: "operations" },
      { id: "cheat-sheets", label: "Cheat Sheets", description: "Ports, shortcuts and quick commands", href: "/tech-tools?tab=cheatsheets", icon: BookOpen, feature: "operations" },
      { id: "aria", label: "ARIA Assistant", description: "Ask the AI for troubleshooting help", href: "/aria", icon: Bot },
      { id: "scam-guide", label: "Scam Check Guide", description: "Customer-facing scam warning signs", href: "/scam-check-guide", icon: ShieldAlert },
      { id: "intake", label: "New Service Intake", description: "Public intake form for walk-ins and calls", href: "/intake", icon: LifeBuoy },
    ],
  },
];

export const TECH_LINKS_BY_ID: Record<string, TechLink> = Object.fromEntries(
  TECH_LINK_GROUPS.flatMap((group) => group.links).map((link) => [link.id, link]),
);

export function canOpenLink(link: TechLink, can: (feature: StaffFeature) => boolean): boolean {
  return !link.feature || can(link.feature);
}
