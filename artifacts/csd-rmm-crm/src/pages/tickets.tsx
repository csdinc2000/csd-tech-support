import { Link } from "wouter";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Plus, Edit, Lock, AlertTriangle, Settings } from "lucide-react";
import { Ticket, TicketDepartment } from "@shared/schema";
import TicketForm from "@/components/forms/ticket-form";
import RemoteSessionPicker from "@/components/remote/remote-session-picker";
import TicketDetailDialog from "@/components/helpdesk/ticket-detail-dialog";

export default function Tickets() {
  const [showTicketForm, setShowTicketForm] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | undefined>();
  const [isEdit, setIsEdit] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [departmentFilter, setDepartmentFilter] = useState<string>("all");
  const [detailTicketId, setDetailTicketId] = useState<number | null>(null);

  const { data: tickets = [], isLoading } = useQuery<Ticket[]>({
    queryKey: ["/api/tickets"],
  });

  const { data: clients = [] } = useQuery<any[]>({
    queryKey: ["/api/clients"],
  });

  const { data: departments = [] } = useQuery<TicketDepartment[]>({
    queryKey: ["/api/helpdesk/departments"],
  });

  const filteredTickets = tickets.filter((ticket: Ticket) => {
    const matchesSearch =
      ticket.subject.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (ticket.description && ticket.description.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (ticket.ticketNumber && ticket.ticketNumber.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (ticket.requesterEmail && ticket.requesterEmail.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesStatus = statusFilter === "all" || ticket.status === statusFilter;
    const matchesPriority = priorityFilter === "all" || ticket.priority === priorityFilter;
    const matchesDept =
      departmentFilter === "all" || String(ticket.departmentId) === departmentFilter;
    return matchesSearch && matchesStatus && matchesPriority && matchesDept;
  });

  const handleEdit = (ticket: Ticket) => {
    setSelectedTicket(ticket);
    setIsEdit(true);
    setShowTicketForm(true);
  };

  const handleAdd = () => {
    setSelectedTicket(undefined);
    setIsEdit(false);
    setShowTicketForm(true);
  };

  const closeForm = () => {
    setShowTicketForm(false);
    setSelectedTicket(undefined);
    setIsEdit(false);
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case "high":
      case "critical":
        return "bg-red-100 text-red-800";
      case "medium":
        return "bg-yellow-100 text-yellow-800";
      case "low":
        return "bg-green-100 text-green-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "open":
        return "bg-blue-100 text-blue-800";
      case "in-progress":
        return "bg-yellow-100 text-yellow-800";
      case "resolved":
        return "bg-green-100 text-green-800";
      case "closed":
        return "bg-gray-100 text-gray-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const deptName = (id: number | null | undefined) =>
    id ? departments.find((d) => d.id === id)?.name || `Dept #${id}` : "—";

  const isOverdue = (t: Ticket) =>
    !!t.slaDueAt && new Date(t.slaDueAt) < new Date() && t.status !== "closed" && t.status !== "resolved";

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-4"></div>
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-24 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const overdueCount = tickets.filter(isOverdue).length;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-4 md:px-6 py-4">
        <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center space-y-4 lg:space-y-0">
          <div>
            <h2 className="text-xl md:text-2xl font-bold text-gray-900">Help Desk</h2>
            <p className="text-sm md:text-base text-gray-600">
              {tickets.length} tickets
              {overdueCount > 0 && (
                <span className="text-red-600 ml-2 inline-flex items-center">
                  <AlertTriangle className="h-4 w-4 mr-1" />
                  {overdueCount} overdue
                </span>
              )}
            </p>
          </div>
          <div className="flex flex-col space-y-3">
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center space-y-2 sm:space-y-0 sm:space-x-2">
              <Input
                placeholder="Search subject, #, email…"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full sm:w-48 lg:w-64"
              />
              <div className="flex space-x-2 flex-wrap gap-2">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-md text-sm"
                >
                  <option value="all">All Status</option>
                  <option value="open">Open</option>
                  <option value="in-progress">In Progress</option>
                  <option value="pending">Pending</option>
                  <option value="resolved">Resolved</option>
                  <option value="closed">Closed</option>
                </select>
                <select
                  value={priorityFilter}
                  onChange={(e) => setPriorityFilter(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-md text-sm"
                >
                  <option value="all">All Priority</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
                <select
                  value={departmentFilter}
                  onChange={(e) => setDepartmentFilter(e.target.value)}
                  className="px-3 py-2 border border-gray-300 rounded-md text-sm"
                >
                  <option value="all">All Departments</option>
                  {departments.map((d) => (
                    <option key={d.id} value={String(d.id)}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex gap-2">
              <Link href="/helpdesk/admin">
                <Button variant="outline" className="w-full sm:w-auto">
                  <Settings className="h-4 w-4 mr-2" /> Admin
                </Button>
              </Link>
              <Button className="bg-primary text-white hover:bg-primary w-full sm:w-auto" onClick={handleAdd}>
                <Plus className="h-4 w-4 mr-2" />
                New Ticket
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="p-4 md:p-6 space-y-4 md:space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>All Tickets ({filteredTickets.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-3">#</th>
                    <th className="text-left p-3">Subject</th>
                    <th className="text-left p-3">Requester</th>
                    <th className="text-left p-3">Dept</th>
                    <th className="text-left p-3">Priority</th>
                    <th className="text-left p-3">Status</th>
                    <th className="text-left p-3">SLA Due</th>
                    <th className="text-left p-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTickets.map((ticket: Ticket) => (
                    <tr
                      key={ticket.id}
                      className="border-b hover:bg-gray-50 cursor-pointer"
                      onClick={() => setDetailTicketId(ticket.id)}
                    >
                      <td className="p-3">
                        <span className="font-mono text-xs text-gray-600">
                          {ticket.ticketNumber || `#${ticket.id}`}
                        </span>
                        {ticket.lockedBy && (
                          <Lock className="inline h-3 w-3 ml-1 text-gray-500" />
                        )}
                      </td>
                      <td className="p-3">
                        <div className="font-medium text-gray-900">{ticket.subject}</div>
                        {ticket.description && (
                          <div className="text-xs text-gray-500 truncate max-w-md">
                            {ticket.description}
                          </div>
                        )}
                      </td>
                      <td className="p-3 text-sm text-gray-600">
                        {ticket.requesterName ? (
                          <div>
                            <div>{ticket.requesterName}</div>
                            <div className="text-xs text-gray-500">{ticket.requesterEmail}</div>
                          </div>
                        ) : ticket.clientId ? (
                          <Link href={`/crm/customers/${ticket.clientId}`} className="text-blue-600 hover:underline">
                            {clients.find((c) => c.id === ticket.clientId)?.name || `Client #${ticket.clientId}`}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="p-3 text-sm text-gray-600">{deptName(ticket.departmentId)}</td>
                      <td className="p-3">
                        <Badge className={getPriorityColor(ticket.priority)}>{ticket.priority}</Badge>
                      </td>
                      <td className="p-3">
                        <Badge className={getStatusColor(ticket.status)}>
                          {ticket.status === "in-progress" ? "In Progress" : ticket.status}
                        </Badge>
                      </td>
                      <td className="p-3 text-xs">
                        {ticket.slaDueAt ? (
                          <span className={isOverdue(ticket) ? "text-red-600 font-semibold" : "text-gray-600"}>
                            {new Date(ticket.slaDueAt).toLocaleString()}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="p-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center space-x-2">
                          <RemoteSessionPicker
                            clientId={ticket.clientId}
                            sourceType="ticket"
                            sourceId={ticket.id}
                            size="sm"
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEdit(ticket)}
                            className="text-primary"
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile View */}
            <div className="block lg:hidden space-y-3">
              {filteredTickets.map((ticket) => (
                <div
                  key={ticket.id}
                  className="border border-gray-200 rounded-lg p-4 cursor-pointer"
                  onClick={() => setDetailTicketId(ticket.id)}
                >
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <div className="font-mono text-xs text-gray-500">
                        {ticket.ticketNumber || `#${ticket.id}`}
                        {ticket.lockedBy && <Lock className="inline h-3 w-3 ml-1" />}
                      </div>
                      <div className="font-medium text-gray-900 mt-1">{ticket.subject}</div>
                    </div>
                    <div className="flex flex-col gap-1 items-end">
                      <Badge className={getPriorityColor(ticket.priority)}>{ticket.priority}</Badge>
                      <Badge className={getStatusColor(ticket.status)}>{ticket.status}</Badge>
                    </div>
                  </div>
                  <div className="text-xs text-gray-600 space-y-1">
                    <div>{ticket.requesterName || ticket.requesterEmail || "—"}</div>
                    <div>Dept: {deptName(ticket.departmentId)}</div>
                    {ticket.slaDueAt && (
                      <div className={isOverdue(ticket) ? "text-red-600" : ""}>
                        SLA due: {new Date(ticket.slaDueAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <TicketForm open={showTicketForm} onClose={closeForm} ticket={selectedTicket} isEdit={isEdit} />

      {detailTicketId && (
        <TicketDetailDialog
          ticketId={detailTicketId}
          open={!!detailTicketId}
          onClose={() => setDetailTicketId(null)}
        />
      )}
    </div>
  );
}
