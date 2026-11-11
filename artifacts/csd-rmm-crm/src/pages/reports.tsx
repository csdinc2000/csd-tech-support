import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Download, TrendingUp, TrendingDown, BarChart3, PieChart, Activity } from "lucide-react";
import type { Device, Ticket, Alert } from "@shared/schema";

export default function Reports() {
  const { data: devices = [], isLoading: devicesLoading } = useQuery<Device[]>({
    queryKey: ["/api/devices"],
  });

  const { data: tickets = [], isLoading: ticketsLoading } = useQuery<Ticket[]>({
    queryKey: ["/api/tickets"],
  });

  const { data: alerts = [], isLoading: alertsLoading } = useQuery<Alert[]>({
    queryKey: ["/api/alerts"],
  });

  const isLoading = devicesLoading || ticketsLoading || alertsLoading;

  // Calculate report metrics
  const calculateMetrics = () => {
    const totalDevices = devices.length;
    const onlineDevices = devices.filter(d => d.status === "online").length;
    const offlineDevices = devices.filter(d => d.status === "offline").length;
    const warningDevices = devices.filter(d => d.status === "warning").length;
    
    const totalTickets = tickets.length;
    const openTickets = tickets.filter(t => t.status === "open").length;
    const resolvedTickets = tickets.filter(t => t.status === "resolved").length;
    const inProgressTickets = tickets.filter(t => t.status === "in-progress").length;
    
    const closedTickets = tickets.filter(t => t.status === "closed").length;

    const totalAlerts = alerts.length;
    const criticalAlerts = alerts.filter(a => a.severity === "critical").length;
    const warningAlerts = alerts.filter(a => a.severity === "warning").length;

    const uptime = totalDevices > 0 ? Math.round((onlineDevices / totalDevices) * 100) : 100;

    // Real average resolution time, computed from tickets that have both a
    // created and a closed timestamp (in hours). Null when there's no data yet.
    const completed = tickets.filter(t => t.status === "resolved" || t.status === "closed");
    const durationsMs = completed
      .map(t => {
        const start = t.createdAt ? new Date(t.createdAt).getTime() : NaN;
        const end = t.closedAt ? new Date(t.closedAt).getTime() : NaN;
        return Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : null;
      })
      .filter((ms): ms is number => ms !== null);
    const avgResolutionHours = durationsMs.length
      ? durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length / 3_600_000
      : null;

    const completedTickets = resolvedTickets + closedTickets;
    const resolutionRate = totalTickets > 0 ? Math.round((completedTickets / totalTickets) * 100) : 0;

    return {
      totalDevices,
      onlineDevices,
      offlineDevices,
      warningDevices,
      totalTickets,
      openTickets,
      resolvedTickets,
      inProgressTickets,
      closedTickets,
      completedTickets,
      resolutionRate,
      avgResolutionHours,
      resolvedCount: durationsMs.length,
      totalAlerts,
      criticalAlerts,
      warningAlerts,
      uptime,
    };
  };

  const metrics = calculateMetrics();

  const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);

  const avgResolutionLabel =
    metrics.avgResolutionHours == null
      ? "—"
      : metrics.avgResolutionHours < 1
        ? `${Math.round(metrics.avgResolutionHours * 60)}min`
        : `${metrics.avgResolutionHours.toFixed(1)}hrs`;

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-4"></div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-32 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Reports & Analytics</h2>
            <p className="text-gray-600">System health reports and performance metrics</p>
          </div>
          <div className="flex space-x-3">
            <Button variant="outline">
              <BarChart3 className="h-4 w-4 mr-2" />
              Custom Report
            </Button>
            <Button className="bg-primary text-white hover:bg-primary">
              <Download className="h-4 w-4 mr-2" />
              Export All
            </Button>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* Overview Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <Card className="bg-white shadow-sm border border-gray-200">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">System Uptime</p>
                  <p className="text-3xl font-bold text-green-600">{metrics.uptime}%</p>
                </div>
                <div className="p-3 rounded-full bg-green-100">
                  <TrendingUp className="h-5 w-5 text-green-600" />
                </div>
              </div>
              <div className="mt-4 flex items-center text-sm">
                <span className="text-gray-500">{metrics.onlineDevices} of {metrics.totalDevices} devices online</span>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-white shadow-sm border border-gray-200">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Avg Resolution Time</p>
                  <p className="text-3xl font-bold text-blue-600">{avgResolutionLabel}</p>
                </div>
                <div className="p-3 rounded-full bg-blue-100">
                  <Activity className="h-5 w-5 text-blue-600" />
                </div>
              </div>
              <div className="mt-4 flex items-center text-sm">
                <span className="text-gray-500">
                  {metrics.resolvedCount > 0
                    ? `across ${metrics.resolvedCount} completed ticket${metrics.resolvedCount === 1 ? "" : "s"}`
                    : "no completed tickets yet"}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-white shadow-sm border border-gray-200">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Resolution Rate</p>
                  <p className="text-3xl font-bold text-purple-600">{metrics.resolutionRate}%</p>
                </div>
                <div className="p-3 rounded-full bg-purple-100">
                  <TrendingUp className="h-5 w-5 text-purple-600" />
                </div>
              </div>
              <div className="mt-4 flex items-center text-sm">
                <span className="text-gray-500">{metrics.completedTickets} of {metrics.totalTickets} tickets resolved</span>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-white shadow-sm border border-gray-200">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Active Alerts</p>
                  <p className="text-3xl font-bold text-green-600">{metrics.totalAlerts}</p>
                </div>
                <div className="p-3 rounded-full bg-green-100">
                  <Activity className="h-5 w-5 text-green-600" />
                </div>
              </div>
              <div className="mt-4 flex items-center text-sm">
                <span className="text-gray-500">{metrics.criticalAlerts} critical, {metrics.warningAlerts} warning</span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Device Health Report */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <PieChart className="h-5 w-5" />
                <span>Device Health Overview</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="w-4 h-4 bg-green-500 rounded-full"></div>
                    <span className="text-sm font-medium">Online Devices</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-2xl font-bold text-green-600">{metrics.onlineDevices}</span>
                    <Badge className="bg-green-100 text-green-800">
                      {pct(metrics.onlineDevices, metrics.totalDevices)}%
                    </Badge>
                  </div>
                </div>
                
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="w-4 h-4 bg-yellow-500 rounded-full"></div>
                    <span className="text-sm font-medium">Warning Status</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-2xl font-bold text-yellow-600">{metrics.warningDevices}</span>
                    <Badge className="bg-yellow-100 text-yellow-800">
                      {pct(metrics.warningDevices, metrics.totalDevices)}%
                    </Badge>
                  </div>
                </div>
                
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="w-4 h-4 bg-red-500 rounded-full"></div>
                    <span className="text-sm font-medium">Offline Devices</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-2xl font-bold text-red-600">{metrics.offlineDevices}</span>
                    <Badge className="bg-red-100 text-red-800">
                      {pct(metrics.offlineDevices, metrics.totalDevices)}%
                    </Badge>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <BarChart3 className="h-5 w-5" />
                <span>Ticket Resolution Summary</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="w-4 h-4 bg-green-500 rounded-full"></div>
                    <span className="text-sm font-medium">Resolved</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-2xl font-bold text-green-600">{metrics.resolvedTickets}</span>
                    <Badge className="bg-green-100 text-green-800">
                      {pct(metrics.resolvedTickets, metrics.totalTickets)}%
                    </Badge>
                  </div>
                </div>
                
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="w-4 h-4 bg-yellow-500 rounded-full"></div>
                    <span className="text-sm font-medium">In Progress</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-2xl font-bold text-yellow-600">{metrics.inProgressTickets}</span>
                    <Badge className="bg-yellow-100 text-yellow-800">
                      {pct(metrics.inProgressTickets, metrics.totalTickets)}%
                    </Badge>
                  </div>
                </div>
                
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="w-4 h-4 bg-blue-500 rounded-full"></div>
                    <span className="text-sm font-medium">Open</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-2xl font-bold text-blue-600">{metrics.openTickets}</span>
                    <Badge className="bg-blue-100 text-blue-800">
                      {pct(metrics.openTickets, metrics.totalTickets)}%
                    </Badge>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Alerts Summary */}
        <Card>
          <CardHeader>
            <CardTitle>Security & Alert Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="text-center p-4 border border-gray-200 rounded-lg">
                <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-3">
                  <span className="text-2xl font-bold text-red-600">{metrics.criticalAlerts}</span>
                </div>
                <h3 className="font-medium text-gray-900">Critical Alerts</h3>
                <p className="text-sm text-gray-500">Requiring immediate attention</p>
              </div>
              
              <div className="text-center p-4 border border-gray-200 rounded-lg">
                <div className="w-12 h-12 bg-yellow-100 rounded-full flex items-center justify-center mx-auto mb-3">
                  <span className="text-2xl font-bold text-yellow-600">{metrics.warningAlerts}</span>
                </div>
                <h3 className="font-medium text-gray-900">Warning Alerts</h3>
                <p className="text-sm text-gray-500">Monitoring for escalation</p>
              </div>
              
              <div className="text-center p-4 border border-gray-200 rounded-lg">
                <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
                  <span className="text-2xl font-bold text-green-600">{metrics.uptime}</span>
                </div>
                <h3 className="font-medium text-gray-900">System Health</h3>
                <p className="text-sm text-gray-500">Overall system performance</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* South Florida Service Area Report */}
        <Card className="bg-gradient-to-r from-primary to-red-600 text-white">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xl font-bold mb-2">South Florida Service Coverage</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                  <div>
                    <p className="font-semibold">Broward County</p>
                    <p className="text-red-100">Fort Lauderdale, Davie, Weston</p>
                  </div>
                  <div>
                    <p className="font-semibold">Dade County</p>
                    <p className="text-red-100">Miami, Aventura, Doral</p>
                  </div>
                  <div>
                    <p className="font-semibold">Palm Beach County</p>
                    <p className="text-red-100">Boca Raton, Delray Beach</p>
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold">27+</div>
                <div className="text-red-100">Years Serving</div>
                <div className="text-red-100">Since 1996</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
