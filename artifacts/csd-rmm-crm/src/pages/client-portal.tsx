import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import {
  Building2,
  Users,
  Ticket,
  Briefcase,
  ArrowRight,
  ExternalLink,
  ShieldCheck,
} from "lucide-react";
import type { Client, Ticket as TicketType, CrmJob } from "@shared/schema";

export default function ClientPortalPage() {
  const { data: clients = [], isLoading: clientsLoading } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
  });

  const { data: tickets = [] } = useQuery<TicketType[]>({
    queryKey: ["/api/tickets"],
  });

  const { data: jobs = [] } = useQuery<CrmJob[]>({
    queryKey: ["/api/crm/jobs"],
  });

  const openTickets = tickets.filter(
    (t) => t.status !== "resolved" && t.status !== "closed",
  ).length;
  const activeJobs = jobs.filter(
    (j) => j.status === "open" || j.status === "in_progress",
  ).length;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-4 md:px-6 py-4">
        <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center space-y-4 lg:space-y-0">
          <div>
            <h2
              className="text-xl md:text-2xl font-bold text-gray-900"
              data-testid="page-title"
            >
              Client Portal
            </h2>
            <p className="text-sm md:text-base text-gray-600">
              Customer-facing overview: tickets, jobs, and account snapshots
              for each client.
            </p>
          </div>
          <Link href="/clients">
            <Button variant="outline" data-testid="button-manage-clients">
              <Users className="h-4 w-4 mr-2" />
              Manage Clients
            </Button>
          </Link>
        </div>
      </div>

      <div className="p-4 md:p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card data-testid="card-total-clients">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-gray-600">
                Total Clients
              </CardTitle>
              <Building2 className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{clients.length}</div>
              <div className="text-xs text-gray-500 mt-1">
                Active accounts in portal
              </div>
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
              <div className="text-xs text-gray-500 mt-1">
                Across all clients
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-active-jobs">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-gray-600">
                Active Jobs
              </CardTitle>
              <Briefcase className="h-4 w-4 text-purple-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{activeJobs}</div>
              <div className="text-xs text-gray-500 mt-1">
                In progress or open
              </div>
            </CardContent>
          </Card>
        </div>

        <Card data-testid="card-clients-list">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg font-semibold">
                Clients
              </CardTitle>
              <Link href="/clients">
                <Button variant="ghost" size="sm">
                  View All <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {clientsLoading ? (
              <div className="space-y-2">
                {[...Array(3)].map((_, i) => (
                  <div
                    key={i}
                    className="h-14 bg-gray-100 rounded animate-pulse"
                  />
                ))}
              </div>
            ) : clients.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <Building2 className="h-12 w-12 mx-auto mb-2 opacity-40" />
                <p className="font-medium">No clients yet</p>
                <p className="text-sm">
                  Add clients from Client Management to give them portal access.
                </p>
                <Link href="/clients">
                  <Button variant="outline" className="mt-4">
                    Go to Client Management
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="divide-y">
                {clients.slice(0, 10).map((client) => (
                  <div
                    key={client.id}
                    className="flex items-center justify-between py-3"
                    data-testid={`client-row-${client.id}`}
                  >
                    <div className="flex items-center space-x-3 min-w-0">
                      <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                        <Building2 className="h-5 w-5 text-blue-600" />
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900 truncate">
                          {client.name}
                        </div>
                        <div className="text-xs text-gray-500 truncate">
                          {client.contactEmail || client.contactPhone || "No contact info"}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">
                        <ShieldCheck className="h-3 w-3 mr-1" />
                        Active
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-portal-info">
          <CardHeader>
            <CardTitle className="text-lg font-semibold">
              About the Client Portal
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-gray-600 space-y-2">
            <p>
              The Client Portal is the customer-facing surface where your
              clients can review tickets, jobs, invoices, and service history
              for their account.
            </p>
            <p>
              Manage who has access from{" "}
              <Link href="/clients" className="text-blue-600 hover:underline inline-flex items-center">
                Client Management
                <ExternalLink className="h-3 w-3 ml-1" />
              </Link>
              , and configure plans from{" "}
              <Link href="/billing" className="text-blue-600 hover:underline inline-flex items-center">
                Billing & Plans
                <ExternalLink className="h-3 w-3 ml-1" />
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
