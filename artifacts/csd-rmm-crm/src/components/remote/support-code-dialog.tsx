import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { KeyRound, Phone, RefreshCw } from "lucide-react";
import type { Device } from "@shared/schema";

interface GeneratedCode {
  code: string;
  deviceName: string;
  sessionType: string;
  expiresAt: string;
}

/**
 * Generates a short, single-use 6-digit code a technician reads to a customer on
 * the phone. The customer types it into the public Remote Support widget
 * (the Remote Support box on computersystemsdepot.com) and is dropped into this
 * device's MeshCentral session. Backed by POST /api/support/generate-code.
 */
export default function SupportCodeDialog({ device }: { device: Device }) {
  const [open, setOpen] = useState(false);
  const [generated, setGenerated] = useState<GeneratedCode | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const { toast } = useToast();

  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/support/generate-code", {
        deviceId: device.id,
        sessionType: "desktop",
      });
      return (await res.json()) as GeneratedCode;
    },
    onSuccess: (data) => setGenerated(data),
    onError: () =>
      toast({ title: "Could not generate a support code", variant: "destructive" }),
  });

  // Generate a fresh code each time the dialog is opened.
  useEffect(() => {
    if (open && !generated && !generateMutation.isPending) {
      generateMutation.mutate();
    }
    if (!open) {
      setGenerated(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Live countdown to the code's expiry.
  useEffect(() => {
    if (!generated) return;
    const tick = () => {
      const left = Math.max(
        0,
        Math.floor((new Date(generated.expiresAt).getTime() - Date.now()) / 1000),
      );
      setSecondsLeft(left);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [generated]);

  const expired = generated !== null && secondsLeft <= 0;
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="w-full">
          <KeyRound className="h-4 w-4 mr-1" />
          Phone Support Code
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remote Support Code</DialogTitle>
          <DialogDescription>
            Read this code to the customer on the phone. They enter it in the Remote
            Support box at{" "}
            <span className="font-medium">computersystemsdepot.com</span> to connect to{" "}
            <span className="font-medium">{device.name}</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 text-center space-y-4">
          {generateMutation.isPending && !generated ? (
            <p className="text-gray-500">Generating a secure code…</p>
          ) : generated ? (
            <>
              <div
                className={`text-5xl font-bold tracking-[0.4em] pl-4 ${
                  expired ? "text-gray-300 line-through" : "text-gray-900"
                }`}
              >
                {generated.code}
              </div>
              <p className={`text-sm ${expired ? "text-red-600" : "text-gray-500"}`}>
                {expired ? "This code has expired." : `Expires in ${mm}:${ss}`}
              </p>
              <div className="flex items-center justify-center gap-2 text-sm text-gray-600">
                <Phone className="h-4 w-4" />
                Single-use · valid for 10 minutes
              </div>
            </>
          ) : (
            <p className="text-gray-500">No code yet.</p>
          )}

          <Button
            variant="outline"
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
            className="mt-2"
          >
            <RefreshCw className="h-4 w-4 mr-1" />
            {expired ? "Generate New Code" : "Regenerate"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
