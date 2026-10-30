import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Monitor, Terminal, FolderOpen, MessageSquare, MoreVertical, ExternalLink } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

export type RemoteLauncherSourceType = "device" | "alert" | "ticket" | "manual";
export type RemoteLauncherSessionType = "desktop" | "terminal" | "files" | "chat";

export interface RemoteSessionLauncherDevice {
  id: number;
  name: string;
  status?: string | null;
  meshNodeId?: string | null;
  teamviewerId?: string | null;
  preferredRemoteProvider?: string | null;
  remoteAccessEnabled?: boolean | null;
}

interface RemoteSessionLauncherProps {
  device: RemoteSessionLauncherDevice;
  sourceType?: RemoteLauncherSourceType;
  sourceId?: number;
  /** Render style. "button" shows a labelled Remote button; "icon" shows a compact icon-only trigger. */
  variant?: "button" | "icon";
  size?: "sm" | "default";
  className?: string;
  /** Called after a session is successfully started (post-launch). */
  onSessionStarted?: (result: { id: number; provider: string; launchUrl: string }) => void;
}

interface StartSessionPayload {
  provider: "meshcentral" | "teamviewer";
  sessionType: RemoteLauncherSessionType;
}

interface StartSessionResponse {
  id: number;
  provider: string;
  launchUrl: string;
  sessionUrl?: string;
  deviceName?: string;
}

function launchUrlInBrowser(url: string, isProtocolHandler: boolean) {
  if (isProtocolHandler) {
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener noreferrer";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer,width=1280,height=800");
}

export default function RemoteSessionLauncher({
  device,
  sourceType = "manual",
  sourceId,
  variant = "button",
  size = "sm",
  className,
  onSessionStarted,
}: RemoteSessionLauncherProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pendingSession, setPendingSession] = useState<StartSessionPayload | null>(null);

  const requestSession = (payload: StartSessionPayload) => {
    setOpen(false);
    setPendingSession(payload);
  };

  const meshAvailable = Boolean(device.meshNodeId);
  const teamviewerAvailable = Boolean(device.teamviewerId && device.teamviewerId.replace(/\D/g, "").length > 0);
  const isOnline = !device.status || device.status === "online";
  const preferred = device.preferredRemoteProvider ?? "meshcentral";

  const startSession = useMutation({
    mutationFn: async ({ provider, sessionType }: StartSessionPayload) => {
      const endpoint =
        provider === "teamviewer"
          ? "/api/remote-sessions/teamviewer/start"
          : "/api/remote-sessions/start";
      const res = await apiRequest("POST", endpoint, {
        deviceId: device.id,
        sessionType,
        recording: provider === "meshcentral",
        sourceType,
        sourceId,
      });
      return (await res.json()) as StartSessionResponse;
    },
    onSuccess: (data) => {
      const url = data.launchUrl || data.sessionUrl;
      if (!url) {
        toast({ title: "Session started but no launch URL was returned", variant: "destructive" });
        return;
      }
      launchUrlInBrowser(url, data.provider === "teamviewer");
      toast({
        title: `${data.provider === "teamviewer" ? "TeamViewer" : "MeshCentral"} session started`,
        description: data.deviceName ? `Connecting to ${data.deviceName}…` : "Launching client…",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/remote-sessions/active"] });
      onSessionStarted?.({ id: data.id, provider: data.provider, launchUrl: url });
    },
    onError: (error: any) => {
      toast({
        title: "Could not start remote session",
        description: error?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
    onSettled: () => setOpen(false),
  });

  const trigger =
    variant === "icon" ? (
      <Button variant="ghost" size="icon" className={className} aria-label="Remote session">
        <MoreVertical className="h-4 w-4" />
      </Button>
    ) : (
      <Button
        variant="default"
        size={size}
        className={className}
        disabled={!isOnline || (!meshAvailable && !teamviewerAvailable)}
      >
        <Monitor className="h-4 w-4 mr-2" />
        Remote
      </Button>
    );

  return (
    <>
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>
          Connect to {device.name}
          {device.status && device.status !== "online" && (
            <span className="ml-2 text-xs text-amber-600">({device.status})</span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {/* MeshCentral submenu */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={!meshAvailable}>
            <Monitor className="h-4 w-4 mr-2" />
            MeshCentral {preferred === "meshcentral" ? "(preferred)" : ""}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem
              onClick={() => requestSession({ provider: "meshcentral", sessionType: "desktop" })}
            >
              <Monitor className="h-4 w-4 mr-2" />
              Remote Desktop
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => requestSession({ provider: "meshcentral", sessionType: "terminal" })}
            >
              <Terminal className="h-4 w-4 mr-2" />
              Terminal
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => requestSession({ provider: "meshcentral", sessionType: "files" })}
            >
              <FolderOpen className="h-4 w-4 mr-2" />
              File Manager
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => requestSession({ provider: "meshcentral", sessionType: "chat" })}
            >
              <MessageSquare className="h-4 w-4 mr-2" />
              Send Chat Message
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* TeamViewer submenu */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={!teamviewerAvailable}>
            <ExternalLink className="h-4 w-4 mr-2" />
            TeamViewer {preferred === "teamviewer" ? "(preferred)" : ""}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem
              onClick={() => requestSession({ provider: "teamviewer", sessionType: "desktop" })}
            >
              <Monitor className="h-4 w-4 mr-2" />
              Remote Control
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => requestSession({ provider: "teamviewer", sessionType: "files" })}
            >
              <FolderOpen className="h-4 w-4 mr-2" />
              File Transfer
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {!teamviewerAvailable && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled className="text-xs text-gray-500">
              No TeamViewer ID configured — add one in device settings.
            </DropdownMenuItem>
          </>
        )}
        {!meshAvailable && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled className="text-xs text-gray-500">
              No MeshCentral node — pair the agent on this device first.
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>

    <AlertDialog
      open={pendingSession !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) setPendingSession(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm authorized remote session</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                You are about to start a{" "}
                <span className="font-medium">
                  {pendingSession?.provider === "teamviewer" ? "TeamViewer" : "MeshCentral"}{" "}
                  {pendingSession?.sessionType}
                </span>{" "}
                session on <span className="font-medium">{device.name}</span>.
              </p>
              <p>
                Start remote access only after client approval or under an active managed-service
                authorization. All remote sessions are logged
                {pendingSession?.provider !== "teamviewer" && " and MeshCentral sessions may be recorded"}
                .
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={startSession.isPending}
            onClick={() => {
              if (pendingSession) startSession.mutate(pendingSession);
              setPendingSession(null);
            }}
          >
            I have authorization — start session
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
