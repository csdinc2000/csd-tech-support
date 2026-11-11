import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { 
  Shield, Download, Play, Pause, AlertTriangle, CheckCircle, 
  Clock, Settings, Search, Filter, RefreshCw 
} from "lucide-react";

interface PatchItem {
  id: string;
  title: string;
  description: string;
  severity: 'critical' | 'important' | 'moderate' | 'low';
  category: 'security' | 'feature' | 'driver' | 'definition';
  size: number;
  installTime: number;
  requiresReboot: boolean;
  status: 'available' | 'downloading' | 'installing' | 'installed' | 'failed';
  releaseDate: Date;
  deviceIds: number[];
}

interface PatchPolicy {
  id: number;
  name: string;
  autoInstall: boolean;
  maintenanceWindow: string;
  severityFilter: string[];
  excludePatches: string[];
  testGroupPercentage: number;
}

export default function PatchManagement() {
  const [selectedDevices, setSelectedDevices] = useState<number[]>([]);
  const [selectedPatches, setSelectedPatches] = useState<string[]>([]);
  const [filterSeverity, setFilterSeverity] = useState<string>("all");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [showPolicies, setShowPolicies] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: devices = [] } = useQuery({
    queryKey: ["/api/devices"],
  });

  const { data: patches = [], isLoading: patchesLoading } = useQuery({
    queryKey: ["/api/patches"],
    enabled: true,
  });

  const { data: policies = [] } = useQuery({
    queryKey: ["/api/patch-policies"],
  });

  const installPatchesMutation = useMutation({
    mutationFn: (data: { patchIds: string[], deviceIds: number[], scheduleTime?: string }) => 
      apiRequest("POST", "/api/patches/install", data),
    onSuccess: () => {
      toast({ title: "Patch installation initiated successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/patches"] });
    },
    onError: () => {
      toast({ title: "Failed to start patch installation", variant: "destructive" });
    },
  });

  const downloadPatchesMutation = useMutation({
    mutationFn: (patchIds: string[]) => 
      apiRequest("POST", "/api/patches/download", { patchIds }),
    onSuccess: () => {
      toast({ title: "Patch download started" });
      queryClient.invalidateQueries({ queryKey: ["/api/patches"] });
    },
  });

  const filteredPatches = (patches as PatchItem[]).filter((patch: PatchItem) => {
    const matchesSearch = patch.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         patch.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesSeverity = filterSeverity === "all" || patch.severity === filterSeverity;
    const matchesCategory = filterCategory === "all" || patch.category === filterCategory;
    return matchesSearch && matchesSeverity && matchesCategory;
  });

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical': return 'bg-red-100 text-red-800 border-red-200';
      case 'important': return 'bg-orange-100 text-orange-800 border-orange-200';
      case 'moderate': return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'low': return 'bg-blue-100 text-blue-800 border-blue-200';
      default: return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'available': return <Download className="h-4 w-4 text-blue-500" />;
      case 'downloading': return <RefreshCw className="h-4 w-4 text-blue-500 animate-spin" />;
      case 'installing': return <Play className="h-4 w-4 text-orange-500" />;
      case 'installed': return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'failed': return <AlertTriangle className="h-4 w-4 text-red-500" />;
      default: return <Clock className="h-4 w-4 text-gray-500" />;
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const calculateTotalSize = () => {
    return selectedPatches.reduce((total, patchId) => {
      const patch = (patches as PatchItem[]).find((p: PatchItem) => p.id === patchId);
      return total + (patch?.size || 0);
    }, 0);
  };

  const calculateInstallTime = () => {
    return selectedPatches.reduce((total, patchId) => {
      const patch = (patches as PatchItem[]).find((p: PatchItem) => p.id === patchId);
      return total + (patch?.installTime || 0);
    }, 0);
  };

  if (patchesLoading) {
    return (
      <div className="space-y-4">
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Patch Management</h2>
          <p className="text-gray-600">Automated patching and vulnerability management</p>
        </div>
        <div className="flex space-x-3">
          <Button 
            variant="outline" 
            onClick={() => setShowPolicies(!showPolicies)}
          >
            <Settings className="h-4 w-4 mr-2" />
            Policies
          </Button>
          <Button className="bg-primary text-white hover:bg-primary">
            <Shield className="h-4 w-4 mr-2" />
            Scan for Updates
          </Button>
        </div>
      </div>

      {/* Statistics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center space-x-2">
              <Shield className="h-8 w-8 text-red-500" />
              <div>
                <p className="text-2xl font-bold text-red-600">
                  {(patches as PatchItem[]).filter((p: PatchItem) => p.severity === 'critical').length}
                </p>
                <p className="text-sm text-gray-600">Critical Patches</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center space-x-2">
              <Download className="h-8 w-8 text-blue-500" />
              <div>
                <p className="text-2xl font-bold text-blue-600">
                  {(patches as PatchItem[]).filter((p: PatchItem) => p.status === 'available').length}
                </p>
                <p className="text-sm text-gray-600">Available</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center space-x-2">
              <Play className="h-8 w-8 text-orange-500" />
              <div>
                <p className="text-2xl font-bold text-orange-600">
                  {(patches as PatchItem[]).filter((p: PatchItem) => p.status === 'installing').length}
                </p>
                <p className="text-sm text-gray-600">Installing</p>
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
                  {(patches as PatchItem[]).filter((p: PatchItem) => p.status === 'installed').length}
                </p>
                <p className="text-sm text-gray-600">Installed</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters and Search */}
      <Card>
        <CardContent className="p-6">
          <div className="flex flex-col md:flex-row space-y-4 md:space-y-0 md:space-x-4">
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
                <Input 
                  placeholder="Search patches..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
            <Select value={filterSeverity} onValueChange={setFilterSeverity}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Filter by severity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Severities</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
                <SelectItem value="important">Important</SelectItem>
                <SelectItem value="moderate">Moderate</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filterCategory} onValueChange={setFilterCategory}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Filter by category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                <SelectItem value="security">Security</SelectItem>
                <SelectItem value="feature">Feature</SelectItem>
                <SelectItem value="driver">Driver</SelectItem>
                <SelectItem value="definition">Definition</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Patch List */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle>Available Patches ({filteredPatches.length})</CardTitle>
            <div className="flex space-x-2">
              {selectedPatches.length > 0 && (
                <>
                  <Button 
                    variant="outline"
                    onClick={() => downloadPatchesMutation.mutate(selectedPatches)}
                    disabled={downloadPatchesMutation.isPending}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Download Selected
                  </Button>
                  <Button 
                    className="bg-primary text-white hover:bg-primary"
                    onClick={() => installPatchesMutation.mutate({ 
                      patchIds: selectedPatches, 
                      deviceIds: selectedDevices 
                    })}
                    disabled={installPatchesMutation.isPending}
                  >
                    <Play className="h-4 w-4 mr-2" />
                    Install Selected
                  </Button>
                </>
              )}
            </div>
          </div>
          {selectedPatches.length > 0 && (
            <div className="text-sm text-gray-600">
              Selected: {selectedPatches.length} patches • 
              Total size: {formatFileSize(calculateTotalSize())} • 
              Est. time: {Math.ceil(calculateInstallTime() / 60)} minutes
            </div>
          )}
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {filteredPatches.map((patch: PatchItem) => (
              <div key={patch.id} className="border rounded-lg p-4 hover:bg-gray-50">
                <div className="flex items-start space-x-4">
                  <Checkbox 
                    checked={selectedPatches.includes(patch.id)}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        setSelectedPatches([...selectedPatches, patch.id]);
                      } else {
                        setSelectedPatches(selectedPatches.filter(id => id !== patch.id));
                      }
                    }}
                  />
                  
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="font-medium text-gray-900">{patch.title}</h3>
                      <div className="flex items-center space-x-2">
                        {getStatusIcon(patch.status)}
                        <Badge className={getSeverityColor(patch.severity)}>
                          {patch.severity}
                        </Badge>
                        <Badge variant="outline" className="capitalize">
                          {patch.category}
                        </Badge>
                      </div>
                    </div>
                    
                    <p className="text-sm text-gray-600 mb-2">{patch.description}</p>
                    
                    <div className="flex items-center space-x-6 text-xs text-gray-500">
                      <span>Size: {formatFileSize(patch.size)}</span>
                      <span>Install time: ~{patch.installTime} min</span>
                      <span>Released: {new Date(patch.releaseDate).toLocaleDateString()}</span>
                      {patch.requiresReboot && (
                        <Badge variant="outline" className="text-xs">
                          Requires Reboot
                        </Badge>
                      )}
                    </div>

                    {patch.status === 'installing' && (
                      <div className="mt-3">
                        <div className="flex justify-between text-sm mb-1">
                          <span>Installing...</span>
                          <span>65%</span>
                        </div>
                        <Progress value={65} className="h-2" />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}