import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Delete, Grid3x3, Mic, MicOff, Phone, PhoneCall, PhoneIncoming, PhoneOff, X } from "lucide-react";
import type { Call, Device as VoiceDevice } from "@twilio/voice-sdk";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatUsPhone } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CallViaCsdButtonView } from "./call-via-csd-button";

/**
 * App phone: answer business-line calls in the browser and place calls from a
 * dial pad. Mounted once in the staff layout.
 *
 * - "Ring me in the app" (per person) registers this browser with Twilio while
 *   the app is open; incoming calls then ring here as well as on forwarded
 *   phones. First to answer gets the call. Server: api-server/src/app-phone.ts.
 * - The dial pad reuses the existing call flow: talk through the browser, or
 *   have your saved phone ring first. Either way the customer sees the
 *   business number.
 */

const SETTING_KEY = ["/api/twilio/app-phone"];
const KEYPAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

type Status = "off" | "connecting" | "ready" | "unavailable";

function callerOf(call: Call): { number: string; line: string } {
  const params = call.customParameters;
  return {
    number: params.get("caller") || call.parameters?.From || "Unknown caller",
    line: params.get("line") || "",
  };
}

function useElapsed(since: number | null): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  if (!since) return "";
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function AppPhone() {
  const { can, isLoading } = useAdminAccess();
  if (isLoading || !can("communications")) return null;
  return <AppPhoneView />;
}

type VoiceSdk = Pick<typeof import("@twilio/voice-sdk"), "Device">;
const loadTwilioVoiceSdk = (): Promise<VoiceSdk> => import("@twilio/voice-sdk");

