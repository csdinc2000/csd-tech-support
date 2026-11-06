import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { PhoneCall, PhoneOff, Radio, Users, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  describeRing,
  isDirectChannel,
  PTT_JOIN_EVENT,
  pttCallPath,
  ringSecondsLeft,
  type IncomingRing,
  type IncomingRingsResponse,
  type PttJoinDetail,
} from "@/lib/ptt-ring";

const endpoint = `${import.meta.env.BASE_URL}api/ptt/pages/incoming`;

function playRing(context: AudioContext) {
  // Rising two-note chirp, distinct from the phone-line ring in incoming-call-alerts.
  [[0, 660], [0.18, 880], [0.6, 660], [0.78, 880]].forEach(([offset, frequency]) => {
    const tone = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + offset;
    tone.type = "sine";
    tone.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.12, start + 0.02);
    gain.gain.setValueAtTime(0.12, start + 0.14);
    gain.gain.linearRampToValueAtTime(0, start + 0.17);
    tone.connect(gain);
    gain.connect(context.destination);
    tone.start(start);
    tone.stop(start + 0.18);
    tone.onended = () => { tone.disconnect(); gain.disconnect(); };
  });
}

/** App-wide: rings staff who have PTT access when a colleague calls them from the PTT console. */
export default function PttRingAlerts() {
  const { userId, isSignedIn } = useAuth();
  const { can, approvalStatus } = useAdminAccess();
  const allowed = Boolean(isSignedIn && userId && approvalStatus === "approved" && can("communications"));
  return <PttRingAlertsSession userId={userId} allowed={allowed} />;
}

