import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { format, subDays, startOfDay, endOfDay } from "date-fns";
import { Trash2 } from "lucide-react";

interface CsdIntakeRecord {
  id: number;
  customerName: string;
  phoneNumber: string;
  emailAddress: string;
  contactPreference: string;
  serviceType: string;
  serviceTypeOther?: string;
  deviceType: string;
  deviceBrandModel: string;
  operatingSystem: string;
  problemDescription: string;
  howDidYouHear: string;
  isFromActiveCall: boolean;
  callNotes?: string;
  callId?: string;
  source: string;
  campaign?: string;
  ipAddress?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface IntakeResponse {
  intakes: CsdIntakeRecord[];
  total: number;
  page: number;
  totalPages: number;
}

interface AnalyticsResponse {
  allTime: Record<string, number>;
  last7Days: number;
  last30Days: number;
  total: number;
}

interface IntakeLinks {
  linked: boolean;
  contact: { id: number; status: string } | null;
  client: { id: number; status: string } | null;
  lead: { id: number } | null;
  deal: { id: number } | null;
  job: { id: number; jobNumber: string | null } | null;
  ticket: { id: number; ticketNumber: string | null } | null;
  dispatch: { state: string; error: string | null };
}

/**
 * Every CRM record this intake produced. POST /api/intake creates the contact,
 * client, lead, deal, job and ticket in one transaction; this is the way back
 * into them from the request that started it all.
 */
function IntakeCrmLinks({ intakeId }: { intakeId: number }) {
  const { data, isLoading } = useQuery<IntakeLinks>({
    queryKey: ["intake-links", intakeId],
    queryFn: async () => (await apiRequest("GET", `/api/intake/${intakeId}/links`)).json(),
  });

  if (isLoading) return <p className="text-xs text-gray-500">Loading linked records…</p>;
  if (!data?.linked) {
    return (
      <p className="text-xs text-gray-500">
        No linked CRM records. This request predates automatic intake conversion.
      </p>
    );
  }

  const links: { label: string; href: string; badge?: string | null }[] = [];
  if (data.contact) links.push({ label: "Contact", href: "/crm/contacts", badge: data.contact.status });
  if (data.client) links.push({ label: "Customer account", href: `/crm/customers/${data.client.id}`, badge: data.client.status });
  if (data.lead) links.push({ label: `Lead #${data.lead.id}`, href: "/crm/leads" });
  if (data.deal) links.push({ label: `Deal #${data.deal.id}`, href: "/crm/pipeline" });
  if (data.job) links.push({ label: `Job ${data.job.jobNumber ?? `#${data.job.id}`}`, href: "/crm/jobs" });
  if (data.ticket) links.push({ label: `Ticket ${data.ticket.ticketNumber ?? `#${data.ticket.id}`}`, href: "/tickets" });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {links.map((link) => (
          <Link
            key={link.label}
            href={link.href}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-gray-50"
          >
            {link.label}
            {link.badge && link.badge !== "created" && link.badge !== "reused" && (
              <Badge variant="outline" className="ml-1 text-[10px]">{link.badge}</Badge>
            )}
          </Link>
        ))}
      </div>
      {data.dispatch.state !== "completed" && (
        <p className="text-xs text-amber-700">
          Dispatch {data.dispatch.state}
          {data.dispatch.error ? `: ${data.dispatch.error}` : ""}
        </p>
      )}
    </div>
  );
}

export default function CsdAdminPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<string>("all");
  const [selectedIntake, setSelectedIntake] = useState<CsdIntakeRecord | null>(null);

  // Build query parameters
  const getQueryParams = () => {
    const params = new URLSearchParams();
    params.set('page', page.toString());
    params.set('limit', '25');
    
    if (dateFilter !== "all") {
      const now = new Date();
      let startDate: Date;
      
      switch (dateFilter) {
        case "today":
          startDate = startOfDay(now);
          params.set('startDate', startDate.toISOString());
          params.set('endDate', endOfDay(now).toISOString());
          break;
        case "week":
          startDate = startOfDay(subDays(now, 7));
          params.set('startDate', startDate.toISOString());
          params.set('endDate', endOfDay(now).toISOString());
          break;
        case "month":
          startDate = startOfDay(subDays(now, 30));
          params.set('startDate', startDate.toISOString());
          params.set('endDate', endOfDay(now).toISOString());
          break;
      }
    }
    
    if (sourceFilter !== "all") {
      params.set('source', sourceFilter);
    }

    if (statusFilter !== "all") {
      params.set('status', statusFilter);
    }

    return params.toString();
  };

  const hasFilters = statusFilter !== "all" || sourceFilter !== "all" || dateFilter !== "all";

