import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Activity, Cpu, HardDrive, Wifi, Server, AlertTriangle, CheckCircle } from "lucide-react";
import type { Device } from "@shared/schema";

interface MonitoringAlert {
  id?: number;
  type?: 'performance' | 'security' | 'network' | 'hardware';
  message?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  title?: string;
}

interface MonitoringData {
  deviceId: number;
  deviceName: string;
  status: 'online' | 'offline' | 'warning' | 'critical';
  cpuUsage: number | null;
  memoryUsage: number | null;
  diskUsage: number | null;
  networkLatency: number | null;
  lastSeen: Date | string | null;
  alerts: MonitoringAlert[];
}

export default function RealTimeMonitoring() {
  const [selectedDevice, setSelectedDevice] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const { data: devices = [], isLoading } = useQuery<Device[]>({
    queryKey: ["/api/devices"],
    refetchInterval: autoRefresh ? 5000 : false, // Refresh every 5 seconds
  });

  const { data: monitoringData = [] } = useQuery<MonitoringData[]>({
    queryKey: ["/api/monitoring/realtime"],
    refetchInterval: autoRefresh ? 2000 : false, // Refresh every 2 seconds
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online': return 'bg-green-500';
      case 'warning': return 'bg-yellow-500';
      case 'critical': return 'bg-red-500';
      case 'offline': return 'bg-gray-500';
      default: return 'bg-gray-500';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'online': return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'warning': return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      case 'critical': return <AlertTriangle className="h-4 w-4 text-red-500" />;
      case 'offline': return <Server className="h-4 w-4 text-gray-500" />;
      default: return <Server className="h-4 w-4 text-gray-500" />;
    }
  };

  const formatLatency = (latency: number | null) => {
    if (latency == null) return { value: "—", color: 'text-gray-500', status: 'No data' };
    if (latency < 50) return { value: `${latency}ms`, color: 'text-green-600', status: 'Excellent' };
    if (latency < 100) return { value: `${latency}ms`, color: 'text-yellow-600', status: 'Good' };
    if (latency < 200) return { value: `${latency}ms`, color: 'text-orange-600', status: 'Fair' };
    return { value: `${latency}ms`, color: 'text-red-600', status: 'Poor' };
  };

  const fmtPct = (n: number | null) => (n == null ? "—" : `${n}%`);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-4"></div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-48 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Real-Time Monitoring Header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Real-Time Device Monitoring</h2>
          <p className="text-gray-600">Live performance metrics and health status</p>
        </div>
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2">
            <Activity className={`h-4 w-4 ${autoRefresh ? 'text-green-500' : 'text-gray-400'}`} />
            <span className="text-sm">
              {autoRefresh ? 'Live Updates' : 'Paused'}
            </span>
          </div>
          <Button 
            variant={autoRefresh ? "destructive" : "default"}
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            {autoRefresh ? 'Pause' : 'Resume'} Monitoring
          </Button>
        </div>
      </div>

      {/* Device Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {devices.map((device: Device) => {
          const monitoring: Pick<MonitoringData, "cpuUsage" | "memoryUsage" | "diskUsage" | "networkLatency" | "alerts"> =
            monitoringData.find((m) => m.deviceId === device.id) ?? {
              cpuUsage: device.cpuUsage ?? null,
              memoryUsage: device.memoryUsage ?? null,
              diskUsage: device.diskUsage ?? null,
              networkLatency: device.networkLatency ?? null,
              alerts: [],
            };

          const latencyInfo = formatLatency(monitoring.networkLatency);

          return (
            <Card 
              key={device.id} 
              className={`border-l-4 ${getStatusColor(device.status)} hover:shadow-lg transition-shadow cursor-pointer`}
              onClick={() => setSelectedDevice(selectedDevice === device.id ? null : device.id)}
            >
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    {getStatusIcon(device.status)}
                    <CardTitle className="text-lg">{device.name}</CardTitle>
                  </div>
                  <Badge variant="secondary" className="capitalize">
                    {device.type}
                  </Badge>
                </div>
                <p className="text-sm text-gray-600">{device.ipAddress}</p>
              </CardHeader>
              
              <CardContent className="space-y-4">
                {/* Performance Metrics */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <Cpu className="h-4 w-4 text-blue-500" />
                      <span className="text-sm font-medium">CPU</span>
                    </div>
                    <span className="text-sm text-gray-600">{fmtPct(monitoring.cpuUsage)}</span>
                  </div>
                  <Progress value={monitoring.cpuUsage ?? 0} className="h-2" />

                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <Activity className="h-4 w-4 text-green-500" />
                      <span className="text-sm font-medium">Memory</span>
                    </div>
                    <span className="text-sm text-gray-600">{fmtPct(monitoring.memoryUsage)}</span>
                  </div>
                  <Progress value={monitoring.memoryUsage ?? 0} className="h-2" />

                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <HardDrive className="h-4 w-4 text-purple-500" />
                      <span className="text-sm font-medium">Disk</span>
                    </div>
                    <span className="text-sm text-gray-600">{fmtPct(monitoring.diskUsage)}</span>
                  </div>
                  <Progress value={monitoring.diskUsage ?? 0} className="h-2" />

                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <Wifi className="h-4 w-4 text-orange-500" />
                      <span className="text-sm font-medium">Network</span>
                    </div>
                    <span className={`text-sm ${latencyInfo.color}`}>
                      {latencyInfo.value}
                    </span>
                  </div>
                </div>

                {/* Alerts Section */}
                {monitoring.alerts && monitoring.alerts.length > 0 && (
                  <div className="pt-3 border-t">
                    <div className="flex items-center space-x-2 mb-2">
                      <AlertTriangle className="h-4 w-4 text-red-500" />
                      <span className="text-sm font-medium text-red-600">
                        {monitoring.alerts.length} Active Alert{monitoring.alerts.length > 1 ? 's' : ''}
                      </span>
                    </div>
                    {selectedDevice === device.id && (
                      <div className="space-y-1">
                        {monitoring.alerts.slice(0, 3).map((alert: MonitoringAlert, index: number) => (
                          <div key={index} className="text-xs text-gray-600 bg-gray-50 p-2 rounded">
                            <Badge variant="outline" className="text-xs mr-2">
                              {alert.severity ?? "info"}
                            </Badge>
                            {alert.message ?? alert.title ?? ""}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Last Update */}
                <div className="pt-2 border-t">
                  <p className="text-xs text-gray-500">
                    Last updated: {new Date().toLocaleTimeString()}
                  </p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Quick Actions Panel */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Button variant="outline" disabled className="flex items-center space-x-2">
              <Activity className="h-4 w-4" />
              <span>Run Health Check</span>
            </Button>
            <Button variant="outline" disabled className="flex items-center space-x-2">
              <Server className="h-4 w-4" />
              <span>Restart Services</span>
            </Button>
            <Button variant="outline" disabled className="flex items-center space-x-2">
              <HardDrive className="h-4 w-4" />
              <span>Clear Disk Space</span>
            </Button>
            <Button variant="outline" disabled className="flex items-center space-x-2">
              <Wifi className="h-4 w-4" />
              <span>Test Connectivity</span>
            </Button>
          </div>
          <p className="text-xs text-gray-500">
            This module is prepared for secure implementation. Connect backend services,
            technician confirmation, and audit logging before production use — these actions will
            require confirmation and will be logged with user, timestamp, device, client, and
            result.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}