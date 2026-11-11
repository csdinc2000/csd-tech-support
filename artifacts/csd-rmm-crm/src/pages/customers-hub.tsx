import { useLocation } from "wouter";
import { LayoutDashboard, UserCircle, Users, Building2, ClipboardList, GitBranch, Target } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import CrmLeads from "@/pages/crm-leads";
import CsdAdminPage from "@/pages/csd-admin";
import CrmContacts from "@/pages/crm-contacts";
import Clients from "@/pages/clients";
import CrmPipeline from "@/pages/crm-pipeline";
import CrmDashboard from "@/pages/crm-dashboard";

/**
 * Customers hub — one home for everything about the people and companies we
 * serve. Merges the former CRM Dashboard, Leads & Pipeline, CSD Intakes,
 * Contacts and Client Management screens into a single tabbed view so techs and
 * sales reps have one obvious place to go.
 *
 * Each tab renders the existing page component unchanged. The active tab (and
 * the Leads/Deals/Intakes sub-view) is derived from the URL, so every existing
 * deep-link and bookmark keeps working:
 *   /crm            -> Overview
 *   /crm/leads      -> Leads & Pipeline (leads view)
 *   /crm/pipeline   -> Leads & Pipeline (deals kanban view)
 *   /admin/intakes  -> New Service Requests
 *   /crm/contacts   -> Contacts
 *   /clients        -> Clients
 */

const PATH_TO_TAB: Record<string, string> = {
  "/crm/customers": "overview",
  "/crm/leads": "leads",
  "/crm/pipeline": "leads",
  "/admin/intakes": "requests",
  "/crm/contacts": "contacts",
  "/clients": "clients",
  "/crm": "overview",
};

const TAB_TO_PATH: Record<string, string> = {
  overview: "/crm/customers",
  leads: "/crm/leads",
  contacts: "/crm/contacts",
  clients: "/clients",
  requests: "/admin/intakes",
};

export default function CustomersHub() {
  const [location, setLocation] = useLocation();
  const activeTab = PATH_TO_TAB[location] ?? "overview";
  const leadsView = location === "/crm/pipeline" ? "deals" : "leads";

  return (
    <div className="p-4 lg:p-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight">Customers</h1>
        <p className="text-sm text-muted-foreground">
          Leads, contacts, clients, and new service requests — everyone we work with, all in one place.
        </p>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(tab) => setLocation(TAB_TO_PATH[tab] ?? "/crm/customers")}
        className="w-full"
      >
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 rounded-lg p-1 sm:grid-cols-3 xl:grid-cols-5">
          <TabsTrigger value="overview" data-testid="tab-overview">
            <LayoutDashboard className="mr-2 h-4 w-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="leads" data-testid="tab-leads">
            <UserCircle className="mr-2 h-4 w-4" />
            Leads
          </TabsTrigger>
          <TabsTrigger value="contacts" data-testid="tab-contacts">
            <Users className="mr-2 h-4 w-4" />
            Contacts
          </TabsTrigger>
          <TabsTrigger value="clients" data-testid="tab-clients">
            <Building2 className="mr-2 h-4 w-4" />
            Clients
          </TabsTrigger>
          <TabsTrigger value="requests" data-testid="tab-service-requests">
            <ClipboardList className="mr-2 h-4 w-4" />
            New Service Requests
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <CrmDashboard embedded />
        </TabsContent>

        <TabsContent value="leads" className="mt-4">
          <div className="mb-4 inline-flex rounded-lg border bg-muted/40 p-1">
            <button
              type="button"
              onClick={() => setLocation("/crm/leads")}
              data-testid="toggle-leads"
              className={cn(
                "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                leadsView === "leads"
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <GitBranch className="h-4 w-4" />
              Leads
            </button>
            <button
              type="button"
              onClick={() => setLocation("/crm/pipeline")}
              data-testid="toggle-deals"
              className={cn(
                "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                leadsView === "deals"
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Target className="h-4 w-4" />
              Deals
            </button>
          </div>
          {leadsView === "deals" ? (
            <CrmPipeline embedded />
          ) : (
            <CrmLeads embedded />
          )}
        </TabsContent>

        <TabsContent value="contacts" className="mt-4">
          <CrmContacts embedded />
        </TabsContent>
        <TabsContent value="clients" className="mt-4">
          <Clients embedded />
        </TabsContent>
        <TabsContent value="requests" className="mt-4">
          <CsdAdminPage embedded />
        </TabsContent>
      </Tabs>
    </div>
  );
}
