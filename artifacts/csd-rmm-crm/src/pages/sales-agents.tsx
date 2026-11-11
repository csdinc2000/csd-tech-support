import { useLocation, useSearch } from "wouter";
import { Rocket, Sparkles, Target, Timer } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PageShell } from "@/components/layout/page-shell";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { cn } from "@/lib/utils";
import { LeadGenPanel } from "@/components/sales/lead-gen-panel";
import { SpeedToLeadPanel } from "@/components/sales/speed-to-lead-panel";
import { SalesCopilotPanel } from "@/components/sales/sales-copilot-panel";

/**
 * Sales Agents hub (gated by the `crm` feature in App.tsx):
 *   /sales, /sales/lead-gen   Lead Generation Agent: AI web research for new business prospects
 *   /sales/speed-to-lead      Speed to Lead: first-contact clock, instant text, escalations
 *   /sales/copilot?leadId=N   Lead Research Sales Copilot: call-ready brief per lead
 *
 * Nothing on this page contacts a customer on its own except the Speed to
 * Lead instant text, which an owner must switch on and which only reaches
 * customers who gave SMS consent.
 */

type SalesTab = "lead-gen" | "speed-to-lead" | "copilot";

const TABS: { id: SalesTab; label: string; path: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "lead-gen", label: "Lead Generation", path: "/sales/lead-gen", icon: Target },
  { id: "speed-to-lead", label: "Speed to Lead", path: "/sales/speed-to-lead", icon: Timer },
  { id: "copilot", label: "Sales Copilot", path: "/sales/copilot", icon: Sparkles },
];

export function salesTabForPath(path: string): SalesTab {
  return TABS.find((t) => t.path === path)?.id ?? "lead-gen";
}

export default function SalesAgentsPage() {
  // useAdminAccess().isAdmin is the app-wide owner flag (see RequireOwner in App.tsx).
  const { isAdmin } = useAdminAccess();
  return <SalesAgentsView isOwner={isAdmin} />;
}

/** Provider-free so browser tests can mount it with mocked APIs. */
export function SalesAgentsView({ isOwner }: { isOwner: boolean }) {
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const tab = salesTabForPath(location);
  const rawLeadId = Number(new URLSearchParams(search).get("leadId"));
  const leadId = Number.isInteger(rawLeadId) && rawLeadId > 0 ? rawLeadId : null;

  return (
    <PageShell>
      <PageHeader
        icon={Rocket}
        eyebrow="Sales"
        title="Sales Agents"
        description="Find new prospects, answer every inbound lead fast, and walk into each sales call prepared."
      />
      <div className="space-y-4 p-3 sm:p-4 md:p-6" data-testid="sales-agents">
        <nav
          aria-label="Sales agent sections"
          className="-mx-3 flex gap-1 overflow-x-auto border-y border-gray-200 bg-white px-3 py-1.5 [scrollbar-width:none] sm:mx-0 sm:w-fit sm:rounded-lg sm:border sm:px-1.5"
        >
          {TABS.map((item) => {
            const Icon = item.icon;
            const active = item.id === tab;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setLocation(item.path)}
                aria-current={active ? "page" : undefined}
                data-testid={`sales-tab-${item.id}`}
                className={cn(
                  "flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors",
                  active ? "bg-csd-red text-white shadow-sm" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </nav>

        {tab === "lead-gen" && <LeadGenPanel />}
        {tab === "speed-to-lead" && <SpeedToLeadPanel isOwner={isOwner} />}
        {tab === "copilot" && <SalesCopilotPanel leadId={leadId} onSelectLead={(id) => setLocation(`/sales/copilot?leadId=${id}`)} />}
      </div>
    </PageShell>
  );
}
