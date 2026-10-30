import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  LayoutDashboard,
  UserCircle,
  Users,
  Building2,
  Ticket,
  ClipboardList,
  GitBranch,
  Target,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Client, Ticket as TicketType } from "@shared/schema";
import CrmDashboard from "@/pages/crm-dashboard";
import CrmLeads from "@/pages/crm-leads";
import CsdAdminPage from "@/pages/csd-admin";
import CrmContacts from "@/pages/crm-contacts";
import Clients from "@/pages/clients";
import CrmPipeline from "@/pages/crm-pipeline";

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
 *   /admin/intakes  -> Leads & Pipeline (intake requests view)
 *   /crm/contacts   -> Contacts
 *   /clients        -> Clients
 */

const PATH_TO_TAB: Record<string, string> = {
  "/crm": "overview",
  "/crm/leads": "leads",
  "/crm/pipeline": "leads",
  "/admin/intakes": "leads",
  "/crm/contacts": "contacts",
  "/clients": "clients",
};

const TAB_TO_PATH: Record<string, string> = {
  overview: "/crm",
  leads: "/crm/leads",
  contacts: "/crm/contacts",
  clients: "/clients",
};

function OverviewStats() {
  const { data: clients = [] } = useQuery<Client[]>({ queryKey: ["/api/clients"] });
  const { data: tickets = [] } = useQuery<TicketType[]>({ queryKey: ["/api/tickets"] });

  const openTickets = tickets.filter(
    (t) => t.status !== "resolved" && t.status !== "closed",
  ).length;

  return (
    <div className="mb-4 grid grid-cols-2 gap-4 sm:max-w-md">
      <Card data-testid="card-total-clients">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-gray-600">
            Total Clients
          </CardTitle>
          <Building2 className="h-4 w-4 text-blue-500" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{clients.length}</div>
        </CardContent>
      </Card>
      <Card data-testid="card-open-tickets">
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium text-gray-600">
            Open Tickets
          </CardTitle>
          <Ticket className="h-4 w-4 text-amber-500" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{openTickets}</div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function CustomersHub() {
  const [location, setLocation] = useLocation();
  const activeTab = PATH_TO_TAB[location] ?? "overview";
  const leadsView =
    location === "/admin/intakes"
      ? "intakes"
      : location === "/crm/pipeline"
        ? "deals"
        : "leads";

  return (
    <div className="p-4 lg:p-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight">Customers</h1>
        <p className="text-sm text-muted-foreground">
          Leads, contacts, clients, and new service requests — everyone we work
          with, all in one place.
        </p>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(tab) => setLocation(TAB_TO_PATH[tab] ?? "/crm")}
        className="w-full"
      >
        <TabsList className="flex w-full justify-start gap-1 overflow-x-auto whitespace-nowrap rounded-lg p-1">
          <TabsTrigger value="overview" data-testid="tab-overview" className="shrink-0">
            <LayoutDashboard className="mr-2 h-4 w-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="leads" data-testid="tab-leads" className="shrink-0">
            <UserCircle className="mr-2 h-4 w-4" />
            Leads &amp; Pipeline
          </TabsTrigger>
          <TabsTrigger value="contacts" data-testid="tab-contacts" className="shrink-0">
            <Users className="mr-2 h-4 w-4" />
            Contacts
          </TabsTrigger>
          <TabsTrigger value="clients" data-testid="tab-clients" className="shrink-0">
            <Building2 className="mr-2 h-4 w-4" />
            Clients
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <OverviewStats />
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
            <button
              type="button"
              onClick={() => setLocation("/admin/intakes")}
              data-testid="toggle-intakes"
              className={cn(
                "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                leadsView === "intakes"
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <ClipboardList className="h-4 w-4" />
              Intake Requests
            </button>
          </div>
          {leadsView === "intakes" ? (
            <CsdAdminPage embedded />
          ) : leadsView === "deals" ? (
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
      </Tabs>
    </div>
  );
}
