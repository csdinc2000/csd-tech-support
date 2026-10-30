import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, LayoutDashboard, RefreshCw, AlertCircle } from "lucide-react";
import { useLocation } from "wouter";
import MetricsCards from "@/components/dashboard/metrics-cards";
import AlertsPanel from "@/components/dashboard/alerts-panel";
import DeviceStatus from "@/components/dashboard/device-status";
import QuickActions from "@/components/dashboard/quick-actions";
import RecentTickets from "@/components/dashboard/recent-tickets";
import SystemStatus from "@/components/dashboard/emergency-support";
import { PageHeader } from "@/components/layout/page-header";
import { PageShell, PageContent } from "@/components/layout/page-shell";
import type { Device, Alert, Ticket } from "@shared/schema";

interface DashboardMetrics {
  totalDevices: number;
  activeAlerts: number;
  criticalAlerts: number;
  attentionAlerts: number;
  openTickets: number;
  unassignedTickets: number;
  overdueTickets: number;
  onlineRate: number;
  onlineDevices: number;
  lastUpdatedAt: string;
}

const LIVE_QUERY_OPTIONS = {
  refetchInterval: 15_000,
  refetchOnWindowFocus: true,
  staleTime: 10_000,
} as const;

function DashboardSkeleton() {
  return (
    <PageShell>
      <div className="border-b border-gray-200 bg-white px-4 py-5 md:px-6">
        <div className="h-6 w-48 animate-pulse rounded bg-gray-200" />
        <div className="mt-2 h-4 w-72 animate-pulse rounded bg-gray-100" />
      </div>
      <PageContent>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-lg bg-white shadow-sm" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="h-72 animate-pulse rounded-lg bg-white shadow-sm" />
          <div className="h-72 animate-pulse rounded-lg bg-white shadow-sm" />
        </div>
      </PageContent>
    </PageShell>
  );
}

export default function RmmDashboard() {
  const [, navigate] = useLocation();
  const metricsQuery = useQuery<DashboardMetrics>({
    queryKey: ["/api/dashboard/metrics"],
    ...LIVE_QUERY_OPTIONS,
  });

  const devicesQuery = useQuery<Device[]>({
    queryKey: ["/api/devices"],
    ...LIVE_QUERY_OPTIONS,
  });

  const alertsQuery = useQuery<Alert[]>({
    queryKey: ["/api/alerts/active"],
    ...LIVE_QUERY_OPTIONS,
  });

  const ticketsQuery = useQuery<Ticket[]>({
    queryKey: ["/api/tickets/open"],
    ...LIVE_QUERY_OPTIONS,
  });

  const metrics = metricsQuery.data;
  const devices = (devicesQuery.data ?? []).filter(
    (device) => Boolean(device.meshNodeId?.trim() || device.teamviewerId?.trim()),
  );
  const alerts = alertsQuery.data ?? [];
  const tickets = ticketsQuery.data ?? [];
  const queries = [metricsQuery, devicesQuery, alertsQuery, ticketsQuery];
  const isLoading = queries.some((query) => query.isLoading);
  const isFetching = queries.some((query) => query.isFetching);
  const error = queries.find((query) => query.error)?.error as Error | undefined;

  const refreshDashboard = () => {
    void Promise.all(queries.map((query) => query.refetch()));
  };

  if (isLoading) return <DashboardSkeleton />;

  return (
    <PageShell>
      <PageHeader
        icon={LayoutDashboard}
        eyebrow="Monitoring"
        title="RMM Overview"
        description="Real-time monitoring and management for South Florida businesses."
        actions={
          <>
            <Button
              variant="outline"
              className="w-full sm:w-auto text-sm"
              onClick={refreshDashboard}
              disabled={isFetching}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
              {isFetching ? "Refreshing" : "Refresh now"}
            </Button>
            <Button
              className="w-full sm:w-auto bg-csd-red text-sm hover:bg-red-700"
              onClick={() => navigate("/devices")}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Device
            </Button>
          </>
        }
      />

      <PageContent>
        <div className="flex items-center justify-between gap-3 text-xs text-gray-500">
          <span>Live data refreshes every 15 seconds</span>
          {metrics?.lastUpdatedAt && (
            <span>Updated {new Date(metrics.lastUpdatedAt).toLocaleTimeString()}</span>
          )}
        </div>

        {error && (
          <Card className="border-red-200 bg-red-50">
            <CardContent className="flex items-center justify-between gap-4 p-4">
              <div className="flex items-center gap-2 text-sm text-red-800">
                <AlertCircle className="h-4 w-4 shrink-0" />
                Live dashboard data could not be refreshed: {error.message}
              </div>
              <Button size="sm" variant="outline" onClick={refreshDashboard}>
                Retry
              </Button>
            </CardContent>
          </Card>
        )}

        {metrics && <MetricsCards metrics={metrics} />}

        <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-2">
          <AlertsPanel alerts={alerts} />
          <DeviceStatus devices={devices} />
        </div>

        <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
          <QuickActions />
          <RecentTickets tickets={tickets} />
        </div>

        <SystemStatus
          devices={devices}
          alerts={alerts}
          lastUpdatedAt={metrics?.lastUpdatedAt}
        />
      </PageContent>
    </PageShell>
  );
}
