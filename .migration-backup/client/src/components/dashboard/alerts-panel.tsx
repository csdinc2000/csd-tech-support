import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, BellOff, Clock, Loader2 } from "lucide-react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Alert, Device } from "@shared/schema";
import RemoteSessionLauncher from "@/components/remote/remote-session-launcher";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

interface AlertsPanelProps {
  alerts: Alert[];
}

interface A2pSnoozeStatus {
  active: boolean;
  snoozeUntil: string | null;
  snoozeStartedAt: string | null;
  snoozeStartedBy: string | null;
  // false when GET /api/twilio/a2p/snooze returned 401/403, i.e. the
  // current viewer isn't an owner and we should hide the snooze controls.
  allowed: boolean;
}

async function fetchA2pSnooze(): Promise<A2pSnoozeStatus> {
  const res = await fetch("/api/twilio/a2p/snooze", { credentials: "include" });
  if (res.status === 401 || res.status === 403) {
    return { active: false, snoozeUntil: null, snoozeStartedAt: null, snoozeStartedBy: null, allowed: false };
  }
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  // Server includes `allowed` so non-owners can see muted state without
  // getting snooze/resume buttons.
  return (await res.json()) as A2pSnoozeStatus;
}

export default function AlertsPanel({ alerts }: AlertsPanelProps) {
  const { toast } = useToast();
  const { data: devices = [] } = useQuery<Device[]>({ queryKey: ["/api/devices"] });
  const devicesById = new Map(devices.map((d) => [d.id, d]));

  // Fetch snooze state so we can show controls inline on any A2P alert card
  // and surface a panel-level muted indicator — owners triaging from the
  // dashboard shouldn't have to bounce to the Messages page to know A2P
  // pages are silenced, or to resume them.
  const { data: snooze } = useQuery<A2pSnoozeStatus>({
    queryKey: ["/api/twilio/a2p/snooze"],
    queryFn: fetchA2pSnooze,
    refetchInterval: 60 * 1000,
  });

  const snoozeMutation = useMutation({
    mutationFn: async (hours: number) => {
      const res = await apiRequest("POST", "/api/twilio/a2p/snooze", { hours });
      const body = (await res.json()) as Omit<A2pSnoozeStatus, "allowed">;
      return { ...body, allowed: true } as A2pSnoozeStatus;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/twilio/a2p/snooze"] });
      toast({ title: "A2P alerts snoozed for 24h" });
    },
    onError: (e: Error) =>
      toast({ title: "Couldn't snooze alerts", description: e.message, variant: "destructive" }),
  });

  const unsnoozeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/twilio/a2p/snooze");
      const body = (await res.json()) as Omit<A2pSnoozeStatus, "allowed">;
      return { ...body, allowed: true } as A2pSnoozeStatus;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/twilio/a2p/snooze"] });
      toast({ title: "A2P alerts resumed" });
    },
    onError: (e: Error) =>
      toast({ title: "Couldn't resume alerts", description: e.message, variant: "destructive" }),
  });

  const snoozeAllowed = snooze?.allowed === true;
  const snoozedUntil =
    snoozeAllowed && snooze?.active && snooze.snoozeUntil ? new Date(snooze.snoozeUntil) : null;
  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "critical":
        return "bg-red-50 border-red-200 text-red-800";
      case "warning":
        return "bg-yellow-50 border-yellow-200 text-yellow-800";
      case "info":
        return "bg-blue-50 border-blue-200 text-blue-800";
      default:
        return "bg-gray-50 border-gray-200 text-gray-800";
    }
  };

  const getSeverityDot = (severity: string) => {
    switch (severity) {
      case "critical":
        return "bg-red-500";
      case "warning":
        return "bg-yellow-500";
      case "info":
        return "bg-blue-500";
      default:
        return "bg-gray-500";
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
    return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  };

  return (
    <Card className="bg-white shadow-sm border border-gray-200">
      <CardHeader className="pb-4">
        <CardTitle className="text-lg font-semibold text-gray-900">
          Recent Alerts
        </CardTitle>
        <p className="text-sm text-gray-600">Real-time system notifications</p>
        {snoozedUntil && (
          <div
            className="mt-3 flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
            data-testid="a2p-muted-banner"
          >
            <span className="inline-flex items-center gap-1.5">
              <BellOff className="h-3.5 w-3.5" />
              A2P alerts muted until {format(snoozedUntil, "MMM d, h:mm a")}
            </span>
            <button
              type="button"
              onClick={() => unsnoozeMutation.mutate()}
              disabled={unsnoozeMutation.isPending}
              className="font-medium underline disabled:opacity-60"
              data-testid="button-a2p-muted-banner-resume"
            >
              {unsnoozeMutation.isPending ? "Resuming…" : "Resume"}
            </button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {alerts.length === 0 ? (
          <div className="text-center py-8">
            <AlertTriangle className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-500">No active alerts</p>
          </div>
        ) : (
          alerts.slice(0, 3).map((alert) => {
            const isA2p = alert.alertSource === "a2p-monitor";
            return (
            <div
              key={alert.id}
              className={`flex items-start space-x-3 p-3 border rounded-lg ${getSeverityColor(alert.severity)}`}
              data-testid={`alert-card-${alert.id}`}
            >
              <div className="flex-shrink-0">
                <div className={`w-2 h-2 rounded-full mt-2 ${getSeverityDot(alert.severity)}`} />
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">{alert.title}</p>
                  <div className="flex items-center space-x-1 text-xs">
                    <Clock className="h-3 w-3" />
                    <span>{formatTimeAgo(alert.createdAt)}</span>
                  </div>
                </div>
                <p className="text-sm mt-1">{alert.description}</p>
                <div className="mt-2 flex items-center space-x-2 flex-wrap gap-2">
                  {alert.deviceId ? (
                    <Badge variant="outline" className="text-xs">
                      Device #{alert.deviceId}
                    </Badge>
                  ) : null}
                  <Badge
                    variant={alert.severity === "critical" ? "destructive" : "secondary"}
                    className="text-xs capitalize"
                  >
                    {alert.severity}
                  </Badge>
                  {alert.deviceId && devicesById.get(alert.deviceId) && (
                    <RemoteSessionLauncher
                      device={devicesById.get(alert.deviceId)!}
                      sourceType="alert"
                      sourceId={alert.id}
                      size="sm"
                    />
                  )}
                  {isA2p && snoozeAllowed && (
                    snoozedUntil ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-md border border-current/30 px-2 py-0.5 text-xs"
                        data-testid={`a2p-alert-snoozed-${alert.id}`}
                      >
                        <BellOff className="h-3 w-3" />
                        Muted until {format(snoozedUntil, "MMM d, h:mm a")}
                        <button
                          type="button"
                          onClick={() => unsnoozeMutation.mutate()}
                          disabled={unsnoozeMutation.isPending}
                          className="ml-1 underline disabled:opacity-60"
                          data-testid={`button-a2p-alert-unsnooze-${alert.id}`}
                        >
                          {unsnoozeMutation.isPending ? "Resuming…" : "Resume"}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => snoozeMutation.mutate(24)}
                        disabled={snoozeMutation.isPending}
                        className="inline-flex items-center gap-1 rounded-md border border-current/30 px-2 py-0.5 text-xs hover:bg-white/40 disabled:opacity-60"
                        data-testid={`button-a2p-alert-snooze-${alert.id}`}
                        title="Pause repeat A2P alerts for 24 hours while you work with Twilio support"
                      >
                        {snoozeMutation.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <BellOff className="h-3 w-3" />
                        )}
                        Snooze 24h
                      </button>
                    )
                  )}
                </div>
              </div>
            </div>
          );
          })
        )}
        
        {alerts.length > 0 && (
          <div className="text-center pt-4">
            <Button variant="ghost" className="text-primary hover:text-red-600">
              View All Alerts
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