  // Fetch intake records
  const { data: intakeData, isLoading } = useQuery<IntakeResponse>({
    queryKey: ["csd-intakes", page, statusFilter, sourceFilter, dateFilter],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/intake?${getQueryParams()}`);
      return res.json();
    },
  });

  // Fetch analytics
  const { data: analytics } = useQuery<AnalyticsResponse>({
    queryKey: ["csd-analytics"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/intake/analytics/sources");
      return res.json();
    },
  });

  // Update intake status
  const updateIntakeMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      apiRequest("PUT", `/api/intake/${id}`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["csd-intakes"] });
      toast({ title: "Status updated successfully" });
      setSelectedIntake(null);
    },
    onError: () => {
      toast({ title: "Failed to update status", variant: "destructive" });
    },
  });

  const deleteIntakeMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/intake/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["csd-intakes"] });
      queryClient.invalidateQueries({ queryKey: ["csd-analytics"] });
      toast({ title: "Intake record deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete intake", variant: "destructive" });
    },
  });

  const getStatusBadge = (status: string) => {
    const variants = {
      new: "default" as const,
      contacted: "secondary" as const,
      scheduled: "outline" as const,
      completed: "default" as const,
      cancelled: "destructive" as const,
    };
    
    return (
      <Badge variant={variants[status as keyof typeof variants] || "default"}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </Badge>
    );
  };

  // Channels written by POST /api/intake. Anything else is a legacy or
  // hand-entered value and is shown verbatim.
  const SOURCE_LABELS: Record<string, string> = {
    website_intake: "Website Form",
    phone_call: "Active Phone Call",
  };

  const getSourceBadge = (source: string) => {
    const label = SOURCE_LABELS[source] ?? source;
    if (source === "phone_call") return <Badge variant="secondary">{label}</Badge>;
    if (source === "website_intake") return <Badge variant="outline">{label}</Badge>;
    return <Badge>{label}</Badge>;
  };

  return (
    <div className={embedded ? "space-y-6" : "space-y-6 p-6"}>
      {!embedded && (
        <div>
          <h1 className="text-3xl font-bold">CSD Intake Management</h1>
          <p className="text-gray-600">Manage Computer Systems Depot service requests and customer intake forms</p>
        </div>
      )}

      {/* Analytics Cards */}
      {analytics && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-gray-600">Total Intakes</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{analytics.total}</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-gray-600">Last 7 Days</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-blue-600">{analytics.last7Days}</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-gray-600">Last 30 Days</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{analytics.last30Days}</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-gray-600">Top Source</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-sm font-medium">
                {Object.entries(analytics.allTime).sort(([,a], [,b]) => b - a)[0]?.[0] || "N/A"}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Date Range</label>
              <Select value={dateFilter} onValueChange={setDateFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Time</SelectItem>
                  <SelectItem value="today">Today</SelectItem>
                  <SelectItem value="week">Last 7 Days</SelectItem>
                  <SelectItem value="month">Last 30 Days</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-2">Source</label>
              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sources</SelectItem>
                  <SelectItem value="website_intake">Website Form</SelectItem>
                  <SelectItem value="phone_call">Active Phone Call</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-2">Status</label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="new">New</SelectItem>
                  <SelectItem value="contacted">Contacted</SelectItem>
                  <SelectItem value="scheduled">Scheduled</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Intake Records Table */}
      <Card>
        <CardHeader>
          <CardTitle>Intake Records</CardTitle>
          <CardDescription>
            {intakeData ? `Showing ${intakeData.intakes.length} of ${intakeData.total} records` : "Loading..."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-8">Loading intake records...</div>
          ) : !intakeData?.intakes.length ? (
            <div className="py-8 text-center text-gray-500 space-y-2">
              <p>No intake records found{hasFilters ? " for these filters" : ""}.</p>
              {!hasFilters && (
                <p className="mx-auto max-w-md text-sm">
                  Service requests submitted before the intake form began saving a request
                  record appear under{" "}
                  <Link href="/crm/leads" className="font-medium text-blue-600 hover:underline">
                    Leads
                  </Link>{" "}
                  instead — the device, operating system and reported problem are all on the
                  lead. New submissions land here automatically.
                </p>
              )}
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {intakeData.intakes.map((intake) => (
                    <TableRow key={intake.id}>
                      <TableCell className="font-mono text-sm">
                        {format(new Date(intake.createdAt), "MM/dd HH:mm")}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{intake.customerName}</div>
                        <div className="text-sm text-gray-600">{intake.phoneNumber}</div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          {intake.serviceType === "Other" ? intake.serviceTypeOther : intake.serviceType}
                        </div>
                        <div className="text-xs text-gray-600">{intake.deviceType}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{intake.contactPreference}</Badge>
                        {intake.isFromActiveCall && (
                          <Badge variant="secondary" className="ml-1">Call</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {getSourceBadge(intake.source)}
                      </TableCell>
                      <TableCell>
                        {getStatusBadge(intake.status)}
                      </TableCell>
                      <TableCell>
                        <Dialog>
                          <DialogTrigger asChild>
                            <Button variant="outline" size="sm" onClick={() => setSelectedIntake(intake)}>
                              View
                            </Button>
                          </DialogTrigger>
                          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
                            <DialogHeader>
                              <DialogTitle>Intake Details - CSD-{intake.id}</DialogTitle>
                              <DialogDescription>
                                Submitted {format(new Date(intake.createdAt), "PPpp")}
                              </DialogDescription>
                            </DialogHeader>
                            
                            {selectedIntake?.id === intake.id && (
                              <div className="space-y-4">
                                {/* Customer Information */}
                                <div>
                                  <h4 className="font-semibold border-b pb-1 mb-2">Customer Information</h4>
                                  <div className="grid grid-cols-2 gap-4 text-sm">
                                    <div><strong>Name:</strong> {intake.customerName}</div>
                                    <div><strong>Phone:</strong> {intake.phoneNumber}</div>
                                    <div><strong>Email:</strong> {intake.emailAddress}</div>
                                    <div><strong>Contact Preference:</strong> {intake.contactPreference}</div>
                                  </div>
                                </div>

                                {/* Service Details */}
                                <div>
                                  <h4 className="font-semibold border-b pb-1 mb-2">Service Details</h4>
                                  <div className="space-y-2 text-sm">
                                    <div><strong>Service Type:</strong> {intake.serviceType === "Other" ? intake.serviceTypeOther : intake.serviceType}</div>
                                    <div><strong>Device:</strong> {intake.deviceType} - {intake.deviceBrandModel}</div>
                                    <div><strong>Operating System:</strong> {intake.operatingSystem}</div>
                                    <div><strong>Problem:</strong></div>
                                    <div className="bg-gray-50 p-2 rounded text-xs">{intake.problemDescription}</div>
                                  </div>
                                </div>

                                {/* Marketing & Call Info */}
                                <div>
                                  <h4 className="font-semibold border-b pb-1 mb-2">Additional Information</h4>
                                  <div className="grid grid-cols-2 gap-4 text-sm">
                                    <div><strong>How they heard:</strong> {intake.howDidYouHear}</div>
                                    <div><strong>Source:</strong> {intake.source}</div>
                                    {intake.campaign && <div><strong>Campaign:</strong> {intake.campaign}</div>}
                                    {intake.isFromActiveCall && (
                                      <>
                                        <div><strong>From call:</strong> Yes</div>
                                        {intake.callId && <div><strong>Call ID:</strong> {intake.callId}</div>}
                                        {intake.callNotes && (
                                          <div className="col-span-2">
                                            <strong>Call Notes:</strong>
                                            <div className="bg-gray-50 p-2 rounded text-xs mt-1">{intake.callNotes}</div>
                                          </div>
                                        )}
                                      </>
                                    )}
                                  </div>
                                </div>

                                {/* CRM records created from this request */}
                                <div>
                                  <h4 className="font-semibold border-b pb-1 mb-2">CRM Records</h4>
                                  <IntakeCrmLinks intakeId={intake.id} />
                                </div>

                                {/* Update Status */}
                                <div>
                                  <h4 className="font-semibold border-b pb-1 mb-2">Update Status</h4>
                                  <div className="flex gap-2">
                                    {["new", "contacted", "scheduled", "completed", "cancelled"].map((status) => (
                                      <Button
                                        key={status}
                                        variant={intake.status === status ? "default" : "outline"}
                                        size="sm"
                                        onClick={() => updateIntakeMutation.mutate({ id: intake.id, status })}
                                        disabled={updateIntakeMutation.isPending}
                                      >
                                        {status.charAt(0).toUpperCase() + status.slice(1)}
                                      </Button>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            )}
                          </DialogContent>
                        </Dialog>
                        <Button
                          variant="outline"
                          size="sm"
                          className="ml-2 text-red-600 hover:text-red-700"
                          onClick={() => {
                            if (window.confirm("Delete this intake record? This cannot be undone.")) {
                              deleteIntakeMutation.mutate(intake.id);
                            }
                          }}
                          disabled={deleteIntakeMutation.isPending}
                          aria-label="Delete intake"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* Pagination */}
              <div className="flex justify-between items-center mt-4">
                <div className="text-sm text-gray-600">
                  Page {intakeData.page} of {intakeData.totalPages}
                </div>
                <div className="flex gap-2">
                  <Button 
                    variant="outline" 
                    size="sm"
                    disabled={page === 1}
                    onClick={() => setPage(page - 1)}
                  >
                    Previous
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm"
                    disabled={page >= intakeData.totalPages}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}