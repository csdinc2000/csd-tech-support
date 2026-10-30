import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Download, LayoutDashboard, Rocket, Wrench, Wallet } from "lucide-react";
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
  openTickets: number;
  uptime: number;
  onlineDevices: number;
}

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

export default function Dashboard() {
  const { data: metrics, isLoading: metricsLoading } = useQuery<DashboardMetrics>({
    queryKey: ["/api/dashboard/metrics"],
  });

  const { data: devices = [], isLoading: devicesLoading } = useQuery<Device[]>({
    queryKey: ["/api/devices"],
  });

  const { data: alerts = [], isLoading: alertsLoading } = useQuery<Alert[]>({
    queryKey: ["/api/alerts/active"],
  });

  const { data: tickets = [], isLoading: ticketsLoading } = useQuery<Ticket[]>({
    queryKey: ["/api/tickets/open"],
  });

  const isLoading = metricsLoading || devicesLoading || alertsLoading || ticketsLoading;

  if (isLoading) return <DashboardSkeleton />;

  return (
    <PageShell>
      <PageHeader
        icon={LayoutDashboard}
        eyebrow="Overview"
        title="RMM Dashboard"
        description="Real-time monitoring and management for South Florida businesses."
        actions={
          <>
            <Button variant="outline" className="w-full sm:w-auto text-sm">
              <Download className="mr-2 h-4 w-4" />
              Export Report
            </Button>
            <Button className="w-full sm:w-auto bg-csd-red text-sm hover:bg-red-700">
              <Plus className="mr-2 h-4 w-4" />
              Add Device
            </Button>
          </>
        }
      />

      <PageContent>
        {metrics && <MetricsCards metrics={metrics} />}

        <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-2">
          <AlertsPanel alerts={alerts} />
          <DeviceStatus devices={devices} />
        </div>

        <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
          <QuickActions />
          <RecentTickets tickets={tickets} />
        </div>

        <SystemStatus />

        <div className="grid grid-cols-1 gap-4 md:gap-6 lg:grid-cols-3">
          <Card className="border-csd-red/15 bg-gradient-to-br from-white to-red-50/30">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base text-csd-red">
                <Rocket className="h-4 w-4" />
                Fast Response
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-700">
                Our technicians respond to emergencies in as little as 20 minutes.
              </p>
              <div className="mt-2 text-xs text-gray-500">Available 24/7 for critical issues</div>
            </CardContent>
          </Card>

          <Card className="border-csd-red/15 bg-gradient-to-br from-white to-red-50/30">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base text-csd-red">
                <Wrench className="h-4 w-4" />
                Reliable Solutions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-700">
                27+ years of experience serving South Florida businesses.
              </p>
              <div className="mt-2 text-xs text-gray-500">
                Trusted by Broward, Dade &amp; Palm Beach Counties
              </div>
            </CardContent>
          </Card>

          <Card className="border-csd-red/15 bg-gradient-to-br from-white to-red-50/30">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base text-csd-red">
                <Wallet className="h-4 w-4" />
                Affordable Pricing
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-700">
                Competitive rates with transparent pricing structure.
              </p>
              <div className="mt-2 text-xs text-gray-500">No hidden fees or surprise charges</div>
            </CardContent>
          </Card>
        </div>
      </PageContent>
    </PageShell>
  );
}