/** Session boundary keeps the pop-up independently browser-testable. */
export function PttRingAlertsSession({ userId, allowed }: { userId: string | null | undefined; allowed: boolean }) {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const audio = useRef<AudioContext | null>(null);
  const notified = useRef(new Set<number>());
  const [handled, setHandled] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [now, setNow] = useState(Date.now());
  const queryKey = ["ptt-ring-alerts", userId];

  const incoming = useQuery<IncomingRingsResponse>({
    queryKey,
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
    void queryClient.cancelQueries({ queryKey, exact: true });
    queryClient.removeQueries({ queryKey, exact: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, queryClient, userId]);

  // Never keep ringing on stale data (lost connection, sleeping tab).
  const fresh = !incoming.isError && Boolean(incoming.data) && now - incoming.dataUpdatedAt < 9000;
  const rings = allowed && fresh
    ? incoming.data!.rings.filter((ring) => !handled.has(ring.id)
      && ringSecondsLeft(ring, incoming.data!.serverTime, incoming.dataUpdatedAt, now) > 0)
    : [];
  const ring: IncomingRing | undefined = rings[0];
  const ringing = Boolean(ring);
  const secondsLeft = ring ? ringSecondsLeft(ring, incoming.data!.serverTime, incoming.dataUpdatedAt, now) : 0;

  useEffect(() => {
    if (!allowed) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [allowed]);

  // Sound: browsers only allow audio after the user has interacted with the
  // page, so try, and if blocked ask for one tap ("Tap to hear ringing").
  useEffect(() => {
    if (!ringing) return;
    let stopped = false;
    const sound = async () => {
      try {
        const context = audio.current ?? new AudioContext();
        audio.current = context;
        if (context.state !== "running") await context.resume();
        if (stopped) return;
        if (context.state !== "running") { setSoundBlocked(true); return; }
        setSoundBlocked(false);
        playRing(context);
      } catch {
        setSoundBlocked(true);
      }
    };
    void sound();
    const timer = window.setInterval(() => void sound(), 2500);
    navigator.vibrate?.([300, 150, 300]);
    return () => { stopped = true; window.clearInterval(timer); navigator.vibrate?.(0); };
  }, [ringing]);

  useEffect(() => () => { void audio.current?.close(); audio.current = null; }, []);

  // A system notification so a ring is noticed while the app is in a background tab.
  useEffect(() => {
    if (!ring || notified.current.has(ring.id)) return;
    notified.current.add(ring.id);
    if (typeof Notification === "undefined" || Notification.permission !== "granted" || document.visibilityState === "visible") return;
    try {
      const note = new Notification(`${ring.callerName} is calling on PTT`, {
        body: `${describeRing(ring)} · open the app to answer`,
        tag: `ptt-ring-${ring.id}`,
        requireInteraction: true,
      });
      note.onclick = () => { window.focus(); note.close(); };
    } catch {
      // Some browsers only allow notifications from a service worker; the pop-up still shows.
    }
  }, [ring]);

  const respond = async (action: "answer" | "decline") => {
    if (!ring || busy) return;
    setBusy(true);
    setHandled((current) => new Set([...current, ring.id]));
    try {
      const response = await apiRequest("POST", `${import.meta.env.BASE_URL}api/ptt/pages/${ring.id}/respond`, { action });
      const result = (await response.json()) as { channelId: string };
      if (action === "answer") {
        const label = isDirectChannel(result.channelId) ? ring.callerName : undefined;
        // An already-open console switches in place; otherwise it opens from the URL.
        window.dispatchEvent(new CustomEvent<PttJoinDetail>(PTT_JOIN_EVENT, { detail: { channelId: result.channelId, label } }));
        navigate(pttCallPath(result.channelId, label));
      }
    } catch {
      toast({ title: "Call ended", description: `${ring.callerName} is no longer ringing you.` });
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey, exact: true });
    }
  };

  const enableSound = async () => {
    try {
      const context = audio.current ?? new AudioContext();
      audio.current = context;
      await context.resume();
      if (context.state === "running") { setSoundBlocked(false); playRing(context); }
    } catch {
      setSoundBlocked(true);
    }
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => undefined);
    }
  };

  if (!ring) return null;
  const direct = isDirectChannel(ring.channelId);
  const initials = ring.callerName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" data-testid="ptt-ring-overlay">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ptt-ring-title"
        aria-describedby="ptt-ring-description"
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 text-zinc-100 shadow-2xl"
        data-testid="ptt-ring-popup"
      >
        <div className="flex flex-col items-center gap-3 px-6 pb-5 pt-7 text-center">
          <div className="relative">
            <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/40" aria-hidden />
            <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-emerald-600 text-2xl font-bold">
              {initials || <Radio className="h-8 w-8" />}
            </div>
          </div>
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-emerald-400">
            {direct ? <PhoneCall className="h-3.5 w-3.5" /> : <Users className="h-3.5 w-3.5" />}
            {describeRing(ring)}
          </p>
          <h2 id="ptt-ring-title" className="text-xl font-semibold" data-testid="ptt-ring-caller">{ring.callerName}</h2>
          <p id="ptt-ring-description" className="text-sm text-zinc-400">
            {direct
              ? "wants to talk with you on PTT. Answer to open a private call."
              : `is calling all staff on PTT. Answer to join ${ring.channelName}.`}
          </p>
          <p className="text-xs text-zinc-500" aria-live="polite">Rings for {secondsLeft}s more</p>
          {rings.length > 1 && (
            <p className="text-xs text-amber-400" data-testid="ptt-ring-more">+{rings.length - 1} more calling you</p>
          )}
          {soundBlocked && (
            <button type="button" onClick={() => void enableSound()} className="flex items-center gap-1 text-xs text-amber-300 underline">
              <Volume2 className="h-3.5 w-3.5" /> Tap to hear ringing
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 border-t border-zinc-800 bg-zinc-900 p-4">
          <Button
            type="button"
            variant="destructive"
            className="h-12"
            disabled={busy}
            onClick={() => void respond("decline")}
            data-testid="ptt-ring-decline"
          >
            <PhoneOff className="mr-2 h-5 w-5" /> Decline
          </Button>
          <Button
            type="button"
            className="h-12 bg-emerald-600 text-white hover:bg-emerald-500"
            disabled={busy}
            onClick={() => void respond("answer")}
            data-testid="ptt-ring-answer"
            autoFocus
          >
            <PhoneCall className="mr-2 h-5 w-5" /> Answer
          </Button>
        </div>
      </div>
    </div>
  );
}
