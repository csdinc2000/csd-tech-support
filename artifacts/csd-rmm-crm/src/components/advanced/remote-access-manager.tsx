import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { 
  Monitor, 
  Terminal, 
  FolderOpen, 
  MessageSquare, 
  Play, 
  Square, 
  Video, 
  Clock,
  Eye,
  Download,
  AlertTriangle,
  CheckCircle,
  Wifi,
  WifiOff,
  Trash2
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import RemoteSessionLauncher from "@/components/remote/remote-session-launcher";
import ComplianceNotice from "@/components/compliance-notice";
import SupportCodeDialog from "@/components/remote/support-code-dialog";
import { RefreshCw } from "lucide-react";

import type { Device } from "@shared/schema";

interface RemoteSession {
  id: number;
  deviceId: number;
  provider: 'meshcentral' | 'teamviewer';
  sessionType: 'desktop' | 'terminal' | 'files' | 'chat';
  status: 'active' | 'ended' | 'disconnected' | 'failed';
  startTime: string;
  endTime?: string | null;
  duration?: number | null;
  recordingEnabled?: boolean | null;
  recordingPath?: string | null;
  connectionQuality?: string | null;
  userAgent?: string | null;
}

// Mirrors the payload of GET /api/meshcentral/status (see the api-server route
// of the same path). Typed here so the banner's status branches are checked
// against the states the server can actually report.
interface MeshCentralStatus {
  status: 'connected' | 'unreachable' | 'authentication_failed' | 'not_configured' | 'error';
  isConfigured?: boolean;
  url?: string | null;
  message?: string | null;
}

export default function RemoteAccessManager() {
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [activeSessionType, setActiveSessionType] = useState<string>('');
  const [isSessionDialogOpen, setIsSessionDialogOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: devices = [], isLoading: devicesLoading } = useQuery<Device[]>({
    queryKey: ["/api/devices"],
  });

  const { data: activeSessions = [], isLoading: sessionsLoading } = useQuery<RemoteSession[]>({
    queryKey: ["/api/remote-sessions/active"],
  });

  // MeshCentral status and management
  const { data: meshStatus } = useQuery<MeshCentralStatus>({
    queryKey: ["/api/meshcentral/status"],
  });

  const { data: sessionRecordings = [] } = useQuery<any[]>({
    queryKey: ["/api/remote-sessions/recordings"],
  });

  const endSessionMutation = useMutation({
    mutationFn: (sessionId: number) =>
      apiRequest("POST", `/api/remote-sessions/${sessionId}/end`),
    onSuccess: () => {
      toast({ title: "Session ended successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/remote-sessions/active"] });
    },
  });

  const deleteRecordingMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest("DELETE", `/api/remote-sessions/${id}`),
    onSuccess: () => {
      toast({ title: "Recording deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/remote-sessions/recordings"] });
    },
    onError: () => {
      toast({ title: "Failed to delete recording", variant: "destructive" });
    },
  });

  const syncMeshMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/meshcentral/sync"),
    onSuccess: () => {
      toast({ title: "MeshCentral sync requested" });
      queryClient.invalidateQueries({ queryKey: ["/api/meshcentral/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/meshcentral/devices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/devices"] });
    },
    onError: (error: any) => {
      toast({
        title: "MeshCentral sync failed",
        description: error?.message ?? "Check the connection status",
        variant: "destructive",
      });
    },
  });

  const getSessionTypeIcon = (type: string) => {
    switch (type) {
      case 'desktop': return <Monitor className="h-4 w-4" />;
      case 'terminal': return <Terminal className="h-4 w-4" />;
      case 'files': return <FolderOpen className="h-4 w-4" />;
      case 'chat': return <MessageSquare className="h-4 w-4" />;
      default: return <Monitor className="h-4 w-4" />;
    }
  };

  const getConnectionQualityColor = (quality: string) => {
    switch (quality) {
      case 'excellent': return 'text-green-600';
      case 'good': return 'text-blue-600';
      case 'poor': return 'text-yellow-600';
      case 'unstable': return 'text-red-600';
      default: return 'text-gray-600';
    }
  };

  const formatDuration = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  };

  const onlineDevices = devices.filter(d => d.status === 'online' && d.remoteAccessEnabled);
  const offlineDevices = devices.filter(d => d.status !== 'online' || !d.remoteAccessEnabled);

  if (devicesLoading) {
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
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Remote Access Manager</h2>
          <p className="text-gray-600">MeshCentral-powered remote desktop and support tools</p>
        </div>
        <div className="flex items-center space-x-4">
          <Badge variant="outline" className="text-green-600">
            <Wifi className="h-4 w-4 mr-1" />
            {onlineDevices.length} Online
          </Badge>
          <Badge variant="outline" className="text-gray-600">
            <WifiOff className="h-4 w-4 mr-1" />
            {offlineDevices.length} Offline
          </Badge>
        </div>
      </div>

      {/* MeshCentral connection status */}
      {meshStatus && (
        <Alert variant={meshStatus.status === "connected" ? "default" : "destructive"}>
          <div className="flex items-start justify-between w-full">
            <div>
              <AlertTitle>
                MeshCentral: {meshStatus.status === "connected"
                  ? "Connected"
                  : meshStatus.status === "unreachable"
                    ? "Unreachable"
                    : meshStatus.status === "not_configured"
                      ? "Not configured"
                      : "Connection failed"}
              </AlertTitle>
              <AlertDescription className="space-y-1">
                {meshStatus.url && <p>Server: {meshStatus.url}</p>}
                {meshStatus.message && <p>{meshStatus.message}</p>}
                {meshStatus.status === "unreachable" && (
                  <p>
                    The server is behind Cloudflare but the origin certificate is invalid (HTTP 526). Fix the SSL/TLS certificate on the MeshCentral origin, or change the Cloudflare SSL/TLS mode.
                  </p>
                )}
                {meshStatus.status === "authentication_failed" && (
                  <p>Check MESHCENTRAL_USERNAME and MESHCENTRAL_PASSWORD.</p>
                )}
                {meshStatus.status === "not_configured" && (
                  <p>Set MESHCENTRAL_URL, MESHCENTRAL_USERNAME, and MESHCENTRAL_PASSWORD.</p>
                )}
              </AlertDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => syncMeshMutation.mutate()}
              disabled={syncMeshMutation.isPending || meshStatus.status === "not_configured"}
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${syncMeshMutation.isPending ? "animate-spin" : ""}`} />
              Sync Now
            </Button>
          </div>
        </Alert>
      )}

      <ComplianceNotice title="Remote Access Consent">
        Start remote access only after client approval or under an active managed-service
        authorization. All remote sessions are logged, and MeshCentral sessions may be recorded.
      </ComplianceNotice>

      {/* Active Sessions */}
      {activeSessions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Active Remote Sessions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {(activeSessions as RemoteSession[]).map((session) => {
                const targetDevice = (devices as Device[]).find((d) => d.id === session.deviceId);
                const deviceName = targetDevice?.name ?? `Device #${session.deviceId}`;
                const elapsed = formatDuration(
                  Math.max(0, Math.floor((Date.now() - new Date(session.startTime).getTime()) / 1000)),
                );
                return (
                  <div key={session.id} className="flex items-center justify-between p-3 border rounded-lg">
                    <div className="flex items-center space-x-3">
                      {getSessionTypeIcon(session.sessionType)}
                      <div>
                        <p className="font-medium">{deviceName}</p>
                        <p className="text-sm text-gray-600 capitalize">
                          {session.provider} • {session.sessionType} • {elapsed}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Badge variant="outline" className="capitalize">
                        {session.provider}
                      </Badge>
                      {session.connectionQuality && (
                        <Badge className={getConnectionQualityColor(session.connectionQuality)}>
                          {session.connectionQuality}
                        </Badge>
                      )}
                      {session.recordingEnabled && (
                        <Badge variant="outline">
                          <Video className="h-3 w-3 mr-1" />
                          Recording
                        </Badge>
                      )}
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => endSessionMutation.mutate(session.id)}
                        disabled={endSessionMutation.isPending}
                      >
                        <Square className="h-4 w-4 mr-1" />
                        End
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Online Devices */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <CheckCircle className="h-5 w-5 text-green-500 mr-2" />
            Online Devices ({onlineDevices.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {onlineDevices.map((device) => (
              <Card key={device.id} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">{device.name}</CardTitle>
                    <Badge className="bg-green-100 text-green-800">Online</Badge>
                  </div>
                  <p className="text-sm text-gray-600">{device.operatingSystem}</p>
                </CardHeader>
                
                <CardContent className="space-y-3">
                  <div className="text-sm text-gray-600">
                    <p>Type: {device.type}</p>
                    <p>IP: {device.ipAddress || 'N/A'}</p>
                    <p>Last Seen: {new Date(device.lastSeen!).toLocaleString()}</p>
                    {device.teamviewerId && (
                      <p className="text-xs text-blue-600 mt-1">TeamViewer ID: {device.teamviewerId}</p>
                    )}
                  </div>

                  <RemoteSessionLauncher
                    device={device}
                    sourceType="device"
                    sourceId={device.id}
                    size="sm"
                    className="w-full"
                  />

                  {device.meshNodeId && <SupportCodeDialog device={device} />}
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Offline Devices */}
      {offlineDevices.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <AlertTriangle className="h-5 w-5 text-yellow-500 mr-2" />
              Offline Devices ({offlineDevices.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {offlineDevices.map((device) => (
                <Card key={device.id} className="opacity-60">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg">{device.name}</CardTitle>
                      <Badge variant="secondary">Offline</Badge>
                    </div>
                    <p className="text-sm text-gray-600">{device.operatingSystem}</p>
                  </CardHeader>
                  
                  <CardContent className="space-y-3">
                    <div className="text-sm text-gray-600">
                      <p>Type: {device.type}</p>
                      <p>IP: {device.ipAddress || 'N/A'}</p>
                      <p>Last Seen: {new Date(device.lastSeen!).toLocaleString()}</p>
                    </div>
                    <p className="text-sm text-red-600">Remote access unavailable</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Session Recordings */}
      {sessionRecordings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <Video className="h-5 w-5 mr-2" />
              Session Recordings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {sessionRecordings.slice(0, 10).map((recording: any, index) => (
                <div key={index} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center space-x-3">
                    {getSessionTypeIcon(recording.sessionType)}
                    <div>
                      <p className="font-medium">{recording.deviceName}</p>
                      <p className="text-sm text-gray-600">
                        {recording.sessionType} • {formatDuration(recording.duration)} • {new Date(recording.startTime).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Button size="sm" variant="outline">
                      <Eye className="h-4 w-4 mr-1" />
                      View
                    </Button>
                    <Button size="sm" variant="outline">
                      <Download className="h-4 w-4 mr-1" />
                      Download
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-red-600 hover:text-red-700"
                      onClick={() => {
                        if (window.confirm("Delete this session recording? This cannot be undone.")) {
                          deleteRecordingMutation.mutate(recording.id);
                        }
                      }}
                      disabled={deleteRecordingMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}