/** `loadVoiceSdk` lets browser tests swap in a fake Twilio Device. */
export function AppPhoneView({ loadVoiceSdk = loadTwilioVoiceSdk }: { loadVoiceSdk?: () => Promise<VoiceSdk> } = {}) {
  const { toast } = useToast();
  const [panelOpen, setPanelOpen] = useState(false);
  const [status, setStatus] = useState<Status>("off");
  const [statusDetail, setStatusDetail] = useState("");
  const [incoming, setIncoming] = useState<Call | null>(null);
  const [active, setActive] = useState<Call | null>(null);
  const [answeredAt, setAnsweredAt] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [showKeypad, setShowKeypad] = useState(false);
  const [dialNumber, setDialNumber] = useState("");
  const deviceRef = useRef<VoiceDevice | null>(null);
  const activeRef = useRef<Call | null>(null);
  const elapsed = useElapsed(answeredAt);

  const setting = useQuery<{ ringInApp: boolean }>({ queryKey: SETTING_KEY });
  const ringInApp = setting.data?.ringInApp === true;

  const save = useMutation({
    mutationFn: async (next: boolean) => (await apiRequest("PUT", "/api/twilio/app-phone", { ringInApp: next })).json(),
    onSuccess: (data) => queryClient.setQueryData(SETTING_KEY, data),
    onError: (error) => toast({
      title: "Could not change your phone setting",
      description: error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : undefined,
      variant: "destructive",
    }),
  });

  const fetchToken = useCallback(async (): Promise<string> => {
    const response = await apiRequest("POST", "/api/twilio/app-phone/token");
    return ((await response.json()) as { token: string }).token;
  }, []);

  const endCallState = useCallback(() => {
    activeRef.current = null;
    setActive(null);
    setAnsweredAt(null);
    setMuted(false);
    setShowKeypad(false);
  }, []);

  // Register this browser with Twilio while "Ring me in the app" is on.
  useEffect(() => {
    if (!ringInApp) {
      setStatus("off");
      return;
    }
    let cancelled = false;
    let device: VoiceDevice | null = null;
    setStatus("connecting");
    setStatusDetail("");
    (async () => {
      try {
        const { Device } = await loadVoiceSdk();
        if (!Device.isSupported) throw new Error("This browser can't take calls. Use a current Chrome, Edge, Safari or Firefox.");
        const token = await fetchToken();
        if (cancelled) return;
        device = new Device(token, { closeProtection: "A call is in progress. Leave anyway?" });
        deviceRef.current = device;
        device.on("registered", () => { if (!cancelled) setStatus("ready"); });
        device.on("unregistered", () => { if (!cancelled) setStatus("connecting"); });
        device.on("error", (error: { message?: string }) => {
          if (cancelled) return;
          setStatusDetail(error?.message || "The app phone lost its connection.");
        });
        device.on("tokenWillExpire", async () => {
          try { device?.updateToken(await fetchToken()); } catch { /* next registration retry */ }
        });
        device.on("incoming", (call: Call) => {
          if (cancelled) return;
          setIncoming(call);
          const clear = () => setIncoming((current) => (current === call ? null : current));
          // Another person answered, the caller hung up, or it went to voicemail.
          call.on("cancel", clear);
          call.on("reject", clear);
          call.on("disconnect", () => {
            clear();
            if (activeRef.current === call) endCallState();
          });
          try {
            if (document.visibilityState !== "visible" && typeof Notification !== "undefined" && Notification.permission === "granted") {
              const caller = callerOf(call);
              new Notification("Incoming call", { body: formatUsPhone(caller.number, caller.number), tag: "csd-app-phone" });
            }
          } catch { /* the in-app pop-up still shows */ }
        });
        await device.register();
      } catch (error) {
        if (cancelled) return;
        setStatus("unavailable");
        setStatusDetail(error instanceof Error ? error.message.replace(/^\d+:\s*/, "") : "The app phone couldn't connect.");
      }
    })();
    return () => {
      cancelled = true;
      deviceRef.current = null;
      if (device) {
        device.removeAllListeners();
        try { device.destroy(); } catch { /* already gone */ }
      }
    };
  }, [ringInApp, fetchToken, endCallState, loadVoiceSdk]);

  const answer = () => {
    const call = incoming;
    if (!call) return;
    try {
      call.accept();
      setIncoming(null);
      activeRef.current = call;
      setActive(call);
      setAnsweredAt(Date.now());
      call.on("error", (error: { message?: string }) =>
        toast({ title: "Call problem", description: error?.message || "The call had a problem.", variant: "destructive" }));
    } catch (error) {
      toast({
        title: "Couldn't answer",
        description: error instanceof DOMException && error.name === "NotAllowedError"
          ? "Allow microphone access for this site, then try again."
          : "The call could not be answered here. It is still ringing on forwarded phones.",
        variant: "destructive",
      });
    }
  };

  const decline = () => {
    // Declining here only stops this browser ringing; phones keep ringing.
    try { incoming?.reject(); } catch { /* already gone */ }
    setIncoming(null);
  };

  const hangUp = () => {
    try { active?.disconnect(); } catch { /* already gone */ }
    endCallState();
  };

  const toggleMute = () => {
    if (!active) return;
    active.mute(!muted);
    setMuted(!muted);
  };

  const sendDigit = (digit: string) => {
    try { active?.sendDigits(digit); } catch { /* not connected */ }
  };

  const incomingCaller = incoming ? callerOf(incoming) : null;
  const activeCaller = active ? callerOf(active) : null;
  const dot = { off: "bg-gray-400", connecting: "bg-amber-400", ready: "bg-emerald-500", unavailable: "bg-red-500" }[status];
  const statusText = {
    off: "Calls ring your forwarded phone only.",
    connecting: "Connecting the app phone…",
    ready: "Ready: business-line calls ring here and on your phone.",
    unavailable: "The app phone isn't available.",
  }[status];

  return (
    <>
      {/* Incoming call */}
      {incoming && incomingCaller && (
        <div
          role="alertdialog"
          aria-live="assertive"
          aria-label={`Incoming call from ${formatUsPhone(incomingCaller.number, incomingCaller.number)}`}
          className="fixed left-1/2 top-4 z-[90] w-[min(92vw,22rem)] -translate-x-1/2 rounded-xl border bg-white p-4 shadow-2xl"
          data-testid="app-phone-incoming"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 animate-pulse items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
              <PhoneIncoming className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Incoming call</p>
              <p className="truncate text-lg font-semibold">{formatUsPhone(incomingCaller.number, incomingCaller.number)}</p>
              {incomingCaller.line && <p className="text-xs text-muted-foreground">to {formatUsPhone(incomingCaller.line, incomingCaller.line)}</p>}
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" onClick={decline} data-testid="app-phone-decline">
              <PhoneOff className="mr-1.5 h-4 w-4" /> Decline
            </Button>
            <Button type="button" className="bg-emerald-600 text-white hover:bg-emerald-700" onClick={answer} autoFocus data-testid="app-phone-answer">
              <Phone className="mr-1.5 h-4 w-4" /> Answer
            </Button>
          </div>
        </div>
      )}

      {/* Active call */}
      {active && activeCaller && (
        <div
          role="region"
          aria-label="Call in progress"
          className="fixed left-1/2 top-4 z-[90] w-[min(92vw,22rem)] -translate-x-1/2 rounded-xl border bg-gray-950 p-4 text-white shadow-2xl"
          data-testid="app-phone-active"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wide text-emerald-300">On a call · {elapsed}</p>
              <p className="truncate text-lg font-semibold">{formatUsPhone(activeCaller.number, activeCaller.number)}</p>
            </div>
            <Button type="button" variant="destructive" onClick={hangUp} aria-label="Hang up" data-testid="app-phone-hangup">
              <PhoneOff className="h-4 w-4" />
            </Button>
          </div>
          <div className="mt-3 flex gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={toggleMute} aria-pressed={muted}>
              {muted ? <MicOff className="mr-1.5 h-4 w-4" /> : <Mic className="mr-1.5 h-4 w-4" />}
              {muted ? "Unmute" : "Mute"}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setShowKeypad((v) => !v)} aria-pressed={showKeypad}>
              <Grid3x3 className="mr-1.5 h-4 w-4" /> Keypad
            </Button>
          </div>
          {showKeypad && (
            <div className="mt-3 grid grid-cols-3 gap-2" aria-label="Keypad">
              {KEYPAD.map((digit) => (
                <Button key={digit} type="button" variant="secondary" onClick={() => sendDigit(digit)} aria-label={`Send ${digit}`}>
                  {digit}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Phone button + panel */}
      <div className="fixed bottom-4 left-4 z-40 lg:left-[17rem]">
        {panelOpen && (
          <div
            role="dialog"
            aria-label="Phone"
            className="mb-2 w-[min(92vw,20rem)] rounded-xl border bg-white p-4 shadow-xl"
            data-testid="app-phone-panel"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Phone</h2>
              <Button type="button" variant="ghost" size="sm" onClick={() => setPanelOpen(false)} aria-label="Close phone panel">
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
              <div>
                <Label htmlFor="app-phone-ring" className="text-sm font-medium">Ring me in the app</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  <span className={cn("mr-1.5 inline-block h-2 w-2 rounded-full align-middle", dot)} aria-hidden="true" />
                  {statusText}
                </p>
                {statusDetail && <p className="mt-1 text-xs text-red-700" role="alert">{statusDetail}</p>}
              </div>
              <Switch
                id="app-phone-ring"
                checked={ringInApp}
                disabled={setting.isLoading || save.isPending}
                onCheckedChange={(checked) => {
                  save.mutate(checked);
                  if (checked && typeof Notification !== "undefined" && Notification.permission === "default") {
                    void Notification.requestPermission().catch(() => undefined);
                  }
                }}
                data-testid="app-phone-ring-toggle"
              />
            </div>

            <div className="mt-4 space-y-2">
              <Label htmlFor="app-phone-dial" className="text-sm font-medium">Call a number</Label>
              <div className="flex gap-2">
                <Input
                  id="app-phone-dial"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="(954) 555-0100"
                  value={dialNumber}
                  onChange={(event) => setDialNumber(event.target.value)}
                />
                {dialNumber.trim() && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setDialNumber("")} aria-label="Clear number">
                    <Delete className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {dialNumber.replace(/\D/g, "").length >= 10 ? (
                <CallViaCsdButtonView phone={dialNumber} label={formatUsPhone(dialNumber, dialNumber)} size="default" />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Talk through this device or have your phone ring first. The customer sees the business number.
                </p>
              )}
            </div>
          </div>
        )}
        <Button
          type="button"
          onClick={() => setPanelOpen((open) => !open)}
          className="h-11 rounded-full bg-gray-900 px-4 text-white shadow-lg hover:bg-gray-800"
          aria-expanded={panelOpen}
          aria-label={`Phone (${statusText})`}
          data-testid="app-phone-button"
        >
          <PhoneCall className="mr-2 h-4 w-4" />
          Phone
          <span className={cn("ml-2 h-2 w-2 rounded-full", dot)} aria-hidden="true" />
        </Button>
      </div>
    </>
  );
}
