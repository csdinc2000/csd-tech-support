import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { 
  Phone, Mail, MapPin, Activity, Ticket, Monitor, 
  Briefcase, FileText, CalendarDays, ArrowLeft, ArrowUpRight, ShieldAlert,
  Server, HardDrive, Users, Clock, Target, GitBranch, ClipboardList,
  MessageSquare, Wrench, Receipt, AlertCircle, CheckCircle2
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import ClientContractsCard from "@/components/contracts/client-contracts-card";
import { CustomerAvatar } from "@/components/customers/customer-avatar";
import { CallViaCsdButton } from "@/components/communications/call-via-csd-button";
import { useAdminAccess } from "@/hooks/use-admin-access";

export default function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAdminAccess();
  const { data: overview, isLoading, isError } = useQuery<any>({
    queryKey: [`/api/clients/${id}/overview`],
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-6">
          <div className="h-8 w-1/4 rounded bg-gray-200" />
          <div className="h-40 rounded-xl bg-gray-200" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div className="h-64 rounded-xl bg-gray-200" />
            <div className="h-64 rounded-xl bg-gray-200" />
            <div className="h-64 rounded-xl bg-gray-200" />
          </div>
        </div>
      </div>
    );
  }

  if (isError || !overview) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center p-6 text-center">
        <ShieldAlert className="mb-4 h-12 w-12 text-csd-red" />
        <h2 className="text-xl font-bold">Customer Not Found</h2>
        <p className="mt-2 text-muted-foreground">The requested customer could not be loaded.</p>
        <Button asChild variant="outline" className="mt-6">
          <Link href="/crm/customers">Back to Customers</Link>
        </Button>
      </div>
    );
  }

  const {
    client,
    contacts = [],
    devices = [],
    activeAlerts = [],
    tickets = [],
    jobs = [],
    invoices = [],
    appointments = [],
    counts = {},
  } = overview;
  // Sales context. The account often exists only because someone filled in the
  // public intake form, so the request, its lead and its deal belong here.
  const leads = overview.leads ?? [];
  const deals = overview.deals ?? [];
  const intakes = overview.intakes ?? [];
  const timeline = Array.isArray(overview.timeline) ? overview.timeline : null;
  const outstandingActions = Array.isArray(overview.outstandingActions) ? overview.outstandingActions : null;
  const money = (cents: number | null | undefined) =>
    cents == null ? "—" : `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  return (
    <div className="p-4 lg:p-6 space-y-6 bg-gray-50 min-h-screen">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/crm/customers" className="hover:text-foreground transition-colors flex items-center gap-1">
          <ArrowLeft className="h-3.5 w-3.5" />
          Customers
        </Link>
        <span>/</span>
        <span className="text-foreground font-medium truncate max-w-[200px]">{client.name}</span>
      </div>

      <div className="flex flex-col md:flex-row justify-between items-start gap-4">
        <div className="flex items-center gap-4">
          <CustomerAvatar clientId={client.id} name={client.name} avatar={client.avatar} />
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-gray-900">{client.name}</h1>
            <div className="flex items-center gap-4 mt-1 text-sm text-gray-600">
              {client.contactEmail && (
                <div className="flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5" /> {client.contactEmail}
                </div>
              )}
              {client.contactPhone && (
                <div className="flex items-center gap-1.5">
                  <Phone className="h-3.5 w-3.5" /> {client.contactPhone}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" className="shadow-sm" data-testid="button-invoice-customer">
            <Link href={`/invoices?bill=client:${client.id}`}>
              <FileText className="mr-2 h-4 w-4" />
              New Invoice
            </Link>
          </Button>
          <Button className="bg-csd-red hover:bg-red-700 text-white shadow-sm">Add Job</Button>
        </div>
      </div>

      {/* Overview Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        <StatCard title="Contacts" value={counts.contacts ?? contacts.length} icon={Users} color="text-blue-600" bg="bg-blue-50" />
        <StatCard title="Devices" value={counts.devices ?? devices.length} icon={Monitor} color="text-purple-600" bg="bg-purple-50" />
        <StatCard title="Active Alerts" value={counts.activeAlerts ?? activeAlerts.length} icon={Activity} color={(counts.activeAlerts ?? activeAlerts.length) > 0 ? "text-csd-red" : "text-green-600"} bg={(counts.activeAlerts ?? activeAlerts.length) > 0 ? "bg-red-50" : "bg-green-50"} />
        <StatCard title="Open Tickets" value={counts.openTickets ?? tickets.filter((ticket: any) => !["closed", "resolved"].includes(String(ticket.status).toLowerCase())).length} icon={Ticket} color="text-amber-600" bg="bg-amber-50" />
        <StatCard title="Jobs" value={counts.jobs ?? jobs.length} icon={Briefcase} color="text-indigo-600" bg="bg-indigo-50" />
        <StatCard title="Invoices" value={counts.invoices ?? invoices.length} icon={FileText} color="text-emerald-600" bg="bg-emerald-50" />
        <StatCard title="Leads" value={counts.leads ?? leads.length} icon={Target} color="text-sky-600" bg="bg-sky-50" />
        <StatCard title="Deals" value={counts.deals ?? deals.length} icon={GitBranch} color="text-fuchsia-600" bg="bg-fuchsia-50" />
        <StatCard title="Service Requests" value={counts.intakes ?? intakes.length} icon={ClipboardList} color="text-orange-600" bg="bg-orange-50" />
      </div>

      {outstandingActions && (
        <OutstandingActions actions={outstandingActions} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column */}
        <div className="lg:col-span-2 space-y-6">
          <ClientContractsCard client={client} />
          {timeline && <UnifiedTimeline items={timeline} />}

          <Card className="shadow-sm border-gray-200">
            <CardHeader className="pb-3 border-b bg-gray-50/50 rounded-t-xl">
              <div className="flex justify-between items-center">
                <CardTitle className="text-base flex items-center gap-2">
                  <Monitor className="h-4 w-4 text-purple-600" />
                  Managed Devices
                </CardTitle>
                <Link href="/devices" className="text-xs font-medium text-blue-600 hover:text-blue-800 flex items-center gap-1">
                  View All <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {devices.length === 0 ? (
                <div className="p-6 text-center text-sm text-gray-500">No devices found.</div>
              ) : (
                <div className="divide-y">
                  {devices.slice(0, 5).map((device: any) => (
                    <div key={device.id} className="flex items-center justify-between p-4 hover:bg-gray-50/50">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-gray-100 rounded-md">
                          {device.type === "server" ? <Server className="h-4 w-4 text-gray-700" /> : device.type === "network" ? <HardDrive className="h-4 w-4 text-gray-700" /> : <Monitor className="h-4 w-4 text-gray-700" />}
                        </div>
                        <div>
                          <div className="font-medium text-sm">{device.name}</div>
                          <div className="text-xs text-gray-500 capitalize">{device.type}</div>
                        </div>
                      </div>
                      <Badge variant={device.status === "online" ? "default" : "secondary"} className={device.status === "online" ? "bg-green-100 text-green-800 hover:bg-green-200 shadow-none border-0" : ""}>
                        {device.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-sm border-gray-200">
            <CardHeader className="pb-3 border-b bg-gray-50/50 rounded-t-xl">
              <div className="flex justify-between items-center">
                <CardTitle className="text-base flex items-center gap-2">
                  <Briefcase className="h-4 w-4 text-indigo-600" />
                  Recent Jobs
                </CardTitle>
                <Link href="/crm/jobs" className="text-xs font-medium text-blue-600 hover:text-blue-800 flex items-center gap-1">
                  View All <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {jobs.length === 0 ? (
                <div className="p-6 text-center text-sm text-gray-500">No recent jobs.</div>
              ) : (
                <div className="divide-y">
                  {jobs.slice(0, 5).map((job: any) => (
                    <div key={job.id} className="flex items-center justify-between p-4 hover:bg-gray-50/50">
                      <div>
                        <div className="font-mono text-xs font-medium text-blue-600 mb-1">{job.jobNumber}</div>
                        <div className="text-sm font-medium">{job.serviceType.replace(/_/g, " ")}</div>
                      </div>
                      <div className="text-right">
                        <Badge variant="outline" className="mb-1">{job.status.replace(/_/g, " ")}</Badge>
                        <div className="text-xs text-gray-500">
                          {job.createdAt ? format(new Date(job.createdAt), "MMM d, yyyy") : "-"}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-sm border-gray-200">
            <CardHeader className="pb-3 border-b bg-gray-50/50 rounded-t-xl">
              <div className="flex justify-between items-center">
                <CardTitle className="text-base flex items-center gap-2">
                  <FileText className="h-4 w-4 text-emerald-600" />
                  Invoices
                </CardTitle>
                <Link href="/invoices" className="text-xs font-medium text-blue-600 hover:text-blue-800 flex items-center gap-1">
                  View All <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {invoices.length === 0 ? (
                <div className="p-6 text-center text-sm text-gray-500">No invoices.</div>
              ) : (
                <div className="divide-y">
                  {invoices.slice(0, 5).map((invoice: any) => (
                    <div key={invoice.id} className="flex items-center justify-between p-4 hover:bg-gray-50/50">
                      <div>
                        <Link href={`/invoices/${invoice.id}`} className="font-mono text-xs font-medium text-blue-600 hover:underline">
                          {invoice.invoiceNumber}
                        </Link>
                        <div className="text-sm font-semibold mt-1">
                          {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(invoice.totalCents / 100)}
                        </div>
                      </div>
                      <div className="text-right">
                        <Badge variant="outline" className={
                          invoice.status === "paid" ? "bg-green-50 text-green-700 border-green-200" :
                          invoice.status === "draft" ? "bg-gray-50 text-gray-700" :
                          "bg-amber-50 text-amber-700 border-amber-200"
                        }>
                          {invoice.status}
                        </Badge>
                        <div className="text-xs text-gray-500 mt-1">
                          {invoice.createdAt ? format(new Date(invoice.createdAt), "MMM d, yyyy") : "-"}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          <Card className="shadow-sm border-gray-200">
            <CardHeader className="pb-3 border-b bg-gray-50/50 rounded-t-xl">
              <div className="flex justify-between items-center">
                <CardTitle className="text-base flex items-center gap-2">
                  <Ticket className="h-4 w-4 text-amber-600" />
                  Tickets
                </CardTitle>
                <Link href="/tickets" data-testid="link-all-customer-tickets" className="text-xs font-medium text-blue-600 hover:text-blue-800 flex items-center gap-1">
                  View All <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {tickets.length === 0 ? (
                <div className="p-6 text-center text-sm text-gray-500">No tickets for this account.</div>
              ) : (
                <div className="divide-y">
                  {tickets.slice(0, 5).map((ticket: any) => (
                    <div key={ticket.id} data-testid={`row-customer-ticket-${ticket.id}`} className="p-4 hover:bg-gray-50/50">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-mono text-xs font-medium text-blue-600">
                            {ticket.ticketNumber || `#${ticket.id}`}
                          </div>
                          <div className="mt-1 text-sm font-medium text-gray-900 line-clamp-2">{ticket.subject}</div>
                        </div>
                        <Badge variant="outline" className="text-[10px] uppercase shrink-0">{humanize(ticket.status)}</Badge>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-gray-500">
                        <span className="capitalize">{humanize(ticket.priority)}</span>
                        <span>{formatDate(ticket.updatedAt ?? ticket.createdAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-sm border-gray-200">
            <CardHeader className="pb-3 border-b bg-gray-50/50 rounded-t-xl">
              <div className="flex justify-between items-center">
                <CardTitle className="text-base flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-sky-600" />
                  Appointments
                </CardTitle>
                <Link href="/calendar" data-testid="link-customer-calendar" className="text-xs font-medium text-blue-600 hover:text-blue-800 flex items-center gap-1">
                  Calendar <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {appointments.length === 0 ? (
                <div className="p-6 text-center text-sm text-gray-500">No appointments for this account.</div>
              ) : (
                <div className="divide-y">
                  {appointments.slice(0, 5).map((appointment: any) => (
                    <div key={appointment.id} data-testid={`row-customer-appointment-${appointment.id}`} className="p-4 hover:bg-gray-50/50">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900 truncate">
                            {appointment.reference || `Appointment #${appointment.id}`}
                          </div>
                          <div className="mt-1 flex items-center gap-1 text-xs text-gray-500">
                            <Clock className="h-3 w-3" />
                            {formatDate(appointment.startsAt, true)}
                          </div>
                        </div>
                        <Badge variant="outline" className="text-[10px] uppercase shrink-0">{humanize(appointment.status)}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {client.address && (
            <Card className="shadow-sm border-gray-200">
              <CardHeader className="pb-3 border-b bg-gray-50/50 rounded-t-xl">
                <CardTitle className="text-base flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-gray-500" /> Location
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <address className="not-italic text-sm text-gray-700">
                  {client.address}<br />
                  {client.city && client.state ? `${client.city}, ${client.state} ${client.zipCode || ""}` : ""}
                </address>
              </CardContent>
            </Card>
          )}

          <Card className="shadow-sm border-gray-200">
            <CardHeader className="pb-3 border-b bg-gray-50/50 rounded-t-xl">
              <div className="flex justify-between items-center">
                <CardTitle className="text-base flex items-center gap-2">
                  <Users className="h-4 w-4 text-blue-600" />
                  Contacts
                </CardTitle>
                <Link href="/crm/contacts" className="text-xs font-medium text-blue-600 hover:text-blue-800 flex items-center gap-1">
                  View All <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {contacts.length === 0 ? (
                <div className="p-6 text-center text-sm text-gray-500">No contacts.</div>
              ) : (
                <div className="divide-y">
                  {contacts.map((contact: any) => (
                    <div key={contact.id} className="p-4 hover:bg-gray-50/50">
                      <div className="font-medium text-sm text-gray-900">{contact.fullName}</div>
                      <div className="mt-2 space-y-1.5">
                        {contact.email && (
                          <div className="flex items-center gap-2 text-xs text-gray-600">
                            <Mail className="h-3.5 w-3.5 text-gray-400" />
                            {can("communications")
                              ? <Link className="font-medium text-csd-red hover:underline" href={`/comms/email?contactId=${encodeURIComponent(contact.id)}`}>Email {contact.email} from Support</Link>
                              : <span>{contact.email}</span>}
                          </div>
                        )}
                        {[contact.mobilePhone, contact.officePhone].filter(Boolean).map((phone: string, index: number) => (
                          <div key={`${contact.id}-phone-${index}`} className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                            <Phone className="h-3.5 w-3.5 text-gray-400" /> <span className="font-mono">{phone}</span>
                            <CallViaCsdButton phone={phone} contactId={contact.id} label="Call from app" />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-sm border-gray-200">
            <CardHeader className="pb-3 border-b bg-gray-50/50 rounded-t-xl">
              <div className="flex justify-between items-center">
                <CardTitle className="text-base flex items-center gap-2">
                  <Activity className="h-4 w-4 text-csd-red" />
                  Active Alerts
                </CardTitle>
                <Link href="/monitoring" className="text-xs font-medium text-blue-600 hover:text-blue-800 flex items-center gap-1">
                  Monitoring <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {activeAlerts.length === 0 ? (
                <div className="p-6 text-center text-sm text-gray-500">No active alerts.</div>
              ) : (
                <div className="divide-y">
                  {activeAlerts.slice(0, 5).map((alert: any) => (
                    <div key={alert.id} className="p-4 hover:bg-gray-50/50">
                      <div className="flex justify-between items-start mb-1">
                        <div className="font-medium text-sm text-gray-900 line-clamp-1">{alert.title}</div>
                        <Badge variant="outline" className="text-[10px] uppercase">{alert.severity}</Badge>
                      </div>
                      <div className="text-xs text-gray-500 flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {alert.createdAt ? format(new Date(alert.createdAt), "MMM d, yyyy HH:mm") : ""}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-sm border-gray-200">
            <CardHeader className="pb-3 border-b bg-gray-50/50 rounded-t-xl">
              <div className="flex justify-between items-center">
                <CardTitle className="text-base flex items-center gap-2">
                  <ClipboardList className="h-4 w-4 text-orange-600" />
                  Service Requests &amp; Leads
                </CardTitle>
                <Link href="/crm/leads" className="text-xs font-medium text-blue-600 hover:text-blue-800 flex items-center gap-1">
                  Leads <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {leads.length === 0 && intakes.length === 0 ? (
                <div className="p-6 text-center text-sm text-gray-500">
                  No service requests or leads for this account yet.
                </div>
              ) : (
                <div className="divide-y">
                  {leads.slice(0, 6).map((lead: any) => (
                    <div key={`lead-${lead.id}`} className="p-4 hover:bg-gray-50/50">
                      <div className="flex justify-between items-start mb-1 gap-2">
                        <div className="font-medium text-sm text-gray-900">{lead.serviceType}</div>
                        <div className="flex items-center gap-2 shrink-0">
                          {lead.estimatedValue != null && (
                            <span className="text-xs font-medium text-gray-700">{money(lead.estimatedValue)}</span>
                          )}
                          <Badge variant="outline" className="text-[10px] uppercase">{lead.status}</Badge>
                        </div>
                      </div>
                      <div className="text-xs text-gray-500">
                        {[lead.deviceType, lead.brandModel, lead.operatingSystem].filter(Boolean).join(" · ") || "No device details"}
                      </div>
                      <div className="text-xs text-gray-400 flex items-center gap-1 mt-0.5">
                        <Clock className="h-3 w-3" />
                        {lead.createdAt ? format(new Date(lead.createdAt), "MMM d, yyyy") : ""}
                        {lead.campaign ? ` · heard via ${lead.campaign}` : ""}
                      </div>
                    </div>
                  ))}
                  {intakes.slice(0, 4).map((intake: any) => (
                    <div key={`intake-${intake.id}`} className="p-4 hover:bg-gray-50/50">
                      <div className="flex justify-between items-start mb-1 gap-2">
                        <div className="text-sm text-gray-900">
                          <span className="font-medium">Intake CSD-{intake.id}</span>
                          <span className="text-gray-500"> · {intake.serviceType}</span>
                        </div>
                        <Badge variant="secondary" className="text-[10px] uppercase shrink-0">{intake.status}</Badge>
                      </div>
                      <div className="text-xs text-gray-400 flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {intake.createdAt ? format(new Date(intake.createdAt), "MMM d, yyyy") : ""}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-sm border-gray-200">
            <CardHeader className="pb-3 border-b bg-gray-50/50 rounded-t-xl">
              <div className="flex justify-between items-center">
                <CardTitle className="text-base flex items-center gap-2">
                  <GitBranch className="h-4 w-4 text-fuchsia-600" />
                  Deals
                </CardTitle>
                <Link href="/crm/pipeline" className="text-xs font-medium text-blue-600 hover:text-blue-800 flex items-center gap-1">
                  Pipeline <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {deals.length === 0 ? (
                <div className="p-6 text-center text-sm text-gray-500">No deals for this account.</div>
              ) : (
                <div className="divide-y">
                  {deals.slice(0, 6).map((deal: any) => (
                    <div key={deal.id} className="p-4 hover:bg-gray-50/50">
                      <div className="flex justify-between items-start mb-1 gap-2">
                        <div className="font-medium text-sm text-gray-900 line-clamp-1">{deal.title}</div>
                        <Badge variant="outline" className="text-[10px] uppercase shrink-0">{deal.stage}</Badge>
                      </div>
                      <div className="text-xs text-gray-500">
                        {Number(deal.estimatedMrr) > 0 && `$${Number(deal.estimatedMrr).toLocaleString()}/mo`}
                        {Number(deal.estimatedMrr) > 0 && Number(deal.oneTimeFee) > 0 && " + "}
                        {Number(deal.oneTimeFee) > 0 && `$${Number(deal.oneTimeFee).toLocaleString()} one-time`}
                        {Number(deal.estimatedMrr) === 0 && Number(deal.oneTimeFee) === 0 && "No value set"}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

        </div>
      </div>
    </div>
  );
}

function StatCard({ title, value, icon: Icon, color, bg }: { title: string, value: number, icon: any, color: string, bg: string }) {
  return (
    <Card className="shadow-sm border-gray-200">
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`p-2 rounded-lg ${bg} ${color}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-2xl font-bold text-gray-900">{value}</div>
          <div className="text-xs font-medium text-gray-500">{title}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function humanize(value: unknown) {
  return typeof value === "string" && value
    ? value.replace(/[_-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
    : "—";
}

function formatDate(value: unknown, includeTime = false) {
  if (!value) return "—";
  const date = new Date(value as string | number | Date);
  if (Number.isNaN(date.getTime())) return "—";
  return format(date, includeTime ? "MMM d, yyyy · h:mm a" : "MMM d, yyyy");
}

function itemHref(item: any): string | null {
  const href = item?.href ?? item?.url ?? item?.link;
  return typeof href === "string" && href.startsWith("/") ? href : null;
}

function actionTone(value: unknown, kind: "priority" | "status") {
  const normalized = String(value ?? "").toLowerCase();
  if (["urgent", "critical", "overdue", "blocked"].includes(normalized)) return "bg-red-50 text-red-700 border-red-200";
  if (["high", "pending", "open", "due"].includes(normalized)) return "bg-amber-50 text-amber-700 border-amber-200";
  if (["completed", "paid", "resolved", "closed"].includes(normalized)) return "bg-green-50 text-green-700 border-green-200";
  return kind === "priority" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-gray-50 text-gray-700 border-gray-200";
}

function OutstandingActions({ actions }: { actions: any[] }) {
  return (
    <Card className="shadow-sm border-amber-200 overflow-hidden">
      <CardHeader className="pb-3 border-b border-amber-200 bg-amber-50/70">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-amber-600" />
            Outstanding Action Items
          </CardTitle>
          <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 border-0 shadow-none">
            {actions.length}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {actions.length === 0 ? (
          <div data-testid="status-no-outstanding-actions" className="flex items-center justify-center gap-2 p-6 text-sm text-gray-500">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            No outstanding action items.
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {actions.map((action: any, index: number) => {
              const href = itemHref(action);
              const title = action.title ?? action.label ?? action.description ?? humanize(action.type);
              const row = (
                <div className="flex flex-col gap-3 p-4 hover:bg-amber-50/30 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-sm text-gray-900">{title}</span>
                      {action.priority && (
                        <Badge variant="outline" className={`text-[10px] uppercase ${actionTone(action.priority, "priority")}`}>
                          {humanize(action.priority)}
                        </Badge>
                      )}
                      {action.status && (
                        <Badge variant="outline" className={`text-[10px] uppercase ${actionTone(action.status, "status")}`}>
                          {humanize(action.status)}
                        </Badge>
                      )}
                    </div>
                    {(action.summary || action.description) && (action.summary || action.description) !== title && (
                      <p className="mt-1 text-xs text-gray-500 line-clamp-2">{action.summary || action.description}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <div className="text-xs text-gray-500">
                      <span className="font-medium text-gray-600">Due:</span>{" "}
                      {formatDate(action.dueDate ?? action.dueAt)}
                    </div>
                    {href && <ArrowUpRight className="h-4 w-4 text-blue-600" />}
                  </div>
                </div>
              );
              return href ? (
                <Link key={action.id ?? `${action.type}-${index}`} href={href} data-testid={`link-outstanding-action-${action.id ?? index}`} className="block">
                  {row}
                </Link>
              ) : (
                <div key={action.id ?? `${action.type}-${index}`} data-testid={`row-outstanding-action-${action.id ?? index}`}>
                  {row}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const timelineMeta: Record<string, { icon: any; color: string; bg: string; label: string }> = {
  call: { icon: Phone, color: "text-blue-600", bg: "bg-blue-50", label: "Call" },
  sms: { icon: MessageSquare, color: "text-violet-600", bg: "bg-violet-50", label: "SMS" },
  text_message: { icon: MessageSquare, color: "text-violet-600", bg: "bg-violet-50", label: "SMS" },
  intake: { icon: ClipboardList, color: "text-orange-600", bg: "bg-orange-50", label: "Intake" },
  interaction: { icon: Users, color: "text-fuchsia-600", bg: "bg-fuchsia-50", label: "CRM" },
  crm_interaction: { icon: Users, color: "text-fuchsia-600", bg: "bg-fuchsia-50", label: "CRM" },
  service_log: { icon: Wrench, color: "text-slate-600", bg: "bg-slate-100", label: "Service Log" },
  ticket: { icon: Ticket, color: "text-amber-600", bg: "bg-amber-50", label: "Ticket" },
  job: { icon: Briefcase, color: "text-indigo-600", bg: "bg-indigo-50", label: "Job" },
  appointment: { icon: CalendarDays, color: "text-sky-600", bg: "bg-sky-50", label: "Appointment" },
  invoice: { icon: Receipt, color: "text-emerald-600", bg: "bg-emerald-50", label: "Invoice" },
};

function UnifiedTimeline({ items }: { items: any[] }) {
  return (
    <Card className="shadow-sm border-gray-200">
      <CardHeader className="pb-3 border-b bg-gray-50/50 rounded-t-xl">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4 text-blue-600" />
          Communication &amp; Service Timeline
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? (
          <div data-testid="status-empty-customer-timeline" className="p-6 text-center text-sm text-gray-500">
            No communication or service history yet.
          </div>
        ) : (
          <div className="divide-y">
            {items.map((item: any, index: number) => {
              const type = String(item.kind ?? item.type ?? item.interactionType ?? item.category ?? "")
                .replace(/([a-z])([A-Z])/g, "$1_$2")
                .toLowerCase()
                .replace(/[\s-]/g, "_");
              const meta = timelineMeta[type] ?? { icon: Activity, color: "text-gray-600", bg: "bg-gray-100", label: humanize(type || "activity") };
              const Icon = meta.icon;
              const href = itemHref(item);
              const title = item.title ?? item.subject ?? item.description ?? meta.label;
              const timestamp = item.timestamp ?? item.occurredAt ?? item.createdAt ?? item.date;
              const content = (
                <div className="flex gap-3 p-4 hover:bg-gray-50/50">
                  <div className={`mt-0.5 rounded-lg p-2 ${meta.bg} ${meta.color}`}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-gray-900">{title}</span>
                          <Badge variant="outline" className="text-[10px] uppercase">{meta.label}</Badge>
                          {item.status && <Badge variant="secondary" className="text-[10px] uppercase">{humanize(item.status)}</Badge>}
                        </div>
                        {(item.summary || item.description) && (item.summary || item.description) !== title && (
                          <p className="mt-1 text-xs text-gray-500 line-clamp-2">{item.summary || item.description}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1 text-xs text-gray-400">
                        <Clock className="h-3 w-3" />
                        {formatDate(timestamp, true)}
                        {href && <ArrowUpRight className="ml-1 h-3 w-3 text-blue-600" />}
                      </div>
                    </div>
                  </div>
                </div>
              );
              return href ? (
                <Link key={item.id ?? item.itemId ?? `${type}-${index}`} href={href} data-testid={`link-timeline-item-${item.id ?? item.itemId ?? index}`} className="block">
                  {content}
                </Link>
              ) : (
                <div key={item.id ?? item.itemId ?? `${type}-${index}`} data-testid={`row-timeline-item-${item.id ?? item.itemId ?? index}`}>
                  {content}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
