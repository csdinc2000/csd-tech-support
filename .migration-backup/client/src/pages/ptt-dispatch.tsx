import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleStop,
  Headphones,
  Loader2,
  Mic,
  MicOff,
  Radio,
  RadioTower,
  ShieldCheck,
  Signal,
  Users,
  Volume2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { decodeMulaw, encodeMulaw, resamplePcm } from "@shared/roip-audio";

type Channel = {
  id: string;
  name: string;
  description: string;
};

type Participant = {
  id: string;
  name: string;
  email?: string;
  isTalking?: boolean;
};

type PttSession = {
  token: string;
  channels: Channel[];
  roip: {
    configured: boolean;
    enabled: boolean;
    connected: boolean;
    live: boolean;
    lastSeen: string | null;
    channelId: string;
    singleInstanceRequired: boolean;
    websocketPath: string;
    protocol: string;
  };
};

type SignalPayload = {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

const DEFAULT_CHANNELS: Channel[] = [
  { id: "dispatch", name: "Dispatch", description: "Primary service desk and field coordination" },
  { id: "field", name: "Field Technicians", description: "Technician-to-technician coordination" },
  { id: "priority", name: "Priority Response", description: "Urgent incidents and escalation traffic" },
];

export default function PttDispatch() {
  const [session, setSession] = useState<PttSession | null>(null);
  const [channels, setChannels] = useState<Channel[]>(DEFAULT_CHANNELS);
  const [selectedChannel, setSelectedChannel] = useState("dispatch");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [clientId, setClientId] = useState("");
  const [operatorName, setOperatorName] = useState("Operator");
  const [floorHolder, setFloorHolder] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [status, setStatus] = useState("Connecting to IP voice network…");
  const [error, setError] = useState("");
  const [gateway, setGateway] = useState<PttSession["roip"] | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const clientIdRef = useRef("");
  const channelRef = useRef(selectedChannel);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const pendingCandidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const audioRef = useRef(new Map<string, HTMLAudioElement>());
  const pressRef = useRef(false);
  const floorGrantedRef = useRef(false);
  const captureContextRef = useRef<AudioContext | null>(null);
  const captureProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const playbackTimeRef = useRef(0);
  const roipPacketRef = useRef(new Uint8Array());

  const send = useCallback((payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }, []);

  const removePeer = useCallback((remoteId: string) => {
    peersRef.current.get(remoteId)?.close();
    peersRef.current.delete(remoteId);
    pendingCandidatesRef.current.delete(remoteId);
    const audio = audioRef.current.get(remoteId);
    audio?.remove();
    audioRef.current.delete(remoteId);
  }, []);

  const clearPeers = useCallback(() => {
    for (const remoteId of Array.from(peersRef.current.keys())) removePeer(remoteId);
  }, [removePeer]);

  const createPeer = useCallback(
    (remoteId: string, initiator: boolean) => {
      const existing = peersRef.current.get(remoteId);
      if (existing) return existing;

      const peer = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      peersRef.current.set(remoteId, peer);

      const stream = localStreamRef.current;
      stream?.getTracks().forEach((track) => peer.addTrack(track, stream));

      peer.onicecandidate = (event) => {
        if (event.candidate) {
          send({
            type: "signal",
            to: remoteId,
            payload: { candidate: event.candidate.toJSON() },
          });
        }
      };

      peer.ontrack = (event) => {
        let audio = audioRef.current.get(remoteId);
        if (!audio) {
          audio = document.createElement("audio");
          audio.autoplay = true;
          audio.setAttribute("aria-hidden", "true");
          audio.style.display = "none";
          document.body.appendChild(audio);
          audioRef.current.set(remoteId, audio);
        }
        audio.srcObject = event.streams[0];
        void audio.play().catch(() => {
          setStatus("Audio is ready; click the page once to enable playback.");
        });
      };

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed" || peer.connectionState === "closed") {
          removePeer(remoteId);
        }
      };

      if (initiator) {
        void peer.createOffer()
          .then((offer: RTCSessionDescriptionInit) => peer.setLocalDescription(offer))
          .then(() => {
            if (peer.localDescription) {
              send({
                type: "signal",
                to: remoteId,
                payload: { description: peer.localDescription.toJSON() },
              });
            }
          })
          .catch(() => removePeer(remoteId));
      }

      return peer;
    },
    [removePeer, send],
  );

  const negotiatePeersWithMicrophone = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    for (const [remoteId, peer] of Array.from(peersRef.current.entries())) {
      const hasAudioSender = peer.getSenders().some((sender: RTCRtpSender) => sender.track?.kind === "audio");
      if (!hasAudioSender) {
        stream.getTracks().forEach((track) => peer.addTrack(track, stream));
        void peer.createOffer()
          .then((offer: RTCSessionDescriptionInit) => peer.setLocalDescription(offer))
          .then(() => {
            if (peer.localDescription) {
              send({
                type: "signal",
                to: remoteId,
                payload: { description: peer.localDescription.toJSON() },
              });
            }
          })
          .catch(() => undefined);
      }
    }
  }, [send]);

  const ensureMicrophone = useCallback(async () => {
    if (localStreamRef.current) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser does not provide microphone access.");
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      localStreamRef.current = stream;
      setMicReady(true);
      negotiatePeersWithMicrophone();
      return true;
    } catch {
      setError("Microphone permission was not granted. Allow microphone access to transmit.");
      return false;
    }
  }, [negotiatePeersWithMicrophone]);

  const setMicrophoneEnabled = useCallback((enabled: boolean) => {
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }, []);

  const ensureRoipCapture = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream || captureContextRef.current) return;
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(1024, 1, 1);
    const silent = context.createGain();
    silent.gain.value = 0;
    processor.onaudioprocess = (event) => {
      if (!floorGrantedRef.current || channelRef.current !== "dispatch") return;
      const pcm = resamplePcm(event.inputBuffer.getChannelData(0), context.sampleRate, 8000);
      const encoded = encodeMulaw(pcm);
      const pending = new Uint8Array(roipPacketRef.current.length + encoded.length);
      pending.set(roipPacketRef.current);
      pending.set(encoded, roipPacketRef.current.length);
      let offset = 0;
      while (pending.length - offset >= 160) {
        let binary = "";
        for (let i = 0; i < 160; i++) binary += String.fromCharCode(pending[offset + i]);
        send({ type: "roip-media", protocol: "CSD-RoIP/1", channelId: "dispatch", payload: btoa(binary) });
        offset += 160;
      }
      roipPacketRef.current = pending.slice(offset);
    };
    source.connect(processor);
    processor.connect(silent);
    silent.connect(context.destination);
    captureContextRef.current = context;
    captureProcessorRef.current = processor;
    void context.resume();
  }, [send]);

  const playRoipAudio = useCallback((payload: string) => {
    let encoded: Uint8Array;
    try {
      const binary = atob(payload);
      encoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
      return;
    }
    const decoded = decodeMulaw(encoded);
    let context = playbackContextRef.current;
    if (!context) {
      context = new AudioContext({ sampleRate: 8000 });
      playbackContextRef.current = context;
    }
    if (context.state === "suspended") {
      void context.resume().catch(() => setStatus("Click the page once to enable radio audio."));
    }
    const buffer = context.createBuffer(1, decoded.length, 8000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < decoded.length; i++) channel[i] = decoded[i] / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    if (playbackTimeRef.current - context.currentTime > 0.5) playbackTimeRef.current = context.currentTime;
    const startAt = Math.max(context.currentTime + 0.02, playbackTimeRef.current);
    source.start(startAt);
    playbackTimeRef.current = startAt + buffer.duration;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;

    const connect = async () => {
      try {
        const response = await fetch("/api/ptt/session");
        if (!response.ok) throw new Error("Authentication required");
        const data = (await response.json()) as PttSession;
        if (cancelled) return;
        setSession(data);
        setGateway(data.roip);
        setChannels(data.channels?.length ? data.channels : DEFAULT_CHANNELS);

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(`${protocol}//${window.location.host}/ws/ptt?token=${encodeURIComponent(data.token)}`);
        socketRef.current = socket;

        socket.onopen = () => {
          setConnected(true);
          setStatus("Connected · select a channel to monitor");
        };
        socket.onclose = () => {
          setConnected(false);
          setFloorHolder(null);
          setParticipants([]);
          floorGrantedRef.current = false;
          setMicrophoneEnabled(false);
          setStatus("Voice network disconnected. Refresh to reconnect.");
        };
        socket.onerror = () => setError("Unable to connect to the PTT voice network.");
        socket.onmessage = async (event) => {
          let message: {
            type?: string;
            clientId?: string;
            operator?: { name?: string };
            users?: Participant[];
            floorHolder?: string | null;
            user?: Participant;
            from?: string;
            payload?: SignalPayload | string;
            action?: string;
            userName?: string;
            requesterId?: string;
            reason?: string;
            protocol?: string;
            codec?: string;
            channelId?: string;
            gateway?: Partial<PttSession["roip"]>;
          };
          try {
            message = JSON.parse(String(event.data));
          } catch {
            return;
          }

          if (message.type === "hello") {
            clientIdRef.current = message.clientId || "";
            setClientId(message.clientId || "");
            setOperatorName(message.operator?.name || "Operator");
            send({ type: "join", channelId: channelRef.current });
            return;
          }

          if (message.type === "channel-state") {
            setParticipants(message.users || []);
            setFloorHolder(message.floorHolder || null);
            for (const user of message.users || []) {
              if (user.id !== clientIdRef.current) {
                createPeer(user.id, clientIdRef.current < user.id);
              }
            }
            return;
          }

          if (message.type === "user-joined" && message.user) {
            setParticipants((current) => [...current.filter((user) => user.id !== message.user?.id), message.user!]);
            if (message.user.id !== clientIdRef.current) createPeer(message.user.id, true);
            return;
          }

          if (message.type === "user-left" && message.clientId) {
            setParticipants((current) => current.filter((user) => user.id !== message.clientId));
            removePeer(message.clientId);
            return;
          }

          if (message.type === "floor") {
            setFloorHolder(message.action === "released" ? null : message.clientId || null);
            setParticipants((current) =>
              current.map((user) => ({ ...user, isTalking: message.action === "granted" && user.id === message.clientId })),
            );
            if (message.action === "granted" && message.clientId === clientIdRef.current) {
              floorGrantedRef.current = true;
              setMicrophoneEnabled(true);
              ensureRoipCapture();
              setStatus(`Transmitting on ${channelRef.current}`);
            } else if (message.action === "released" && message.clientId === clientIdRef.current) {
              floorGrantedRef.current = false;
              setMicrophoneEnabled(false);
              setStatus("Channel clear · release the button to listen");
            }
            if (message.action === "denied" && message.requesterId === clientIdRef.current) {
              setPressed(false);
              pressRef.current = false;
              floorGrantedRef.current = false;
              setMicrophoneEnabled(false);
              setError(`${message.reason || "Channel is busy."} ${message.userName ? `${message.userName} has the floor.` : ""}`);
            }
            return;
          }

          if (message.type === "gateway-status" && message.gateway) {
            setGateway((current) => current ? { ...current, ...message.gateway } : current);
            return;
          }

          if (
            message.type === "roip-media" &&
            message.protocol === "CSD-RoIP/1" &&
            message.codec === "PCMU" &&
            message.channelId === "dispatch" &&
            typeof message.payload === "string"
          ) {
            playRoipAudio(message.payload);
            return;
          }

          if (message.type === "signal" && message.from && message.payload && typeof message.payload === "object") {
            const peer = createPeer(message.from, false);
            if (message.payload.description) {
              await peer.setRemoteDescription(message.payload.description);
              const pending = pendingCandidatesRef.current.get(message.from) || [];
              for (const candidate of pending) await peer.addIceCandidate(candidate).catch(() => undefined);
              pendingCandidatesRef.current.delete(message.from);
              if (message.payload.description.type === "offer") {
                const answer = await peer.createAnswer();
                await peer.setLocalDescription(answer);
                if (peer.localDescription) {
                  send({
                    type: "signal",
                    to: message.from,
                    payload: { description: peer.localDescription.toJSON() },
                  });
                }
              }
            }
            if (message.payload.candidate) {
              if (peer.remoteDescription) {
                await peer.addIceCandidate(message.payload.candidate).catch(() => undefined);
              } else {
                const pending = pendingCandidatesRef.current.get(message.from) || [];
                pending.push(message.payload.candidate);
                pendingCandidatesRef.current.set(message.from, pending);
              }
            }
          }
        };
      } catch {
        if (!cancelled) {
          setStatus("Sign in to open the PTT dispatch console.");
          setError("PTT dispatch requires an authenticated operator session.");
        }
      }
    };

    void connect();
    return () => {
      cancelled = true;
      socket?.close();
      socketRef.current = null;
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      floorGrantedRef.current = false;
      roipPacketRef.current = new Uint8Array();
      captureProcessorRef.current?.disconnect();
      captureProcessorRef.current = null;
      void captureContextRef.current?.close();
      captureContextRef.current = null;
      void playbackContextRef.current?.close();
      playbackContextRef.current = null;
      clearPeers();
      for (const audio of Array.from(audioRef.current.values())) audio.remove();
      audioRef.current.clear();
    };
  }, [clearPeers, createPeer, ensureRoipCapture, playRoipAudio, removePeer, send, setMicrophoneEnabled]);

  const selected = useMemo(
    () => channels.find((channel) => channel.id === selectedChannel) || channels[0] || DEFAULT_CHANNELS[0],
    [channels, selectedChannel],
  );
  const currentTalker = participants.find((user) => user.id === floorHolder);

  const changeChannel = (channelId: string) => {
    if (channelId === selectedChannel) return;
    pressRef.current = false;
    setPressed(false);
    setMicrophoneEnabled(false);
    floorGrantedRef.current = false;
    roipPacketRef.current = new Uint8Array();
    clearPeers();
    setParticipants([]);
    setFloorHolder(null);
    setSelectedChannel(channelId);
    channelRef.current = channelId;
    send({ type: "join", channelId });
    setStatus("Joining channel…");
  };

  const beginTransmit = async () => {
    if (pressRef.current || !connected) return;
    pressRef.current = true;
    setPressed(true);
    setError("");
    const ready = await ensureMicrophone();
    if (!ready || !pressRef.current) {
      pressRef.current = false;
      setPressed(false);
      return;
    }
    send({ type: "floor-request", channelId: channelRef.current });
  };

  const endTransmit = () => {
    if (!pressRef.current) return;
    pressRef.current = false;
    setPressed(false);
    setMicrophoneEnabled(false);
    floorGrantedRef.current = false;
    roipPacketRef.current = new Uint8Array();
    send({ type: "floor-release", channelId: channelRef.current });
    setStatus("Channel clear · release the button to listen");
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950 p-4 text-slate-100 md:p-6" data-testid="page-ptt-dispatch">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-400">
              <Radio className="h-4 w-4" />
              IP voice network
            </div>
            <h1 className="text-3xl font-bold tracking-tight">PTT Dispatch</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Sub-second team voice over LTE, 5G, or Wi-Fi. Hold the transmit key to speak; release it to listen.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Badge className={cn("border px-3 py-1", connected ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : "border-amber-400/30 bg-amber-400/10 text-amber-300")}>
              {connected ? <Wifi className="mr-1.5 h-3.5 w-3.5" /> : <WifiOff className="mr-1.5 h-3.5 w-3.5" />}
              {connected ? "Voice network online" : "Connecting"}
            </Badge>
            <span className="text-sm text-slate-400">{operatorName}</span>
          </div>
        </header>

        {error && (
          <div className="flex items-start justify-between gap-4 rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
            <span>{error}</span>
            <Button variant="ghost" size="sm" className="h-6 text-rose-200 hover:bg-rose-400/10 hover:text-white" onClick={() => setError("")}>Dismiss</Button>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)_300px]">
          <Card className="border-slate-800 bg-slate-900 text-slate-100">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-sm">
                <span>Talk groups</span>
                <Badge variant="outline" className="border-slate-700 text-slate-400">{channels.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {channels.map((channel) => {
                const active = channel.id === selectedChannel;
                return (
                  <button
                    key={channel.id}
                    type="button"
                    onClick={() => changeChannel(channel.id)}
                    className={cn(
                      "w-full rounded-lg border p-3 text-left transition",
                      active ? "border-cyan-400/50 bg-cyan-400/10" : "border-slate-800 bg-slate-950/40 hover:border-slate-700",
                    )}
                    data-testid={`ptt-channel-${channel.id}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn("font-semibold", active ? "text-cyan-200" : "text-slate-200")}>{channel.name}</span>
                      {active && <Signal className="h-4 w-4 text-cyan-400" />}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-slate-500">{channel.description}</p>
                    <p className="mt-2 flex items-center gap-1 text-xs text-slate-400"><Users className="h-3.5 w-3.5" /> {active ? participants.length : "—"} online</p>
                  </button>
                );
              })}
              <div className="mt-4 rounded-lg border border-dashed border-slate-700 p-3 text-xs leading-5 text-slate-500">
                Channel access is controlled by the authenticated CSD operator session.
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-800 bg-slate-900 text-slate-100">
            <CardHeader className="flex flex-row items-start justify-between space-y-0">
              <div>
                <CardTitle className="text-xl">{selected.name}</CardTitle>
                <p className="mt-1 text-sm text-slate-400">{status}</p>
              </div>
              <Badge variant="outline" className="border-slate-700 text-slate-400">
                {micReady ? <Mic className="mr-1.5 h-3.5 w-3.5 text-emerald-400" /> : <MicOff className="mr-1.5 h-3.5 w-3.5" />}
                {micReady ? "Mic ready" : "Mic on demand"}
              </Badge>
            </CardHeader>
            <CardContent className="flex min-h-[460px] flex-col items-center justify-center">
              <div className="mb-8 text-center">
                <div className="mb-2 flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                  <Volume2 className="h-4 w-4" />
                  {currentTalker ? `${currentTalker.name} has the floor` : "Channel clear"}
                </div>
                <p className="text-sm text-slate-400">{pressed ? "Transmitting — release to listen" : "Press and hold to transmit"}</p>
              </div>
              <button
                type="button"
                aria-label={`Press and hold to talk on ${selected.name}`}
                disabled={!connected}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  void beginTransmit();
                }}
                onPointerUp={endTransmit}
                onPointerCancel={endTransmit}
                onPointerLeave={endTransmit}
                onKeyDown={(event) => {
                  if (event.code === "Space" || event.code === "Enter") {
                    event.preventDefault();
                    void beginTransmit();
                  }
                }}
                onKeyUp={(event) => {
                  if (event.code === "Space" || event.code === "Enter") {
                    event.preventDefault();
                    endTransmit();
                  }
                }}
                onContextMenu={(event) => event.preventDefault()}
                className={cn(
                  "group relative flex h-56 w-56 select-none flex-col items-center justify-center rounded-full border-8 shadow-2xl transition-all focus:outline-none focus:ring-4 focus:ring-cyan-400/40 disabled:cursor-not-allowed disabled:opacity-50",
                  pressed
                    ? "border-rose-300 bg-rose-500 text-white shadow-rose-500/30"
                    : floorHolder
                      ? "border-amber-400/60 bg-amber-400/10 text-amber-200 shadow-amber-500/10"
                      : "border-cyan-400/60 bg-cyan-400/10 text-cyan-100 shadow-cyan-500/20 hover:scale-[1.02] hover:bg-cyan-400/20",
                )}
                data-testid="ptt-transmit-button"
              >
                {pressed ? <CircleStop className="mb-2 h-10 w-10" /> : <RadioTower className="mb-2 h-10 w-10" />}
                <span className="text-2xl font-black tracking-[0.16em]">{pressed ? "LIVE" : "TALK"}</span>
                <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] opacity-70">hold to transmit</span>
              </button>
              <p className="mt-8 flex items-center gap-2 text-xs text-slate-500">
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                Floor control prevents overlapping transmissions
              </p>
            </CardContent>
          </Card>

          <div className="space-y-5">
            <Card className="border-slate-800 bg-slate-900 text-slate-100">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm"><Users className="h-4 w-4 text-cyan-400" /> On this channel</CardTitle>
              </CardHeader>
              <CardContent>
                {participants.length === 0 ? (
                  <div className="py-8 text-center text-sm text-slate-500">No other operators are monitoring this channel.</div>
                ) : (
                  <div className="space-y-3">
                    {participants.map((participant) => (
                      <div key={participant.id} className="flex items-center gap-3">
                        <div className={cn("flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold", participant.isTalking ? "bg-rose-400/20 text-rose-200" : "bg-slate-800 text-slate-300")}>
                          {participant.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{participant.id === clientId ? `${participant.name} (you)` : participant.name}</p>
                          <p className="text-xs text-slate-500">{participant.isTalking ? "Transmitting" : "Monitoring"}</p>
                        </div>
                        {participant.isTalking ? <Radio className="h-4 w-4 animate-pulse text-rose-400" /> : <Headphones className="h-4 w-4 text-slate-600" />}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-800 bg-slate-900 text-slate-100">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm"><RadioTower className="h-4 w-4 text-cyan-400" /> RoIP gateway bridge</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-start gap-3">
                   <div className={cn("mt-0.5 rounded-full p-2", gateway?.connected ? "bg-emerald-400/10 text-emerald-400" : "bg-slate-800 text-slate-500")}>
                     {gateway?.connected ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
                  </div>
                  <div>
                     <p className="text-sm font-medium">
                       {gateway?.live ? "Gateway live" : gateway?.connected ? "Gateway connected" : gateway?.configured ? "Gateway offline" : "Gateway not configured"}
                     </p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                       {gateway?.configured
                         ? `Physical-radio audio is mapped to Dispatch.${gateway.lastSeen ? ` Last seen ${new Date(gateway.lastSeen).toLocaleString()}.` : ""}`
                        : "The secure CSD-RoIP/1 boundary is ready for a selected radio gateway."}
                    </p>
                     {gateway?.singleInstanceRequired && (
                       <p className="mt-1 text-xs text-amber-300">RoIP stays disabled until ROIP_SINGLE_INSTANCE=true; it requires one app instance.</p>
                     )}
                  </div>
                </div>
                <Separator className="my-4 bg-slate-800" />
                <p className="text-xs leading-5 text-slate-500">
                  The physical gateway must provide RTP/VOX keying for outbound radio PTT. This control center does not
                  impersonate a radio vendor or expose raw UDP.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>

        {!connected && <Loader2 className="mx-auto h-5 w-5 animate-spin text-cyan-400" />}
      </div>
    </div>
  );
}