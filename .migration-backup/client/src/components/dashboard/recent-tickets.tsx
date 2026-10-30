import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Ticket } from "@shared/schema";
import { Clock, User } from "lucide-react";

type UserRow = { id: number; name?: string | null; username?: string | null; fullName?: string | null };

interface RecentTicketsProps {
  tickets: Ticket[];
}

export default function RecentTickets({ tickets }: RecentTicketsProps) {
  const { data: users = [] } = useQuery<UserRow[]>({
    queryKey: ["/api/users"],
  });

  const userById = new Map<number, UserRow>(users.map(u => [u.id, u]));

  const userDisplayName = (u: UserRow | undefined) =>
    u?.fullName?.trim() || u?.name?.trim() || u?.username?.trim() || "";

  const userInitials = (name: string) => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "UN";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  };
  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case "high":
        return "bg-red-100 text-red-800";
      case "medium":
        return "bg-blue-100 text-blue-800";
      case "low":
        return "bg-green-100 text-green-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "in-progress":
        return "bg-yellow-100 text-yellow-800";
      case "open":
        return "bg-blue-100 text-blue-800";
      case "resolved":
        return "bg-green-100 text-green-800";
      case "closed":
        return "bg-gray-100 text-gray-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const formatTimeAgo = (date: Date | null) => {
    if (!date) return "";
    const now = new Date();
    const diff = now.getTime() - new Date(date).getTime();
    const minutes = Math.floor(diff / (1000 * 60));
    
    if (minutes < 60) {
      return `${minutes} min ago`;
    }
    
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    }
    
    const days = Math.floor(hours / 24);
    return `${days} day${days > 1 ? 's' : ''} ago`;
  };

  const getAssigneeName = (assignedTo: number | null) => {
    if (!assignedTo) return "Unassigned";
    const name = userDisplayName(userById.get(assignedTo));
    return name || `User #${assignedTo}`;
  };

  const getAssigneeInitials = (assignedTo: number | null) =>
    userInitials(getAssigneeName(assignedTo));

  return (
    <Card className="lg:col-span-2 bg-white shadow-sm border border-gray-200">
      <CardHeader className="pb-4">
        <div className="flex justify-between items-center">
          <div>
            <CardTitle className="text-lg font-semibold text-gray-900">
              Recent Support Tickets
            </CardTitle>
            <p className="text-sm text-gray-600">Latest customer requests</p>
          </div>
          <Button variant="ghost" className="text-primary hover:text-red-600">
            View All
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {tickets.length === 0 ? (
          <div className="text-center py-8">
            <User className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-500">No recent tickets</p>
          </div>
        ) : (
          tickets.slice(0, 3).map((ticket) => (
            <div
              key={ticket.id}
              className="flex items-center justify-between p-4 border border-gray-200 rounded-lg hover:border-primary hover:bg-red-50 transition-colors cursor-pointer"
            >
              <div className="flex items-center space-x-4">
                <div className="flex-shrink-0">
                  <Badge className={`text-xs font-medium ${getPriorityColor(ticket.priority)}`}>
                    {ticket.priority}
                  </Badge>
                </div>
                <div>
                  <p className="font-medium text-gray-900">{ticket.subject}</p>
                  <p className="text-sm text-gray-600">Client #{ticket.clientId}</p>
                  <div className="flex items-center space-x-4 mt-1">
                    <span className="text-xs text-gray-500">
                      Ticket #RMM-2024-{String(ticket.id).padStart(4, '0')}
                    </span>
                    <div className="flex items-center space-x-1">
                      <Clock className="h-3 w-3 text-gray-400" />
                      <span className="text-xs text-gray-500">
                        Created {formatTimeAgo(ticket.createdAt)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="flex items-center space-x-2">
                  <div className="w-6 h-6 bg-gray-300 rounded-full flex items-center justify-center">
                    <span className="text-xs font-medium text-gray-700">
                      {getAssigneeInitials(ticket.assignedTo)}
                    </span>
                  </div>
                  <span className="text-sm text-gray-600">
                    {getAssigneeName(ticket.assignedTo)}
                  </span>
                </div>
                <Badge 
                  className={`mt-1 text-xs font-medium ${getStatusColor(ticket.status)}`}
                >
                  {ticket.status === "in-progress" ? "In Progress" : ticket.status}
                </Badge>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
