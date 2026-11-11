import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Network, Search, Shield, AlertTriangle, CheckCircle, 
  Server, Laptop, Smartphone, Router, Printer, Camera,
  Scan, Play, Pause, RefreshCw, Download, Settings, Trash2
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface NetworkDevice {
  id: string;
  ipAddress: string;
  macAddress: string;
  hostname: string;
  deviceType: string;
  vendor: string;
  operatingSystem?: string;
  openPorts: number[];
  lastSeen: string;
  status: 'online' | 'offline';
  vulnerabilities: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

interface NetworkScan {
  id: string;
  networkRange: string;
  startTime: string;
  endTime?: string;
  status: 'running' | 'completed' | 'failed';
  progress: number;
  devicesFound: number;
  vulnerabilitiesFound: number;
}

export default function NetworkDiscovery() {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedRange, setSelectedRange] = useState("192.168.1.0/24");
  const [filterType, setFilterType] = useState("all");
  const [filterRisk, setFilterRisk] = useState("all");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: networkDevices = [], isLoading: devicesLoading } = useQuery({
    queryKey: ["/api/network/devices"],
    refetchInterval: 30000, // Auto-refresh every 30 seconds
  });

  const { data: activeScans = [] } = useQuery<NetworkScan[]>({
    queryKey: ["/api/network/scans/active"],
    refetchInterval: 5000, // Fast refresh for active scans
  });

  const { data: scanHistory = [] } = useQuery<NetworkScan[]>({
    queryKey: ["/api/network/scans/history"],
  });

  const startScanMutation = useMutation({
    mutationFn: (networkRange: string) => 
      apiRequest("POST", "/api/network/scans", { networkRange }),
    onSuccess: () => {
      toast({ title: "Network scan started successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/network/scans/active"] });
    },
    onError: () => {
      toast({ title: "Failed to start network scan", variant: "destructive" });
    },
  });

  const exportDevicesMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/network/export", {}),
    onSuccess: () => {
      toast({ title: "Device list exported successfully" });
    },
  });

  const deleteScanMutation = useMutation({
    mutationFn: (id: string | number) => apiRequest("DELETE", `/api/network-scans/${id}`),
    onSuccess: () => {
      toast({ title: "Scan deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/network/scans/history"] });
    },
    onError: () => {
      toast({ title: "Failed to delete scan", variant: "destructive" });
    },
  });

  const filteredDevices = (networkDevices as NetworkDevice[]).filter((device) => {
    const matchesSearch = device.hostname.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         device.ipAddress.includes(searchTerm) ||
                         device.macAddress.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = filterType === "all" || device.deviceType === filterType;
    const matchesRisk = filterRisk === "all" || device.riskLevel === filterRisk;
    return matchesSearch && matchesType && matchesRisk;
  });

  const getDeviceIcon = (deviceType: string) => {
    switch (deviceType) {
      case 'server': return <Server className="h-6 w-6" />;
      case 'workstation': return <Laptop className="h-6 w-6" />;
      case 'mobile': return <Smartphone className="h-6 w-6" />;
      case 'router': return <Router className="h-6 w-6" />;
      case 'printer': return <Printer className="h-6 w-6" />;
      case 'camera': return <Camera className="h-6 w-6" />;
      default: return <Network className="h-6 w-6" />;
    }
  };

  const getRiskColor = (risk: string) => {
    switch (risk) {
      case 'critical': return 'bg-red-100 text-red-800 border-red-200';
      case 'high': return 'bg-orange-100 text-orange-800 border-orange-200';
      case 'medium': return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'low': return 'bg-green-100 text-green-800 border-green-200';
      default: return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const getStatusColor = (status: string) => {
    return status === 'online' ? 'text-green-600' : 'text-red-600';
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Network Discovery</h1>
          <p className="text-gray-600">Comprehensive network scanning and device discovery</p>
        </div>
        <div className="flex space-x-3">
          <Button 
            variant="outline"
            onClick={() => exportDevicesMutation.mutate()}
            disabled={exportDevicesMutation.isPending}
          >
            <Download className="h-4 w-4 mr-2" />
            Export Devices
          </Button>
          <Button 
            onClick={() => startScanMutation.mutate(selectedRange)}
            disabled={startScanMutation.isPending || activeScans.length > 0}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            <Scan className="h-4 w-4 mr-2" />
            Start Network Scan
          </Button>
        </div>
      </div>

      {/* Active Scans */}
      {activeScans.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <RefreshCw className="h-5 w-5 mr-2 animate-spin" />
              Active Network Scans
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {activeScans.map((scan: NetworkScan) => (
                <div key={scan.id} className="p-4 border rounded-lg">
                  <div className="flex justify-between items-center mb-2">
                    <div>
                      <p className="font-medium">{scan.networkRange}</p>
                      <p className="text-sm text-gray-600">Started: {new Date(scan.startTime).toLocaleString()}</p>
                    </div>
                    <Badge variant="outline" className="bg-blue-50">
                      {scan.status}
                    </Badge>
                  </div>
                  <Progress value={scan.progress} className="mb-2" />
                  <div className="flex justify-between text-sm text-gray-600">
                    <span>Devices Found: {scan.devicesFound}</span>
                    <span>Vulnerabilities: {scan.vulnerabilitiesFound}</span>
                    <span>Progress: {scan.progress}%</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Network Range Input */}
      <Card>
        <CardHeader>
          <CardTitle>Network Configuration</CardTitle>
          <CardDescription>Configure network range for scanning</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex space-x-4">
            <div className="flex-1">
              <Input
                placeholder="Network range (e.g., 192.168.1.0/24)"
                value={selectedRange}
                onChange={(e) => setSelectedRange(e.target.value)}
              />
            </div>
            <Button variant="outline">
              <Settings className="h-4 w-4 mr-2" />
              Advanced Settings
            </Button>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="devices" className="w-full">
        <TabsList>
          <TabsTrigger value="devices">Discovered Devices</TabsTrigger>
          <TabsTrigger value="vulnerabilities">Security Scan</TabsTrigger>
          <TabsTrigger value="history">Scan History</TabsTrigger>
        </TabsList>

        <TabsContent value="devices" className="space-y-6">
          {/* Filters and Search */}
          <Card>
            <CardContent className="p-6">
              <div className="flex flex-col md:flex-row space-y-4 md:space-y-0 md:space-x-4">
                <div className="flex-1">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
                    <Input 
                      placeholder="Search devices by hostname, IP, or MAC..." 
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="pl-10"
                    />
                  </div>
                </div>
                <select 
                  value={filterType} 
                  onChange={(e) => setFilterType(e.target.value)}
                  className="px-3 py-2 border rounded-md"
                >
                  <option value="all">All Device Types</option>
                  <option value="server">Servers</option>
                  <option value="workstation">Workstations</option>
                  <option value="mobile">Mobile Devices</option>
                  <option value="router">Network Equipment</option>
                  <option value="printer">Printers</option>
                  <option value="camera">Security Cameras</option>
                </select>
                <select 
                  value={filterRisk} 
                  onChange={(e) => setFilterRisk(e.target.value)}
                  className="px-3 py-2 border rounded-md"
                >
                  <option value="all">All Risk Levels</option>
                  <option value="critical">Critical Risk</option>
                  <option value="high">High Risk</option>
                  <option value="medium">Medium Risk</option>
                  <option value="low">Low Risk</option>
                </select>
              </div>
            </CardContent>
          </Card>

          {/* Statistics Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <Card>
              <CardContent className="p-6">
                <div className="flex items-center space-x-2">
                  <Network className="h-8 w-8 text-blue-500" />
                  <div>
                    <p className="text-2xl font-bold text-blue-600">
                      {filteredDevices.length}
                    </p>
                    <p className="text-sm text-gray-600">Total Devices</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6">
                <div className="flex items-center space-x-2">
                  <CheckCircle className="h-8 w-8 text-green-500" />
                  <div>
                    <p className="text-2xl font-bold text-green-600">
                      {filteredDevices.filter(d => d.status === 'online').length}
                    </p>
                    <p className="text-sm text-gray-600">Online</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6">
                <div className="flex items-center space-x-2">
                  <Shield className="h-8 w-8 text-orange-500" />
                  <div>
                    <p className="text-2xl font-bold text-orange-600">
                      {filteredDevices.filter(d => d.riskLevel === 'high' || d.riskLevel === 'critical').length}
                    </p>
                    <p className="text-sm text-gray-600">High Risk</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6">
                <div className="flex items-center space-x-2">
                  <AlertTriangle className="h-8 w-8 text-red-500" />
                  <div>
                    <p className="text-2xl font-bold text-red-600">
                      {filteredDevices.reduce((total, device) => total + device.vulnerabilities, 0)}
                    </p>
                    <p className="text-sm text-gray-600">Vulnerabilities</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Device List */}
          <Card>
            <CardHeader>
              <CardTitle>Discovered Network Devices</CardTitle>
              <CardDescription>
                Showing {filteredDevices.length} devices found on the network
              </CardDescription>
            </CardHeader>
            <CardContent>
              {devicesLoading ? (
                <div className="space-y-4">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="animate-pulse">
                      <div className="h-16 bg-gray-200 rounded"></div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-4">
                  {filteredDevices.map((device) => (
                    <div key={device.id} className="flex items-center justify-between p-4 border rounded-lg hover:bg-gray-50">
                      <div className="flex items-center space-x-4">
                        <div className="text-gray-600">
                          {getDeviceIcon(device.deviceType)}
                        </div>
                        <div>
                          <div className="flex items-center space-x-2">
                            <h3 className="font-medium">{device.hostname || 'Unknown Host'}</h3>
                            <Badge variant="outline" className={getRiskColor(device.riskLevel)}>
                              {device.riskLevel}
                            </Badge>
                          </div>
                          <div className="flex items-center space-x-4 text-sm text-gray-600">
                            <span>{device.ipAddress}</span>
                            <span>{device.macAddress}</span>
                            <span>{device.vendor}</span>
                            {device.operatingSystem && <span>{device.operatingSystem}</span>}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center space-x-4">
                        <div className="text-right">
                          <div className={`font-medium ${getStatusColor(device.status)}`}>
                            {device.status.toUpperCase()}
                          </div>
                          <div className="text-sm text-gray-600">
                            Last seen: {new Date(device.lastSeen).toLocaleDateString()}
                          </div>
                        </div>
                        {device.vulnerabilities > 0 && (
                          <Badge variant="destructive">
                            {device.vulnerabilities} vulnerabilities
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="vulnerabilities" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <Shield className="h-5 w-5 mr-2" />
                Security Vulnerability Assessment
              </CardTitle>
              <CardDescription>
                Automated security scanning results for discovered devices
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Card className="border-red-200 bg-red-50">
                    <CardContent className="p-4">
                      <div className="flex items-center space-x-2">
                        <AlertTriangle className="h-6 w-6 text-red-500" />
                        <div>
                          <p className="font-medium text-red-800">Critical Vulnerabilities</p>
                          <p className="text-2xl font-bold text-red-600">
                            {filteredDevices.filter(d => d.riskLevel === 'critical').length}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  
                  <Card className="border-orange-200 bg-orange-50">
                    <CardContent className="p-4">
                      <div className="flex items-center space-x-2">
                        <Shield className="h-6 w-6 text-orange-500" />
                        <div>
                          <p className="font-medium text-orange-800">High Risk Devices</p>
                          <p className="text-2xl font-bold text-orange-600">
                            {filteredDevices.filter(d => d.riskLevel === 'high').length}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  
                  <Card className="border-green-200 bg-green-50">
                    <CardContent className="p-4">
                      <div className="flex items-center space-x-2">
                        <CheckCircle className="h-6 w-6 text-green-500" />
                        <div>
                          <p className="font-medium text-green-800">Secure Devices</p>
                          <p className="text-2xl font-bold text-green-600">
                            {filteredDevices.filter(d => d.riskLevel === 'low').length}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <div className="mt-6">
                  <h3 className="text-lg font-medium mb-4">Vulnerability Details</h3>
                  <div className="space-y-3">
                    {filteredDevices
                      .filter(device => device.vulnerabilities > 0)
                      .map(device => (
                        <div key={device.id} className="p-4 border rounded-lg">
                          <div className="flex justify-between items-start">
                            <div>
                              <h4 className="font-medium">{device.hostname} ({device.ipAddress})</h4>
                              <p className="text-sm text-gray-600">{device.deviceType} - {device.vendor}</p>
                              <div className="mt-2">
                                <Badge className={getRiskColor(device.riskLevel)}>
                                  {device.riskLevel} risk
                                </Badge>
                              </div>
                            </div>
                            <div className="text-right">
                              <p className="text-lg font-bold text-red-600">{device.vulnerabilities}</p>
                              <p className="text-sm text-gray-600">vulnerabilities</p>
                            </div>
                          </div>
                          {device.openPorts.length > 0 && (
                            <div className="mt-3">
                              <p className="text-sm font-medium">Open Ports:</p>
                              <div className="flex flex-wrap gap-1 mt-1">
                                {device.openPorts.slice(0, 10).map(port => (
                                  <Badge key={port} variant="outline" className="text-xs">
                                    {port}
                                  </Badge>
                                ))}
                                {device.openPorts.length > 10 && (
                                  <Badge variant="outline" className="text-xs">
                                    +{device.openPorts.length - 10} more
                                  </Badge>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Scan History</CardTitle>
              <CardDescription>Previous network discovery scans and results</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {scanHistory.length === 0 ? (
                  <p className="text-center text-gray-500 py-8">No scan history available</p>
                ) : (
                  scanHistory.map((scan: NetworkScan) => (
                    <div key={scan.id} className="p-4 border rounded-lg">
                      <div className="flex justify-between items-center">
                        <div>
                          <h3 className="font-medium">{scan.networkRange}</h3>
                          <p className="text-sm text-gray-600">
                            {new Date(scan.startTime).toLocaleString()} - {scan.endTime ? new Date(scan.endTime).toLocaleString() : 'Running'}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right">
                            <Badge variant={scan.status === 'completed' ? 'default' : scan.status === 'failed' ? 'destructive' : 'secondary'}>
                              {scan.status}
                            </Badge>
                            <div className="text-sm text-gray-600 mt-1">
                              {scan.devicesFound} devices, {scan.vulnerabilitiesFound} vulnerabilities
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => {
                              if (window.confirm("Delete this scan from history? This cannot be undone.")) {
                                deleteScanMutation.mutate(scan.id);
                              }
                            }}
                            disabled={deleteScanMutation.isPending}
                            aria-label="Delete scan"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}