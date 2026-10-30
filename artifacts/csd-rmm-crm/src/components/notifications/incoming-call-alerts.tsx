import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PhoneIncoming, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { apiRequest } from "@/lib/queryClient";

type RingStatus = { ringing: Array<{ id: string }>; checkedAt: string };
const endpoint = `${import.meta.env.BASE_URL}api/twilio/ringing-calls`;

type IncomingCallAccess = {
  userId: string | null | undefined;
  isSignedIn: boolean;
  approvalStatus: string | undefined;
  canCommunicate: boolean;
};

export function canUseIncomingCallAlerts(access: IncomingCallAccess) {
  return Boolean(access.isSignedIn && access.userId
    && access.approvalStatus === "approved" && access.canCommunicate);
}

function playRing(context: AudioContext) {
  // A short two-tone ring with a bounded envelope; no downloaded audio asset.
  for (const offset of [0, 0.55]) {
    for (const frequency of [440, 480]) {
      const tone = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + offset;
      tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.1, start + 0.02);
      gain.gain.setValueAtTime(0.1, start + 0.3);
      gain.gain.linearRampToValueAtTime(0, start + 0.35);
      tone.connect(gain);
      gain.connect(context.destination);
      tone.start(start);
      tone.stop(start + 0.36);
      tone.onended = () => { tone.disconnect(); gain.disconnect(); };
    }
  }
}

/** Audible notification only. Voice is still answered on the forwarded phone. */
export default function IncomingCallAlerts() {
  const { userId, isSignedIn } = useAuth();
  const { can, approvalStatus } = useAdminAccess();
  return <IncomingCallAlertsSession
    userId={userId}
    allowed={canUseIncomingCallAlerts({
      userId, isSignedIn: Boolean(isSignedIn), approvalStatus, canCommunicate: can("communications"),
    })}
  />;
}

/** Session boundary keeps the alert behavior independently browser-testable. */
export function IncomingCallAlertsSession({
  userId,
  allowed,
}: {
  userId: string | null | undefined;
  allowed: boolean;
}) {
  const queryClient = useQueryClient();
  const context = useRef<AudioContext | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [soundError, setSoundError] = useState("");
  const [silenced, setSilenced] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const status = useQuery<RingStatus>({
    queryKey: ["incoming-call-alerts", userId],
    queryFn: async ({ signal }) => (await apiRequest("GET", endpoint, undefined, { signal })).json(),
    enabled: allowed,
    refetchInterval: 3000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    staleTime: 0,
    retry: false,
  });
  useEffect(() => {
    if (allowed) return;
    const queryKey = ["incoming-call-alerts", userId];
    void queryClient.cancelQueries({ queryKey, exact: true });
    queryClient.removeQueries({ queryKey, exact: true });
  }, [allowed, queryClient, userId]);
  useEffect(() => {
    if (!allowed) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [allowed]);
  useEffect(() => {
    setSoundEnabled(false);
    setSoundError("");
    setSilenced(new Set());
    return () => { void context.current?.close(); context.current = null; };
  }, [userId, allowed]);

  // Never keep sounding an old call if the connection fails or the tab sleeps.
  const fresh = !status.isError && Boolean(status.data)
    && now - status.dataUpdatedAt < 8000;
  const ringing = allowed && fresh ? status.data!.ringing : [];
  const audible = soundEnabled && ringing.some(call => !silenced.has(call.id));
  useEffect(() => {
    if (!audible || !context.current) return;
    const ring = () => {
      if (context.current?.state !== "running") {
        setSoundEnabled(false);
        setSoundError("Sound was paused by your browser. Enable it again.");
        return;
      }
      playRing(context.current);
    };
    ring();
    const timer = window.setInterval(ring, 3000);
    return () => window.clearInterval(timer);
  }, [audible]);

  const enable = async () => {
    try {
      const audio = context.current ?? new AudioContext();
      context.current = audio;
      await audio.resume();
      if (audio.state !== "running") throw new Error("Sound is blocked");
      setSoundEnabled(true);
      setSoundError("");
      playRing(audio);
    } catch {
      setSoundEnabled(false);
      setSoundError("Your browser blocked sound. Allow audio for this site, then try again.");
    }
  };
  if (!allowed) return null;
  return <section aria-label="Incoming call alerts" className={`border-b px-4 py-2 ${ringing.length ? "bg-red-50 border-red-300" : "bg-white"}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2 text-sm" role="status" aria-live="polite">
        <PhoneIncoming className={`h-4 w-4 shrink-0 ${ringing.length ? "text-red-700" : "text-muted-foreground"}`} />
        <span>{ringing.length ? <><strong>Incoming CSD call — phones ringing.</strong> Answer your phone and press 1.</>
          : status.isError ? "Live call alerts unavailable. Saved phones still forward independently."
          : status.isPending ? "Connecting call alerts…"
          : !fresh ? "Reconnecting call alerts…"
          : soundEnabled ? "Call sound enabled · keep this app open"
          : "Incoming call sound is off — enable it on this device."}</span>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {ringing.length > 0 && <Button size="sm" variant="outline" onClick={() => {
          setSilenced(current => new Set([...current, ...ringing.map(call => call.id)]));
        }}>Silence this call</Button>}
        {soundEnabled && <Button size="sm" variant="ghost" onClick={() => { setSoundEnabled(false); void context.current?.suspend(); }}><VolumeX className="mr-1 h-4 w-4" />Mute</Button>}
        <Button size="sm" variant="outline" onClick={() => void enable()}><Volume2 className="mr-1 h-4 w-4" />{soundEnabled ? "Test sound" : "Enable call sound"}</Button>
      </div>
    </div>
    {soundError && <p role="alert" className="mt-1 text-sm text-red-700">{soundError}</p>}
    {ringing.length > 0 && <p className="mt-1 text-xs text-muted-foreground">This is an alert, not a browser phone. Ringing ends automatically when the forwarded leg is answered or stops ringing.</p>}
  </section>;
}
