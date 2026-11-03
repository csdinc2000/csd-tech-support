import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, MicOff, PhoneCall, PhoneOff } from "lucide-react";
import type { Call, Device as VoiceDevice } from "@twilio/voice-sdk";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, ApiRequestError } from "@/lib/queryClient";

type CallViaCsdButtonProps = {
  phone: string;
  contactId?: number;
  label?: string;
  size?: "sm" | "default";
};

export function CallViaCsdButton(props: CallViaCsdButtonProps) {
  const { can, isLoading } = useAdminAccess();
  if (isLoading || !can("communications")) return null;
  return <CallViaCsdButtonView {...props} />;
}

/**
 * The button without the access lookup, for provider-free screens (e.g. the
 * technician board) that already resolved the "communications" feature.
 */
export function CallViaCsdButtonView({
  phone,
  contactId,
  label,
  size = "sm",
}: CallViaCsdButtonProps) {
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"browser" | "callback" | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [callStatus, setCallStatus] = useState("");
  const [callError, setCallError] = useState("");
  const [browserConnected, setBrowserConnected] = useState(false);
  const [muted, setMuted] = useState(false);
  const deviceRef = useRef<VoiceDevice | null>(null);
  const callRef = useRef<Call | null>(null);
  const activeRef = useRef(true);

  if (!phone.trim()) return null;

  const terminalStatuses = new Set([
    "completed",
    "no-answer",
    "busy",
    "failed",
    "cancelled",
    "not-connected",
    "staff-no-answer",
    "staff-busy",
  ]);
  const terminal = Boolean(callStatus && terminalStatuses.has(callStatus));

  function disposeVoice() {
    const call = callRef.current;
    callRef.current = null;
    if (call) {
      call.removeAllListeners();
      try { call.disconnect(); } catch { /* already disconnected */ }
    }
    const device = deviceRef.current;
    deviceRef.current = null;
    if (device) {
      device.removeAllListeners();
      try { device.destroy(); } catch { /* already destroyed */ }
    }
    setBrowserConnected(false);
    setMuted(false);
  }

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      const call = callRef.current;
      callRef.current = null;
      if (call) {
        call.removeAllListeners();
        try { call.disconnect(); } catch { /* already disconnected */ }
      }
      const device = deviceRef.current;
      deviceRef.current = null;
      if (device) {
        device.removeAllListeners();
        try { device.destroy(); } catch { /* already destroyed */ }
      }
    };
  }, []);

  useEffect(() => {
    if (!callId || terminal) return;
    let stopped = false;
    const readStatus = async () => {
      try {
        const response = await apiRequest(
          "GET",
          `/api/twilio/calls/outbound/${encodeURIComponent(callId)}/status`,
        );
        const result = await response.json() as { status?: string };
        if (!stopped && result.status) setCallStatus(result.status);
      } catch {
        // Keep the active call usable if a status poll is briefly unavailable.
      }
    };
    void readStatus();
    const timer = window.setInterval(() => void readStatus(), 1200);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [callId, terminal]);

  function describeApiError(error: unknown): string {
    if (error instanceof ApiRequestError && error.payload && typeof error.payload === "object") {
      const payload = error.payload as { error?: unknown; missing?: unknown; voiceWebhookUrl?: unknown };
      const message = typeof payload.error === "string" ? payload.error : error.message;
      const missing = Array.isArray(payload.missing)
        ? payload.missing.filter((value): value is string => typeof value === "string")
        : [];
      const webhook = typeof payload.voiceWebhookUrl === "string" ? payload.voiceWebhookUrl : "";
      return [
        message,
        ...(missing.length ? [`Missing setup: ${missing.join(", ")}.`] : []),
        ...(webhook ? [`Set the TwiML App Voice URL to ${webhook}.`] : []),
      ].join(" ");
    }
    return error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "Could not start the call.";
  }

  async function startCallbackCall() {
    setPending(true);
    setCallError("");
    setCallStatus("preparing");
    setMode("callback");
    try {
      const response = await apiRequest("POST", "/api/twilio/calls/outbound", {
        to: phone,
        ...(contactId != null ? { contactId } : {}),
      });
      const result = await response.json().catch(() => null) as { agentPhone?: unknown; callId?: unknown } | null;
      if (typeof result?.callId === "string") setCallId(result.callId);
      const agentDigits = typeof result?.agentPhone === "string"
        ? result.agentPhone.replace(/\D/g, "")
        : "";
      const target = agentDigits.length >= 4
        ? `Your saved phone ending in ${agentDigits.slice(-4)} is ringing. Answer it and press 1; the app will report the customer-leg result.`
        : "Your saved phone is ringing. Answer it and press 1; the app will report the customer-leg result.";
      setCallStatus("staff-ringing");
      toast({
        title: "Callback started",
        description: target,
      });
    } catch (error) {
      setMode(null);
      setCallStatus("");
      const message = describeApiError(error);
      setCallError(message);
      toast({ title: "Call not started", description: message, variant: "destructive" });
    } finally {
      setPending(false);
    }
  }

  async function startBrowserCall() {
    setPending(true);
    setMode("browser");
    setCallError("");
    setCallStatus("preparing");
    let preparedCallId: string | null = null;
    try {
      const response = await apiRequest("POST", "/api/twilio/calls/browser-token", {
        to: phone,
        ...(contactId != null ? { contactId } : {}),
      });
      const setup = await response.json() as {
        token: string;
        callGrant: string;
        callId: string;
      };
      setCallId(setup.callId);
      preparedCallId = setup.callId;
      setCallStatus("requesting-microphone");

      const { Device } = await import("@twilio/voice-sdk");
      if (!Device.isSupported) {
        throw new Error("This browser does not support secure voice calling. Use a current browser over HTTPS or choose the saved-phone option.");
      }
      const device = new Device(setup.token);
      deviceRef.current = device;
      device.on("error", (error) => {
        if (!activeRef.current) return;
        setCallError(error.message || "The browser call failed.");
        setCallStatus("failed");
        disposeVoice();
      });

      const call = await device.connect({
        params: {
          To: phone,
          CallGrant: setup.callGrant,
        },
      });
      if (!activeRef.current) {
        call.removeAllListeners();
        call.disconnect();
        device.removeAllListeners();
        device.destroy();
        return;
      }
      callRef.current = call;
      setCallStatus("customer-dialing");
      call.on("ringing", () => {
        if (activeRef.current) setCallStatus("customer-ringing");
      });
      call.on("accept", () => {
        if (activeRef.current) {
          setBrowserConnected(true);
          setCallStatus("customer-connected");
        }
      });
      call.on("disconnect", () => {
        if (!activeRef.current) return;
        setBrowserConnected(false);
        setCallStatus((current) => terminalStatuses.has(current) ? current : "call-ending");
        disposeVoice();
      });
      call.on("cancel", () => {
        if (!activeRef.current) return;
        setCallStatus("cancelled");
        disposeVoice();
      });
      call.on("reject", () => {
        if (!activeRef.current) return;
        setCallStatus("not-connected");
        disposeVoice();
      });
      call.on("error", (error) => {
        if (!activeRef.current) return;
        setCallError(error.message || "The browser call failed.");
        setCallStatus("failed");
        disposeVoice();
      });
    } catch (error) {
      disposeVoice();
      if (preparedCallId) {
        void apiRequest("POST", `/api/twilio/calls/outbound/${encodeURIComponent(preparedCallId)}/fail`)
          .catch(() => undefined);
      }
      setMode(null);
      setCallStatus("");
      const isMicrophoneDenied = error instanceof DOMException && error.name === "NotAllowedError";
      const message = isMicrophoneDenied
        ? "Microphone access was blocked. Allow microphone access for this site, then try again."
        : describeApiError(error);
      setCallError(message);
      setCallId(null);
      toast({ title: "Browser call not started", description: message, variant: "destructive" });
    } finally {
      setPending(false);
    }
  }

  function toggleMute() {
    const call = callRef.current;
    if (!call) return;
    const nextMuted = !muted;
    call.mute(nextMuted);
    setMuted(nextMuted);
  }

  function endBrowserCall() {
    const call = callRef.current;
    if (call) {
      try { call.disconnect(); } catch { /* already disconnected */ }
    }
    setBrowserConnected(false);
    setCallStatus((current) => terminalStatuses.has(current) ? current : "completed");
    disposeVoice();
  }

  function statusLabel(): string {
    switch (callStatus) {
      case "preparing": return "Preparing the call…";
      case "requesting-microphone": return "Allow microphone access to continue.";
      case "queued": return "Call queued.";
      case "staff-ringing": return "Your saved phone is ringing.";
      case "staff-connected": return "Phone answered. Press 1 to connect to the customer.";
      case "staff-no-answer": return "Your saved phone was not answered.";
      case "staff-busy": return "Your saved phone was busy.";
      case "customer-dialing": return "Connecting to the customer…";
      case "customer-ringing": return "The customer's phone is ringing.";
      case "customer-connected": return "Connected to the customer.";
      case "call-ending": return "Call ended. Saving the customer-call result…";
      case "completed": return mode === "browser" ? "The call ended. Customer-leg result recorded." : "The customer call ended.";
      case "no-answer": return "The customer's phone was not answered.";
      case "busy": return "The customer's phone was busy.";
      case "failed": return "The call failed before the customer connected.";
      case "cancelled": return "The call was cancelled.";
      case "not-connected": return "The call ended before the customer connected.";
      default: return callStatus;
    }
  }

  function resetCall() {
    if (browserConnected || pending || (callStatus && !terminal)) return;
    disposeVoice();
    setCallId(null);
    setCallStatus("");
    setCallError("");
    setMode(null);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && (pending || (callStatus && !terminal))) return;
    if (nextOpen) resetCall();
    setOpen(nextOpen);
  }

  return (
    <>
      <Button
        type="button"
        size={size}
        variant="outline"
        onClick={() => { resetCall(); setOpen(true); }}
        disabled={pending}
        aria-label={`Call ${label || phone} from the CSD business line`}
        data-testid={contactId != null ? `call-contact-${contactId}` : "call-via-csd"}
      >
        <PhoneCall className="mr-1.5 h-4 w-4" />
        {pending ? "Calling…" : label || "Call"}
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent onInteractOutside={(event) => {
          if (pending || (callStatus && !terminal)) event.preventDefault();
        }}>
          <DialogHeader>
            <DialogTitle>Call {label || "customer"}</DialogTitle>
            <DialogDescription>
              Choose browser audio or have your saved phone ring first.
            </DialogDescription>
          </DialogHeader>
          {!mode && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Button type="button" onClick={startBrowserCall} disabled={pending} className="h-auto min-h-16 justify-start whitespace-normal">
                <Mic className="mr-2 h-4 w-4 shrink-0" />
                <span className="text-left">
                  <span className="block">Browser audio</span>
                  <span className="block text-xs font-normal opacity-80">Talk through this device</span>
                </span>
              </Button>
              <Button type="button" variant="outline" onClick={startCallbackCall} disabled={pending} className="h-auto min-h-16 justify-start whitespace-normal">
                <PhoneCall className="mr-2 h-4 w-4 shrink-0" />
                <span className="text-left">
                  <span className="block">Saved phone</span>
                  <span className="block text-xs font-normal opacity-80">Answer, then press 1</span>
                </span>
              </Button>
            </div>
          )}
          {pending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              Starting call…
            </div>
          )}
          {callStatus && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm" role="status" aria-live="polite">
              {statusLabel()}
            </div>
          )}
          {callError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
              {callError}
            </div>
          )}
          {mode === "browser" && (
            <div className="flex gap-2">
              {browserConnected && (
                <Button type="button" variant="outline" onClick={toggleMute} aria-pressed={muted}>
                  {muted ? <MicOff className="mr-2 h-4 w-4" /> : <Mic className="mr-2 h-4 w-4" />}
                  {muted ? "Unmute" : "Mute"}
                </Button>
              )}
              {callStatus && !terminal && (
                <Button type="button" variant="destructive" onClick={endBrowserCall}>
                  <PhoneOff className="mr-2 h-4 w-4" />
                  End call
                </Button>
              )}
            </div>
          )}
          {mode && terminal && (
            <Button type="button" variant="outline" onClick={resetCall}>
              Start another call
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
