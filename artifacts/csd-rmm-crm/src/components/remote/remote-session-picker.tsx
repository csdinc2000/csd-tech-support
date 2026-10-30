import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Monitor } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { type Device } from "@shared/schema";
import RemoteSessionLauncher, {
  type RemoteLauncherSourceType,
} from "./remote-session-launcher";

interface RemoteSessionPickerProps {
  /** Restrict the picker to devices owned by this client. */
  clientId?: number | null;
  sourceType: RemoteLauncherSourceType;
  sourceId: number;
  triggerLabel?: string;
  size?: "sm" | "default";
}

export default function RemoteSessionPicker({
  clientId,
  sourceType,
  sourceId,
  triggerLabel = "Remote",
  size = "sm",
}: RemoteSessionPickerProps) {
  const [open, setOpen] = useState(false);
  const { data: devices = [], isLoading } = useQuery<Device[]>({
    queryKey: ["/api/devices"],
    enabled: open,
  });

  const candidates = clientId == null ? devices : devices.filter((d) => d.clientId === clientId);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default" size={size}>
          <Monitor className="h-4 w-4 mr-2" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Start remote session</DialogTitle>
          <DialogDescription>
            Choose which device to connect to{clientId != null ? " for this client" : ""}.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-sm text-gray-500">Loading devices…</div>
        ) : candidates.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-500">
            No devices available{clientId != null ? " for this client" : ""}.
          </div>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {candidates.map((device) => (
              <div
                key={device.id}
                className="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{device.name}</div>
                  <div className="text-xs text-gray-500 flex items-center gap-2 mt-1">
                    <Badge variant="outline" className="text-xs capitalize">
                      {device.type}
                    </Badge>
                    <Badge
                      variant={device.status === "online" ? "secondary" : "outline"}
                      className="text-xs capitalize"
                    >
                      {device.status}
                    </Badge>
                    {device.ipAddress && <span>{device.ipAddress}</span>}
                  </div>
                </div>
                <RemoteSessionLauncher
                  device={device}
                  sourceType={sourceType}
                  sourceId={sourceId}
                  size={size}
                  onSessionStarted={() => setOpen(false)}
                />
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
