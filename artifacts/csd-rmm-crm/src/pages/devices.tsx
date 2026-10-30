import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Filter, RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import { type Device } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import DeviceForm from "@/components/forms/device-form";
import RemoteSessionLauncher from "@/components/remote/remote-session-launcher";
import ComplianceNotice from "@/components/compliance-notice";

export default function Devices() {
  const [showDeviceForm, setShowDeviceForm] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<Device | undefined>();
  const [isEdit, setIsEdit] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { toast } = useToast();

  const { data: devices = [], isLoading } = useQuery<Device[]>({
    queryKey: ["/api/devices"],
  });

  type MeshStatus = {
    status: "connected" | "unreachable" | "authentication_failed" | "not_configured" | "error";
    isConfigured: boolean;
    url: string | null;
    message?: string;
  };
  const { data: meshStatus } = useQuery<MeshStatus>({
    queryKey: ["/api/meshcentral/status"],
    refetchInterval: 30000,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/meshcentral/sync");
      return res.json() as Promise<{ synced: number }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/devices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/meshcentral/status"] });
      toast({
        title: "Sync complete",
        description: `${data.synced} machine${data.synced === 1 ? "" : "s"} synced from MeshCentral.`,
      });
    },
    onError: (error: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/meshcentral/status"] });
      let description =
        "Couldn't sync from MeshCentral. Make sure the server is connected (URL + login) and reachable.";
      const raw = typeof error?.message === "string" ? error.message : "";
      const jsonStart = raw.indexOf("{");
      if (jsonStart >= 0) {
        try {
          const parsed = JSON.parse(raw.slice(jsonStart));
          if (parsed?.error) description = parsed.error;
        } catch {
          /* keep default */
        }
      }
      toast({ title: "Sync failed", description, variant: "destructive" });
    },
  });

  const filteredDevices = devices.filter((device: Device) => {
    const matchesSearch = device.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         (device.ipAddress && device.ipAddress.toLowerCase().includes(searchTerm.toLowerCase()));
    const matchesStatus = statusFilter === "all" || device.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleEdit = (device: Device) => {
    setSelectedDevice(device);
    setIsEdit(true);
    setShowDeviceForm(true);
  };

  const handleAdd = () => {
    setSelectedDevice(undefined);
    setIsEdit(false);
    setShowDeviceForm(true);
  };

  const closeForm = () => {
    setShowDeviceForm(false);
    setSelectedDevice(undefined);
    setIsEdit(false);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "online":
        return "bg-green-100 text-green-800";
      case "offline":
        return "bg-red-100 text-red-800";
      case "warning":
        return "bg-yellow-100 text-yellow-800";
      case "error":
        return "bg-red-100 text-red-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "server":
        return "🖥️";
      case "workstation":
        return "💻";
      case "laptop":
        return "📱";
      case "network":
        return "🌐";
      default:
        return "📟";
    }
  };

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

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 md:px-6 py-4">
        <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center space-y-4 lg:space-y-0">
          <div>
            <h2 className="text-xl md:text-2xl font-bold text-gray-900">Device Management</h2>
            <p className="text-sm md:text-base text-gray-600">Monitor and manage all network devices</p>
          </div>
          <div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3">
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center space-y-2 sm:space-y-0 sm:space-x-2">
              <Input 
                placeholder="Search devices..." 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full sm:w-48 lg:w-64"
              />
              <select 
                value={statusFilter} 
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-md text-sm w-full sm:w-auto"
              >
                <option value="all">All Status</option>
                <option value="online">Online</option>
                <option value="offline">Offline</option>
                <option value="warning">Warning</option>
                <option value="error">Error</option>
              </select>
            </div>
            <Button
              variant="outline"
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${syncMutation.isPending ? "animate-spin" : ""}`} />
              {syncMutation.isPending ? "Syncing..." : "Sync from MeshCentral"}
            </Button>
            <Button 
              className="bg-primary text-white hover:bg-primary"
              onClick={handleAdd}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Device
            </Button>
          </div>
        </div>
      </div>

      <div className="p-4 md:p-6 space-y-4">
        <ComplianceNotice title="Authorized Devices Only">
          Monitoring and remote actions are available only for authorized customer devices covered
          by a service agreement, ticket approval, or written consent.
        </ComplianceNotice>
        {meshStatus && meshStatus.isConfigured && meshStatus.status !== "connected" && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-red-600 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="font-semibold text-red-800">
                {meshStatus.status === "unreachable"
                  ? "MeshCentral server is down"
                  : meshStatus.status === "authentication_failed"
                  ? "MeshCentral login failed"
                  : "MeshCentral not connected"}
              </div>
              <p className="text-sm text-red-700 mt-0.5">
                {meshStatus.message ||
                  "The app can't reach your MeshCentral server, so devices can't be synced."}
              </p>
              {meshStatus.url && (
                <p className="text-xs text-red-600/80 mt-1 break-all">Server: {meshStatus.url}</p>
              )}
            </div>
          </div>
        )}
        {meshStatus && meshStatus.isConfigured && meshStatus.status === "connected" && (
          <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
            <span className="text-sm text-green-800">
              Connected to MeshCentral{meshStatus.url ? ` (${meshStatus.url})` : ""}.
            </span>
          </div>
        )}
        <Card>
          <CardHeader>
            <CardTitle>All Devices ({filteredDevices.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto -mx-4 md:mx-0">
              <table className="w-full min-w-[800px]">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-4">Device</th>
                    <th className="text-left p-4">Type</th>
                    <th className="text-left p-4">Status</th>
                    <th className="text-left p-4">IP Address</th>
                    <th className="text-left p-4">OS</th>
                    <th className="text-left p-4">CPU</th>
                    <th className="text-left p-4">Memory</th>
                    <th className="text-left p-4">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDevices.map((device: Device) => (
                    <tr key={device.id} className="border-b hover:bg-gray-50">
                      <td className="p-4">
                        <div className="flex items-center space-x-3">
                          <span className="text-2xl">{getTypeIcon(device.type)}</span>
                          <div>
                            <div className="font-medium">{device.name}</div>
                            <div className="text-sm text-gray-500">{device.macAddress}</div>
                          </div>
                        </div>
                      </td>
                      <td className="p-4 capitalize">{device.type}</td>
                      <td className="p-4">
                        <Badge className={getStatusColor(device.status)}>
                          {device.status}
                        </Badge>
                      </td>
                      <td className="p-4">{device.ipAddress || "N/A"}</td>
                      <td className="p-4">{device.operatingSystem || "N/A"}</td>
                      <td className="p-4">{device.cpuUsage ? `${device.cpuUsage}%` : "N/A"}</td>
                      <td className="p-4">{device.memoryUsage ? `${device.memoryUsage}%` : "N/A"}</td>
                      <td className="p-4">
                        <div className="flex items-center space-x-2">
                          <RemoteSessionLauncher
                            device={device}
                            sourceType="device"
                            sourceId={device.id}
                            size="sm"
                          />
                          <Button variant="ghost" size="sm" onClick={() => handleEdit(device)} className="text-primary">
                            Edit
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <DeviceForm
          open={showDeviceForm}
          onClose={closeForm}
          device={selectedDevice}
          isEdit={isEdit}
        />
      </div>
    </div>
  );
}