import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Loader2,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Radio,
  RadioTower,
  ShieldCheck,
  Signal,
  TrendingUp,
  Users,
  Volume2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import { decodeMulaw, encodeMulaw, resamplePcm } from "@shared/roip-audio";
import { PttRingPanel } from "@/components/ptt/ptt-ring-panel";
import { isDirectChannel, pttRoleLabel, PTT_JOIN_EVENT, pttCallFromSearch, type PttJoinDetail } from "@/lib/ptt-ring";

type Channel = {
  id: string;
  name: string;
  description: string;
};

type Participant = {
  id: string;
  name: string;
  email?: string;
  role?: string;
  isTalking?: boolean;
};

type PttSession = {
  token: string;
  /** Server-enforced transmit ceiling; the client cap stays strictly later. */
  maxTransmitMs?: number;
  channels: Channel[];
  iceServers: RTCIceServer[];
  network: {
    relayConfigured: boolean;
    turnCredentialExpiresAt: string | null;
  };
  roip: {
    configured: boolean;
    enabled: boolean;
    connected: boolean;
    ready: boolean;
    live: boolean;
    lastSeen: string | null;
    lastMediaAt: string | null;
    disconnectReason: string | null;
    vendor: string;
    model: string;
    codec: string;
    sampleRate: number;
    physicalChannel: string;
    channelMapping: {
      physicalChannel: string;
      channelId: string;
      talkGroup: string;
    };
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

type PeerRtcStatus = {
  connectionState: RTCPeerConnectionState | "unknown";
  iceConnectionState: RTCIceConnectionState | "unknown";
  path: "relay" | "direct" | "unknown";
  candidateType?: RTCIceCandidateType;
  failureReason?: string;
};

type PeerRtcUpdate = Partial<PeerRtcStatus>;

type PeerNegotiationState = {
  makingOffer: boolean;
  pendingOffer: boolean;
  pendingIceRestart: boolean;
  ignoreOffer: boolean;
  revision: number;
  processingRemoteOffer: boolean;
};

type PttTelemetry = {
  filters: { hours: number; channelId: string | null; bucket: "hour" | "day" };
  summary: { connected: number; relay: number; failed: number; relayRate: number };
  trend: Array<{ bucket: string; connected: number; relay: number; failed: number }>;
  failureReasons: Array<{ reason: string; count: number }>;
  incidentActive: boolean;
};

/**
 * Fallback only — the server advertises its real limit in the session payload
 * and the hello frame. The client cut is deliberately late: the server is
 * authoritative, and this layer exists for the countdown and for the case where
 * a backpressured socket never delivers the server's forced release.
 */
const DEFAULT_MAX_TRANSMIT_MS = 60_000;
const CLIENT_TRANSMIT_GRACE_MS = 1_000;

const DEFAULT_CHANNELS: Channel[] = [
  { id: "dispatch", name: "Dispatch", description: "Primary service desk and field coordination" },
  { id: "field", name: "Field Technicians", description: "Technician-to-technician coordination" },
  { id: "priority", name: "Priority Response", description: "Urgent incidents and escalation traffic" },
];

export default function PttDispatch() {
  const [session, setSession] = useState<PttSession | null>(null);
  const [channels, setChannels] = useState<Channel[]>(DEFAULT_CHANNELS);
  // A ring's Answer opens /ptt?channel=…&with=… so the console starts in that call.
  const [initialCall] = useState(() => pttCallFromSearch(window.location.search));
  const [selectedChannel, setSelectedChannel] = useState(initialCall?.channelId ?? "dispatch");
  const [privateCallLabel, setPrivateCallLabel] = useState<string | undefined>(initialCall?.label);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [clientId, setClientId] = useState("");
  const [operatorName, setOperatorName] = useState("Operator");
  const [floorHolder, setFloorHolder] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [transmitSecondsLeft, setTransmitSecondsLeft] = useState<number | null>(null);
  const [status, setStatus] = useState("Connecting to IP voice network…");
  const [error, setError] = useState("");
  const [gateway, setGateway] = useState<PttSession["roip"] | null>(null);
  const [peerRtcStatuses, setPeerRtcStatuses] = useState<Record<string, PeerRtcStatus>>({});
  const [unrecoverablePeerIds, setUnrecoverablePeerIds] = useState<Set<string>>(() => new Set());
  const [retryingPeerAudio, setRetryingPeerAudio] = useState(false);
  const [telemetry, setTelemetry] = useState<PttTelemetry | null>(null);
  const [telemetryHours, setTelemetryHours] = useState(24);
  const [telemetryChannel, setTelemetryChannel] = useState("all");
  const [telemetryLoading, setTelemetryLoading] = useState(true);

  const socketRef = useRef<WebSocket | null>(null);
  const clientIdRef = useRef("");
  const channelRef = useRef(selectedChannel);
  const iceServersRef = useRef<RTCIceServer[]>([]);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const peerSendersRef = useRef(new Map<string, RTCRtpSender>());
  const peerOfferersRef = useRef(new Map<string, (iceRestart?: boolean) => Promise<void>>());
  const peerNegotiationsRef = useRef(new Map<string, PeerNegotiationState>());
  const signalQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingCandidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const rtcTelemetrySignaturesRef = useRef(new Map<string, string>());
  const peerRtcStatusesRef = useRef<Record<string, PeerRtcStatus>>({});
  const unrecoverablePeerIdsRef = useRef(new Set<string>());
  const audioRef = useRef(new Map<string, HTMLAudioElement>());
  const remoteStreamsRef = useRef(new Map<string, MediaStream>());
  const pressRef = useRef(false);
  const floorGrantedRef = useRef(false);
  const maxTransmitMsRef = useRef(DEFAULT_MAX_TRANSMIT_MS);
  const transmitStartedAtRef = useRef<number | null>(null);
  const floorHolderRef = useRef<string | null>(null);
  const gatewayReadyRef = useRef(false);
  const captureContextRef = useRef<AudioContext | null>(null);
  const captureProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const playbackTimeRef = useRef(0);
  const roipPacketRef = useRef(new Uint8Array());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const loadTelemetry = async () => {
      setTelemetryLoading(true);
      try {
        const query = new URLSearchParams({ hours: String(telemetryHours) });
        if (telemetryChannel !== "all") query.set("channelId", telemetryChannel);
        const response = await apiRequest("GET", `/api/ptt/telemetry?${query}`);
        const data = (await response.json()) as PttTelemetry;
        if (!cancelled) setTelemetry(data);
      } catch {
        if (!cancelled) setTelemetry(null);
      } finally {
        if (!cancelled) setTelemetryLoading(false);
      }
    };
    void loadTelemetry();
    const refresh = window.setInterval(loadTelemetry, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(refresh);
    };
  }, [telemetryChannel, telemetryHours]);

  const send = useCallback((payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }, []);

  const setPeerAudioUnrecoverable = useCallback((remoteId: string, unrecoverable: boolean) => {
    const current = unrecoverablePeerIdsRef.current;
    if (unrecoverable === current.has(remoteId)) return;
    const next = new Set(current);
    if (unrecoverable) next.add(remoteId);
    else next.delete(remoteId);
    unrecoverablePeerIdsRef.current = next;
    setUnrecoverablePeerIds(next);
  }, []);

  const clearUnrecoverablePeers = useCallback(() => {
    unrecoverablePeerIdsRef.current = new Set();
    setUnrecoverablePeerIds(new Set());
  }, []);

  const removePeer = useCallback((remoteId: string, expectedPeer?: RTCPeerConnection) => {
    const peer = peersRef.current.get(remoteId);
    if (expectedPeer && peer !== expectedPeer) return;
    peer?.close();
    peersRef.current.delete(remoteId);
    peerSendersRef.current.delete(remoteId);
    peerOfferersRef.current.delete(remoteId);
    peerNegotiationsRef.current.delete(remoteId);
    pendingCandidatesRef.current.delete(remoteId);
    remoteStreamsRef.current.get(remoteId)?.getTracks().forEach((track) => track.stop());
    remoteStreamsRef.current.delete(remoteId);
    const audio = audioRef.current.get(remoteId);
    if (audio) audio.srcObject = null;
    audio?.remove();
    audioRef.current.delete(remoteId);
  }, []);

  const clearPeers = useCallback(() => {
    for (const remoteId of Array.from(peersRef.current.keys())) removePeer(remoteId);
  }, [removePeer]);

  const unlockRemoteAudio = useCallback(async () => {
    const audioElements = Array.from(audioRef.current.values());
    if (audioElements.length === 0) {
      setAudioPlaybackBlocked(false);
      return;
    }
    const results = await Promise.allSettled(audioElements.map(async (audio) => {
      audio.muted = false;
      await audio.play();
    }));
    const blocked = results.some((result) => result.status === "rejected");
    setAudioPlaybackBlocked(blocked);
    if (!blocked) setError("");
  }, []);

  const reportPeerTelemetry = useCallback(
    (remoteId: string, update: PeerRtcUpdate) => {
      const current = peerRtcStatusesRef.current[remoteId];
      const failureReason =
        update.failureReason ?? (update.connectionState === "connected" ? undefined : current?.failureReason);
      const next: PeerRtcStatus = {
        connectionState: update.connectionState ?? current?.connectionState ?? "unknown",
        iceConnectionState: update.iceConnectionState ?? current?.iceConnectionState ?? "unknown",
        path: update.path ?? current?.path ?? "unknown",
        ...(update.candidateType || current?.candidateType
          ? { candidateType: update.candidateType ?? current?.candidateType }
          : {}),
        ...(failureReason ? { failureReason } : {}),
      };
      const signature = JSON.stringify(next);
      if (rtcTelemetrySignaturesRef.current.get(remoteId) === signature) return;
      rtcTelemetrySignaturesRef.current.set(remoteId, signature);
      peerRtcStatusesRef.current = { ...peerRtcStatusesRef.current, [remoteId]: next };
      setPeerRtcStatuses((statuses) => ({ ...statuses, [remoteId]: next }));
      send({
        type: "rtc-telemetry",
        remoteId,
        connectionState: next.connectionState,
        iceConnectionState: next.iceConnectionState,
        path: next.path,
        candidateType: next.candidateType,
        failureReason: next.failureReason,
      });
    },
    [send],
  );

  const inspectSelectedCandidatePair = useCallback(
    async (remoteId: string, peer: RTCPeerConnection) => {
      try {
        const stats = await peer.getStats();
        let selectedPair: RTCIceCandidatePairStats | undefined;
        stats.forEach((report) => {
          if (
            report.type === "candidate-pair" &&
            (report as RTCIceCandidatePairStats).state === "succeeded" &&
            ((report as RTCIceCandidatePairStats & { selected?: boolean }).selected ||
              (report as RTCIceCandidatePairStats).nominated)
          ) {
            selectedPair = report as RTCIceCandidatePairStats;
          }
        });
        if (!selectedPair) return;
        const localCandidate = stats.get(selectedPair.localCandidateId) as { candidateType?: RTCIceCandidateType } | undefined;
        const candidateType = localCandidate?.candidateType;
        if (!candidateType) return;
        reportPeerTelemetry(remoteId, {
          candidateType,
          path: candidateType === "relay" ? "relay" : "direct",
        });
      } catch {
        // Stats are best-effort; connection state remains useful when a
        // browser does not expose candidate-pair reports.
      }
    },
    [reportPeerTelemetry],
  );

  const createPeer = useCallback(
    (remoteId: string, initiator: boolean) => {
      const existing = peersRef.current.get(remoteId);
      if (existing) return existing;

      const peer = new RTCPeerConnection({
        iceServers: iceServersRef.current,
      });
      peersRef.current.set(remoteId, peer);
      const negotiation: PeerNegotiationState = {
        makingOffer: false,
        pendingOffer: false,
        pendingIceRestart: false,
        ignoreOffer: false,
        revision: 0,
        processingRemoteOffer: false,
      };
      peerNegotiationsRef.current.set(remoteId, negotiation);
      let restartingIce = false;

      const sendOffer = async (iceRestart = false) => {
        negotiation.pendingOffer = true;
        negotiation.pendingIceRestart ||= iceRestart;
        if (
          negotiation.makingOffer ||
          negotiation.processingRemoteOffer ||
          peer.signalingState !== "stable"
        ) return;
        const shouldRestartIce = negotiation.pendingIceRestart;
        negotiation.pendingOffer = false;
        negotiation.pendingIceRestart = false;
        negotiation.makingOffer = true;
        const offerRevision = ++negotiation.revision;
        if (shouldRestartIce) restartingIce = true;
        try {
          const offer = await peer.createOffer(shouldRestartIce ? { iceRestart: true } : undefined);
          if (
            peersRef.current.get(remoteId) !== peer ||
            negotiation.revision !== offerRevision
          ) return;
          await peer.setLocalDescription(offer);
          if (
            peersRef.current.get(remoteId) !== peer ||
            negotiation.revision !== offerRevision
          ) return;
          if (peer.localDescription) {
            send({
              type: "signal",
              to: remoteId,
            channelId: channelRef.current,
              payload: { description: peer.localDescription.toJSON() },
            });
          }
        } catch (offerError) {
          reportPeerTelemetry(remoteId, {
            failureReason: offerError instanceof Error
              ? `WebRTC offer failed: ${offerError.message}`
              : "WebRTC offer failed.",
          });
          if (peer.connectionState !== "closed" && peersRef.current.get(remoteId) === peer) {
            negotiation.pendingOffer = true;
          } else {
            removePeer(remoteId, peer);
          }
        } finally {
          negotiation.makingOffer = false;
          if (
            peersRef.current.get(remoteId) === peer &&
            negotiation.pendingOffer &&
            !negotiation.processingRemoteOffer &&
            peer.signalingState === "stable"
          ) {
            void sendOffer(negotiation.pendingIceRestart);
          }
        }
      };
      peerOfferersRef.current.set(remoteId, sendOffer);
      peer.onsignalingstatechange = () => {
        if (
          peer.signalingState === "stable" &&
          negotiation.pendingOffer &&
          !negotiation.processingRemoteOffer &&
          peersRef.current.get(remoteId) === peer
        ) {
          void sendOffer(negotiation.pendingIceRestart);
        }
      };

      const stream = localStreamRef.current;
      const audioTrack = stream?.getAudioTracks()[0];
      const audioTransceiver = peer.addTransceiver(audioTrack || "audio", {
        direction: "sendrecv",
        ...(stream ? { streams: [stream] } : {}),
      });
      peerSendersRef.current.set(remoteId, audioTransceiver.sender);

      peer.onicecandidate = (event) => {
        if (peersRef.current.get(remoteId) !== peer) return;
        if (event.candidate) {
          const candidateType = event.candidate.type;
          if (candidateType) {
            reportPeerTelemetry(remoteId, {
              candidateType,
              ...(candidateType === "relay" ? { path: "relay" } : {}),
            });
          }
          send({
            type: "signal",
            to: remoteId,
            channelId: channelRef.current,
            payload: { candidate: event.candidate.toJSON() },
          });
        }
      };

      peer.onicecandidateerror = (event) => {
        if (peersRef.current.get(remoteId) !== peer) return;
        reportPeerTelemetry(remoteId, {
          failureReason: `ICE ${event.errorCode}${event.errorText ? `: ${event.errorText}` : ""}`,
        });
      };

      peer.ontrack = (event) => {
        if (peersRef.current.get(remoteId) !== peer) return;
        let audio = audioRef.current.get(remoteId);
        if (!audio) {
          audio = document.createElement("audio");
          audio.autoplay = true;
          audio.setAttribute("playsinline", "true");
          audio.muted = false;
          audio.preload = "auto";
          audio.setAttribute("aria-hidden", "true");
          audio.style.display = "none";
          document.body.appendChild(audio);
          audioRef.current.set(remoteId, audio);
        }
        let remoteStream = remoteStreamsRef.current.get(remoteId);
        if (!remoteStream) {
          remoteStream = new MediaStream();
          remoteStreamsRef.current.set(remoteId, remoteStream);
          audio.srcObject = remoteStream;
        }
        for (const existingTrack of remoteStream.getAudioTracks()) {
          if (existingTrack.id !== event.track.id) remoteStream.removeTrack(existingTrack);
        }
        if (!remoteStream.getTracks().some((track) => track.id === event.track.id)) {
          remoteStream.addTrack(event.track);
        }
        event.track.onended = () => {
          remoteStreamsRef.current.get(remoteId)?.removeTrack(event.track);
        };
        audio.onloadedmetadata = () => {
          audio!.muted = false;
          void audio!.play().then(() => setAudioPlaybackBlocked(false)).catch(() => {
            setAudioPlaybackBlocked(true);
          });
        };
        void audio.play().then(() => {
          setAudioPlaybackBlocked(false);
        }).catch((playbackError: unknown) => {
          setAudioPlaybackBlocked(true);
          const reason = playbackError instanceof Error ? playbackError.name : "PlaybackBlocked";
          setStatus(`Audio is ready but ${reason} prevented playback. Select Enable Audio.`);
        });
      };

      peer.onconnectionstatechange = () => {
        if (peersRef.current.get(remoteId) !== peer) return;
        const connectionState = peer.connectionState || "unknown";
        reportPeerTelemetry(remoteId, {
          connectionState,
          iceConnectionState: peer.iceConnectionState || "unknown",
          ...(connectionState === "failed"
            ? { failureReason: `Peer connection failed (${peer.iceConnectionState} ICE state).` }
            : {}),
        });
        if (connectionState === "connected") {
          restartingIce = false;
          setPeerAudioUnrecoverable(remoteId, false);
          void inspectSelectedCandidatePair(remoteId, peer);
        } else if (connectionState === "failed" && restartingIce) {
          setPeerAudioUnrecoverable(remoteId, true);
          setRetryingPeerAudio(false);
        }
        if (peer.connectionState === "closed") {
          removePeer(remoteId, peer);
        }
      };

      peer.oniceconnectionstatechange = () => {
        if (peersRef.current.get(remoteId) !== peer) return;
        const iceConnectionState = peer.iceConnectionState || "unknown";
        reportPeerTelemetry(remoteId, {
          iceConnectionState,
          ...(iceConnectionState === "failed"
            ? { failureReason: "ICE negotiation failed. The relay may be unreachable from this network." }
            : {}),
        });
        if (iceConnectionState === "connected" || iceConnectionState === "completed") {
          restartingIce = false;
          setPeerAudioUnrecoverable(remoteId, false);
          void inspectSelectedCandidatePair(remoteId, peer);
        } else if (iceConnectionState === "failed" && restartingIce) {
          setPeerAudioUnrecoverable(remoteId, true);
          setRetryingPeerAudio(false);
        } else if (
          iceConnectionState === "failed" &&
          !restartingIce &&
          clientIdRef.current < remoteId
        ) {
          void sendOffer(true);
        }
      };

      if (initiator) {
        void sendOffer();
      }

      return peer;
    },
    [inspectSelectedCandidatePair, removePeer, reportPeerTelemetry, send, setPeerAudioUnrecoverable],
  );

  const attachMicrophoneToPeers = useCallback(async (forceRenegotiation = false) => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    const channelId = channelRef.current;
    for (const [remoteId, sender] of Array.from(peerSendersRef.current.entries())) {
      try {
        let mediaChanged = false;
        if (sender.track !== track) {
          await sender.replaceTrack(track);
          if (sender.track !== track) throw new Error("Browser did not attach the microphone track.");
          mediaChanged = true;
        }
        const peer = peersRef.current.get(remoteId);
        const transceiver = peer?.getTransceivers().find((entry) => entry.sender === sender);
        if (transceiver && transceiver.direction !== "sendrecv" && transceiver.currentDirection !== "stopped") {
          transceiver.direction = "sendrecv";
          mediaChanged = true;
        }
        // A sendrecv transceiver normally permits replaceTrack without another
        // offer, but some browser/device combinations do not start outbound RTP
        // when the microphone arrives after the initial SDP exchange. Explicitly
        // renegotiate so both directions advertise the newly attached source.
        if (mediaChanged || forceRenegotiation) {
          await peerOfferersRef.current.get(remoteId)?.();
        }
      } catch (replaceError) {
        reportPeerTelemetry(remoteId, {
          failureReason: replaceError instanceof Error
            ? `Microphone attachment failed: ${replaceError.message}`
            : "Microphone attachment failed.",
        });
        removePeer(remoteId);
        if (channelRef.current === channelId && socketRef.current?.readyState === WebSocket.OPEN) {
          createPeer(remoteId, true);
        }
      }
    }
  }, [createPeer, removePeer, reportPeerTelemetry]);

  const syncMicrophoneState = useCallback(() => {
    const shouldTransmit =
      pressRef.current &&
      floorGrantedRef.current &&
      floorHolderRef.current === clientIdRef.current;
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = shouldTransmit;
    });
  }, []);

  /**
   * End a transmission from any source — pointer release, channel change, or
   * the console leaving the foreground — and tell the server. `endTransmit`
   * keeps its own press guard so the pointer handlers stay idempotent.
   */
  const abortTransmit = useCallback((reason: string) => {
    if (!pressRef.current && !floorGrantedRef.current) return;
    pressRef.current = false;
    setPressed(false);
    floorGrantedRef.current = false;
    transmitStartedAtRef.current = null;
    syncMicrophoneState();
    roipPacketRef.current = new Uint8Array();
    send({ type: "floor-release", channelId: channelRef.current });
    setStatus(reason);
  }, [send, syncMicrophoneState]);

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
      await attachMicrophoneToPeers();
      syncMicrophoneState();
      return true;
    } catch (microphoneError) {
      const reason = microphoneError instanceof Error ? microphoneError.name : "MicrophoneError";
      setError(`Microphone is unavailable (${reason}). Allow microphone access to transmit.`);
      return false;
    }
  }, [attachMicrophoneToPeers, syncMicrophoneState]);

  const ensureRoipCapture = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream || captureContextRef.current) return;
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(1024, 1, 1);
    const silent = context.createGain();
    silent.gain.value = 0;
    processor.onaudioprocess = (event) => {
      if (!floorGrantedRef.current || channelRef.current !== "dispatch" || !gatewayReadyRef.current) return;
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
    let connectionTimeout: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      const currentSocket = socketRef.current;
      if (
        currentSocket?.readyState === WebSocket.CONNECTING ||
        currentSocket?.readyState === WebSocket.OPEN
      ) {
        return;
      }
      try {
        const response = await apiRequest("GET", "/api/ptt/session");
        const data = (await response.json()) as PttSession;
        if (cancelled) return;
        const activeSocket = socketRef.current;
        if (
          activeSocket?.readyState === WebSocket.CONNECTING ||
          activeSocket?.readyState === WebSocket.OPEN
        ) {
          return;
        }
        setSession(data);
        if (Number.isFinite(data.maxTransmitMs)) maxTransmitMsRef.current = data.maxTransmitMs!;
        iceServersRef.current = data.iceServers?.length ? data.iceServers : [];
        gatewayReadyRef.current = data.roip.ready;
        setGateway(data.roip);
        setChannels(data.channels?.length ? data.channels : DEFAULT_CHANNELS);

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const nextSocket = new WebSocket(`${protocol}//${window.location.host}/ws/ptt?token=${encodeURIComponent(data.token)}`);
        socket = nextSocket;
        socketRef.current = nextSocket;
        const timeout = setTimeout(() => {
          if (socketRef.current === nextSocket && nextSocket.readyState === WebSocket.CONNECTING) {
            setStatus("Voice network connection timed out.");
            setError("The PTT signaling service did not accept the connection. Retrying…");
            nextSocket.close();
          }
        }, 10_000);
        connectionTimeout = timeout;

        nextSocket.onopen = () => {
          if (socketRef.current !== nextSocket) return;
          clearTimeout(timeout);
          if (connectionTimeout === timeout) connectionTimeout = null;
          reconnectAttemptRef.current = 0;
          setConnected(true);
          setStatus("Connected · joining channel…");
          setError("");
        };
        nextSocket.onclose = () => {
          clearTimeout(timeout);
          if (connectionTimeout === timeout) connectionTimeout = null;
          if (socketRef.current !== nextSocket) return;
          if (cancelled) return;
          clearPeers();
          setConnected(false);
          setFloorHolder(null);
          floorHolderRef.current = null;
          setParticipants([]);
          peerRtcStatusesRef.current = {};
          rtcTelemetrySignaturesRef.current.clear();
          setPeerRtcStatuses({});
          clearUnrecoverablePeers();
          setRetryingPeerAudio(false);
          floorGrantedRef.current = false;
          // Without this the press stays latched across the reconnect and the
          // operator's next press is swallowed by beginTransmit's guard.
          pressRef.current = false;
          setPressed(false);
          transmitStartedAtRef.current = null;
          syncMicrophoneState();
          gatewayReadyRef.current = false;
          setGateway((current) =>
            current
              ? { ...current, connected: false, ready: false, live: false, disconnectReason: "Bridge status unavailable while PTT reconnects." }
              : current,
          );
          socketRef.current = null;
          const delay = Math.min(10_000, 500 * 2 ** reconnectAttemptRef.current);
          reconnectAttemptRef.current += 1;
          setStatus(`Voice network disconnected. Reconnecting in ${Math.ceil(delay / 1000)}s…`);
          reconnectTimerRef.current = setTimeout(() => void connect(), delay);
        };
        nextSocket.onerror = () => {
          if (socketRef.current !== nextSocket) return;
          setStatus("Voice network connection failed.");
          setError("Unable to connect to the PTT voice network. Retrying…");
        };
        nextSocket.onmessage = async (event) => {
          if (socketRef.current !== nextSocket) return;
          let message: {
            type?: string;
            clientId?: string;
            operator?: { name?: string; role?: string };
            users?: Participant[];
            floorHolder?: string | null;
            user?: Participant;
            from?: string;
            payload?: SignalPayload | string;
            action?: string;
            userName?: string;
            requesterId?: string;
            reason?: string;
            forced?: boolean;
            maxTransmitMs?: number;
            protocol?: string;
            codec?: string;
            channelId?: string;
            gateway?: Partial<PttSession["roip"]>;
            message?: string;
          };
          try {
            message = JSON.parse(String(event.data));
          } catch {
            return;
          }

          if (message.type === "hello") {
            if (Number.isFinite(message.maxTransmitMs)) maxTransmitMsRef.current = message.maxTransmitMs!;
            clientIdRef.current = message.clientId || "";
            setClientId(message.clientId || "");
            setOperatorName(message.operator?.name || "Operator");
            send({ type: "join", channelId: channelRef.current });
            return;
          }

          if (message.type === "channel-state") {
            setParticipants(message.users || []);
            const nextFloorHolder = message.floorHolder || null;
            floorHolderRef.current = nextFloorHolder;
            floorGrantedRef.current = nextFloorHolder === clientIdRef.current && pressRef.current;
            setFloorHolder(nextFloorHolder);
            syncMicrophoneState();
            if (message.gateway) {
              gatewayReadyRef.current = message.gateway.ready === true;
              setGateway((current) => current ? { ...current, ...message.gateway } : current);
            }
            const joinedChannelId = message.channelId || channelRef.current;
            const joinedChannel = data.channels?.find((channel) => channel.id === joinedChannelId);
            setStatus(isDirectChannel(joinedChannelId) ? "In private call" : `Monitoring ${joinedChannel?.name || joinedChannelId}`);
            setError("");
            for (const user of message.users || []) {
              if (user.id !== clientIdRef.current) {
                createPeer(user.id, clientIdRef.current < user.id);
              }
            }
            return;
          }

          if (message.type === "error") {
            setStatus("Unable to join the selected channel.");
            setError(message.message || "The PTT voice network rejected the request.");
            return;
          }

          if (message.type === "gateway-warning") {
            gatewayReadyRef.current = false;
            setGateway((current) => current
              ? { ...current, ready: false, live: false, disconnectReason: message.message || "Radio bridge unavailable." }
              : current);
            return;
          }

          if (message.type === "user-joined" && message.user) {
            setParticipants((current) => [...current.filter((user) => user.id !== message.user?.id), message.user!]);
            if (message.user.id !== clientIdRef.current) {
              createPeer(message.user.id, clientIdRef.current < message.user.id);
            }
            return;
          }

          if (message.type === "user-left" && message.clientId) {
            setParticipants((current) => current.filter((user) => user.id !== message.clientId));
            delete peerRtcStatusesRef.current[message.clientId];
            rtcTelemetrySignaturesRef.current.delete(message.clientId);
            setPeerAudioUnrecoverable(message.clientId, false);
            setPeerRtcStatuses((current) => {
              const next = { ...current };
              delete next[message.clientId!];
              return next;
            });
            removePeer(message.clientId);
            return;
          }

          if (message.type === "floor") {
            const nextFloorHolder = message.action === "released" ? null : message.clientId || null;
            floorHolderRef.current = nextFloorHolder;
            floorGrantedRef.current =
              message.action === "granted" &&
              nextFloorHolder === clientIdRef.current &&
              pressRef.current;
            setFloorHolder(nextFloorHolder);
            setParticipants((current) =>
              current.map((user) => ({ ...user, isTalking: message.action === "granted" && user.id === message.clientId })),
            );
            if (message.action === "granted" && message.clientId === clientIdRef.current) {
              transmitStartedAtRef.current = Date.now();
              syncMicrophoneState();
              void attachMicrophoneToPeers(true);
              if (gatewayReadyRef.current && channelRef.current === "dispatch") ensureRoipCapture();
              setStatus(`Transmitting on ${channelRef.current}`);
            } else if (message.action === "released" && message.clientId === clientIdRef.current) {
              transmitStartedAtRef.current = null;
              if (message.forced) {
                // The server took the floor back while the button is still
                // held. Clear the press so the UI matches and the next press
                // is not swallowed; this is a release, not a lockout.
                pressRef.current = false;
                setPressed(false);
                roipPacketRef.current = new Uint8Array();
                setStatus("Transmit limit reached · press again to continue");
                setError(message.reason || "Maximum transmit time reached.");
              } else {
                setStatus("Channel clear · release the button to listen");
              }
              syncMicrophoneState();
            }
            if (message.action === "denied" && message.requesterId === clientIdRef.current) {
              setPressed(false);
              pressRef.current = false;
              floorGrantedRef.current = false;
              syncMicrophoneState();
              setError(`${message.reason || "Channel is busy."} ${message.userName ? `${message.userName} has the floor.` : ""}`);
            }
            return;
          }

          if (message.type === "gateway-status" && message.gateway) {
            gatewayReadyRef.current = message.gateway.ready === true;
            setGateway((current) => current ? { ...current, ...message.gateway } : current);
            if (gatewayReadyRef.current && floorGrantedRef.current && channelRef.current === "dispatch") {
              ensureRoipCapture();
            }
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
            if (message.channelId && message.channelId !== channelRef.current) return;
            const previousSignal = signalQueueRef.current;
            let releaseSignal: () => void = () => undefined;
            signalQueueRef.current = new Promise<void>((resolve) => {
              releaseSignal = resolve;
            });
            await previousSignal;
            try {
              const peer = createPeer(message.from, false);
              const negotiation = peerNegotiationsRef.current.get(message.from);
              if (!negotiation) return;
              if (message.payload.description) {
                const description = message.payload.description;
                const isOffer = description.type === "offer";
                const offerCollision =
                  isOffer &&
                  (negotiation.makingOffer || peer.signalingState !== "stable");
                const polite = clientIdRef.current > message.from;
                negotiation.ignoreOffer = !polite && offerCollision;
                if (negotiation.ignoreOffer) return;
                if (isOffer) negotiation.processingRemoteOffer = true;
                try {
                  if (offerCollision && polite) {
                    // Supersede any createOffer() continuation that was already
                    // awaiting the browser when this remote offer arrived.
                    negotiation.revision += 1;
                    // Keep one local renegotiation queued. The accepted remote
                    // offer may preserve only its sender direction; once our
                    // answer returns signaling to stable, advertise our own
                    // sendrecv microphone direction as well.
                    negotiation.pendingOffer = true;
                    negotiation.pendingIceRestart = false;
                    if (peer.signalingState !== "stable") {
                      await peer.setLocalDescription({ type: "rollback" });
                    }
                  }
                  if (peersRef.current.get(message.from) !== peer) return;
                  if (description.type === "answer" && peer.signalingState !== "have-local-offer") return;
                  await peer.setRemoteDescription(description);
                  negotiation.ignoreOffer = false;
                } catch (descriptionError) {
                  reportPeerTelemetry(message.from, {
                    failureReason: descriptionError instanceof Error
                      ? `WebRTC description failed: ${descriptionError.message}`
                      : "WebRTC description failed.",
                  });
                  if (peer.signalingState === "closed") {
                    removePeer(message.from);
                  } else {
                    negotiation.pendingOffer = true;
                  }
                  negotiation.processingRemoteOffer = false;
                  return;
                }
                const pending = pendingCandidatesRef.current.get(message.from) || [];
                for (const candidate of pending) await peer.addIceCandidate(candidate).catch(() => undefined);
                pendingCandidatesRef.current.delete(message.from);
                if (description.type === "offer") {
                  const answer = await peer.createAnswer();
                  await peer.setLocalDescription(answer);
                  if (peer.localDescription) {
                    send({
                      type: "signal",
                      to: message.from,
                      channelId: channelRef.current,
                      payload: { description: peer.localDescription.toJSON() },
                    });
                  }
                }
                if (isOffer) {
                  negotiation.processingRemoteOffer = false;
                  if (negotiation.pendingOffer && peer.signalingState === "stable") {
                    void peerOfferersRef.current.get(message.from)?.(
                      negotiation.pendingIceRestart,
                    );
                  }
                }
              }
              if (message.payload.candidate) {
                if (negotiation.ignoreOffer) return;
                if (peer.remoteDescription) {
                  await peer.addIceCandidate(message.payload.candidate).catch((candidateError: unknown) => {
                    reportPeerTelemetry(message.from!, {
                      failureReason: candidateError instanceof Error
                        ? `ICE candidate failed: ${candidateError.message}`
                        : "ICE candidate failed.",
                    });
                  });
                } else {
                  const pending = pendingCandidatesRef.current.get(message.from) || [];
                  pending.push(message.payload.candidate);
                  pendingCandidatesRef.current.set(message.from, pending);
                }
              }
            } finally {
              releaseSignal();
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
      if (connectionTimeout) clearTimeout(connectionTimeout);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      socket?.close();
      socketRef.current = null;
      iceServersRef.current = [];
      gatewayReadyRef.current = false;
      peerRtcStatusesRef.current = {};
      rtcTelemetrySignaturesRef.current.clear();
      setPeerRtcStatuses({});
      clearUnrecoverablePeers();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      floorGrantedRef.current = false;
      pressRef.current = false;
      transmitStartedAtRef.current = null;
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
  }, [attachMicrophoneToPeers, clearPeers, clearUnrecoverablePeers, createPeer, ensureRoipCapture, playRoipAudio, removePeer, send, setPeerAudioUnrecoverable, syncMicrophoneState]);

  const selected = useMemo(
    () => channels.find((channel) => channel.id === selectedChannel) || channels[0] || DEFAULT_CHANNELS[0],
    [channels, selectedChannel],
  );
  const currentTalker = participants.find((user) => user.id === floorHolder);
  const relayPeerCount = Object.values(peerRtcStatuses).filter((peer) => peer.path === "relay").length;
  const failedPeerCount = Object.values(peerRtcStatuses).filter(
    (peer) => peer.connectionState === "failed" || peer.iceConnectionState === "failed",
  ).length;
  const peerAudioReady = connected && unrecoverablePeerIds.size === 0;
  const maxTrendValue = Math.max(
    1,
    ...(telemetry?.trend.map((point) => Math.max(point.connected, point.failed)) ?? []),
  );

  const changeChannel = (channelId: string, label?: string) => {
    setPrivateCallLabel(isDirectChannel(channelId) ? label : undefined);
    if (channelId === selectedChannel) return;
    // Must run before channelRef moves: the release names the old channel.
    abortTransmit("Joining channel…");
    floorHolderRef.current = null;
    clearPeers();
    peerRtcStatusesRef.current = {};
    rtcTelemetrySignaturesRef.current.clear();
    setPeerRtcStatuses({});
    clearUnrecoverablePeers();
    setRetryingPeerAudio(false);
    setParticipants([]);
    setFloorHolder(null);
    setSelectedChannel(channelId);
    channelRef.current = channelId;
    send({ type: "join", channelId });
    setStatus("Joining channel…");
  };

  // Answering a ring while this console is already open switches it in place.
  const changeChannelRef = useRef(changeChannel);
  changeChannelRef.current = changeChannel;
  useEffect(() => {
    const onJoin = (event: Event) => {
      const detail = (event as CustomEvent<PttJoinDetail>).detail;
      if (detail?.channelId) changeChannelRef.current(detail.channelId, detail.label);
    };
    window.addEventListener(PTT_JOIN_EVENT, onJoin);
    return () => window.removeEventListener(PTT_JOIN_EVENT, onJoin);
  }, []);

  const retryPeerAudio = () => {
    if (retryingPeerAudio || !connected) return;
    const failedPeerIds = Array.from(unrecoverablePeerIdsRef.current);
    if (failedPeerIds.length === 0) return;

    setRetryingPeerAudio(true);
    setStatus("Retrying browser audio…");
    for (const remoteId of failedPeerIds) {
      removePeer(remoteId);
      if (socketRef.current?.readyState !== WebSocket.OPEN) continue;
      createPeer(remoteId, clientIdRef.current < remoteId);
    }
  };

  useEffect(() => {
    if (!retryingPeerAudio || unrecoverablePeerIds.size > 0) return;
    setRetryingPeerAudio(false);
    setStatus("Browser audio reconnected.");
  }, [retryingPeerAudio, unrecoverablePeerIds]);

  /**
   * A hardware PTT button lets an operator transmit without looking at the
   * screen, so leaving the foreground must drop the floor rather than leave a
   * hot mic. `blur` is deliberately not bound: it fires for devtools, dialogs
   * and multi-monitor focus changes while the operator is still talking.
   * `pagehide` is used instead of `beforeunload`, which can cost bfcache.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      abortTransmit("Transmission stopped · the console left the foreground");
    };
    const onPageHide = () => abortTransmit("Transmission stopped · the console was backgrounded");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [abortTransmit]);

  useEffect(() => {
    if (!pressed) {
      setTransmitSecondsLeft(null);
      return;
    }
    const tick = () => {
      const startedAt = transmitStartedAtRef.current;
      if (startedAt === null) {
        setTransmitSecondsLeft(null);
        return;
      }
      const limit = maxTransmitMsRef.current + CLIENT_TRANSMIT_GRACE_MS;
      const remaining = limit - (Date.now() - startedAt);
      setTransmitSecondsLeft(Math.max(0, Math.ceil(remaining / 1000)));
      // Backstop for the case where the server's forced release never lands
      // (a backpressured socket drops the frame). abortTransmit self-guards.
      if (remaining <= 0) abortTransmit("Transmit limit reached · press again to continue");
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [pressed, abortTransmit]);

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
    // Guard kept: onPointerUp and onPointerLeave both fire on a normal release.
    if (!pressRef.current) return;
    abortTransmit("Channel clear · release the button to listen");
  };

  const isTransmitting = pressed || floorHolder === clientId;
  const isReceiving = !!floorHolder && floorHolder !== clientId;

  return (
    <div
      className="min-h-[calc(100vh-4rem)] bg-zinc-950 p-4 md:p-6 font-sans text-zinc-100"
      data-testid="page-ptt-dispatch"
      onPointerDownCapture={() => {
        if (audioPlaybackBlocked) void unlockRemoteAudio();
      }}
    >
      <div className="mx-auto max-w-[1400px] flex flex-col gap-6">
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 rounded-xl bg-zinc-900 border border-zinc-800 p-4 shadow-sm">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-3">
              <RadioTower className="h-6 w-6 text-orange-500" />
              Dispatch Console
            </h1>
            <p className="text-sm text-zinc-400 mt-1">Live voice communications and telemetry</p>
          </div>
          <div className="flex items-center gap-4">
             <div className="text-right hidden sm:block">
               <div className="text-sm font-semibold text-zinc-200">{operatorName}</div>
               <div className="text-xs text-zinc-500">{clientId || "Awaiting ID..."}</div>
             </div>
             <div className="flex flex-wrap justify-end gap-2">
               <Badge
                 className={cn("px-3 py-1.5 uppercase tracking-wider text-[10px] font-bold", connected ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30" : "bg-amber-500/10 text-amber-400 border border-amber-500/30")}
                 data-testid="ptt-signaling-status"
               >
                 {connected ? "Signaling Online" : "Signaling Reconnecting"}
               </Badge>
               <Badge
                 className={cn("px-3 py-1.5 uppercase tracking-wider text-[10px] font-bold", peerAudioReady ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30" : unrecoverablePeerIds.size > 0 ? "bg-red-500/10 text-red-400 border border-red-500/30" : "bg-amber-500/10 text-amber-400 border border-amber-500/30")}
                 data-testid="ptt-peer-audio-status"
               >
                 {peerAudioReady ? "Peer Audio Ready" : unrecoverablePeerIds.size > 0 ? "Peer Audio Unavailable" : "Peer Audio Waiting"}
               </Badge>
             </div>
          </div>
        </header>

        {error && (
          <div className="flex items-center justify-between rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400 shadow-sm">
            <div className="flex items-center gap-3 font-medium">
               <ShieldCheck className="h-5 w-5 shrink-0" />
               {error}
            </div>
            <Button variant="ghost" size="sm" className="hover:bg-red-500/20 hover:text-red-300 ml-4 shrink-0" onClick={() => setError("")}>Dismiss</Button>
          </div>
        )}

        {unrecoverablePeerIds.size > 0 && (
          <div
             className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 shadow-sm"
            data-testid="ptt-peer-audio-warning"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
             <div className="min-w-0 flex-1">
              <p className="font-semibold">Browser audio could not reconnect.</p>
              <p className="mt-0.5 text-amber-300/90">
                 {retryingPeerAudio
                   ? "Retrying browser audio. Keep this channel open while audio reconnects."
                   : "Signaling is still online, but peer audio is unavailable. Retry audio to restore this channel."}
              </p>
            </div>
             <Button
               type="button"
               size="sm"
               variant="outline"
               className="shrink-0 border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 hover:text-amber-200"
               onClick={retryPeerAudio}
               disabled={retryingPeerAudio || !connected}
               data-testid="ptt-retry-audio"
             >
               {retryingPeerAudio && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
               {retryingPeerAudio ? "Retrying Audio" : "Retry Audio"}
             </Button>
          </div>
        )}

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">

          {/* Left Column: Channels & RoIP */}
          <div className="lg:col-span-3 flex flex-col gap-6">
            {isDirectChannel(selectedChannel) && (
              <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 shadow-sm" data-testid="ptt-private-call">
                <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-emerald-400">
                  <PhoneCall className="h-3.5 w-3.5" /> Private call
                </p>
                <p className="mt-1 text-sm font-semibold text-zinc-100">{privateCallLabel ? `With ${privateCallLabel}` : "Only the people on this call can hear you"}</p>
                <p className="mt-0.5 text-xs text-zinc-400">{participants.length} connected · not heard on the talk groups</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-3 w-full border-red-500/40 bg-transparent text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  onClick={() => changeChannel("dispatch")}
                  data-testid="ptt-leave-private-call"
                >
                  <PhoneOff className="mr-1.5 h-3.5 w-3.5" /> Leave call · back to Dispatch
                </Button>
              </div>
            )}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 shadow-sm flex flex-col h-[400px] lg:h-[500px]">
              <div className="bg-zinc-950/50 p-4 border-b border-zinc-800 flex items-center justify-between">
                <h2 className="font-bold text-zinc-300 uppercase tracking-widest text-xs flex items-center gap-2">
                  <Signal className="h-4 w-4 text-zinc-500" />
                  Talk Groups
                </h2>
                <Badge variant="outline" className="border-zinc-700 bg-zinc-800 text-zinc-300">{channels.length}</Badge>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {channels.map((channel) => {
                  const active = channel.id === selectedChannel;
                  return (
                    <button
                      key={channel.id}
                      onClick={() => changeChannel(channel.id)}
                      className={cn(
                        "w-full text-left p-3 rounded-lg border transition-all duration-200 group relative overflow-hidden",
                        active ? "bg-zinc-800 border-orange-500/50 shadow-[0_0_15px_rgba(249,115,22,0.05)]" : "bg-transparent border-transparent hover:bg-zinc-800/50"
                      )}
                      data-testid={`ptt-channel-${channel.id}`}
                    >
                      {active && <div className="absolute left-0 top-0 bottom-0 w-1 bg-orange-500 shadow-[0_0_10px_rgba(249,115,22,0.8)]" />}
                      <div className="flex justify-between items-center mb-1">
                        <span className={cn("font-bold text-sm", active ? "text-orange-400" : "text-zinc-300 group-hover:text-zinc-100")}>{channel.name}</span>
                        {active && <Signal className="h-3 w-3 text-orange-500 animate-pulse" />}
                      </div>
                      <p className="text-xs text-zinc-500 line-clamp-2">{channel.description}</p>
                      {active && (
                        <p className="mt-2 text-[10px] font-bold uppercase tracking-widest text-zinc-400 flex items-center gap-1">
                           <Users className="h-3 w-3" /> {participants.length} Online
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 shadow-sm" data-testid="ptt-radio-bridge-status">
               <h2 className="font-bold text-zinc-300 uppercase tracking-widest text-xs flex items-center gap-2 mb-4">
                 <Radio className="h-4 w-4 text-zinc-500" />
                  Optional Radio Bridge
               </h2>
               <div className="flex items-start gap-3">
                 <div className={cn("mt-1 rounded-full p-1.5", gateway?.live ? "bg-emerald-500/20 text-emerald-400" : gateway?.connected ? "bg-amber-500/20 text-amber-400" : "bg-zinc-800 text-zinc-500")}>
                    {gateway?.connected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                 </div>
                 <div>
                    <p className="text-sm font-bold text-zinc-200">
                       {gateway?.live ? "Radio Bridge Live" : gateway?.ready ? "Radio Bridge Ready" : gateway?.connected ? "Radio Bridge Connected" : gateway?.configured ? "Radio Bridge Offline" : "Radio Bridge Not Configured"}
                    </p>
                    <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                      {gateway?.configured
                         ? `${gateway.vendor} ${gateway.model} · ${gateway.codec}/${gateway.sampleRate} · ${gateway.channelMapping.physicalChannel} → ${gateway.channelMapping.talkGroup}`
                         : "Secure CSD-RoIP/1 boundary ready."}
                    </p>
                     {!gateway?.ready && (
                       <p className={cn("mt-2 text-xs font-semibold", connected ? "text-emerald-400" : "text-amber-400")}>
                         {connected
                           ? "Browser PTT remains online without this bridge."
                           : "Browser PTT is disconnected. Reconnecting…"}
                       </p>
                     )}
                    {gateway?.disconnectReason && !gateway.connected && (
                       <p className="mt-1 text-xs font-medium text-amber-400">{gateway.disconnectReason}</p>
                     )}
                 </div>
               </div>
            </div>
          </div>

          {/* Center Column: Big PTT Button */}
          <div className="lg:col-span-6 rounded-xl border border-zinc-800 bg-zinc-900 p-6 flex flex-col h-[500px] shadow-sm relative overflow-hidden">
            {/* Background glowing effect for active states */}
            {isTransmitting && <div className="absolute inset-0 bg-red-500/5 pointer-events-none transition-opacity duration-300" />}
            {isReceiving && <div className="absolute inset-0 bg-emerald-500/5 pointer-events-none transition-opacity duration-300" />}

            <div className="flex justify-between items-start mb-4 relative z-10">
               <div>
                 <h2 className="text-2xl font-black text-white tracking-wide">{selected.name}</h2>
                 <p className="text-sm text-zinc-400 font-medium mt-1">{status}</p>
                 <p className="mt-2 text-xs text-zinc-500" data-testid="ptt-network-path">
                   {session?.network.relayConfigured
                     ? relayPeerCount > 0
                       ? `TURN relay active for ${relayPeerCount} ${relayPeerCount === 1 ? "peer" : "peers"}`
                       : "Direct ICE path preferred"
                     : "Direct ICE only"}
                 </p>
               </div>
               <div className="flex items-center gap-2">
                 {audioPlaybackBlocked && (
                   <Button
                     type="button"
                     size="sm"
                     variant="outline"
                     className="border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 hover:text-amber-200"
                     onClick={() => void unlockRemoteAudio()}
                     data-testid="ptt-enable-audio"
                   >
                     <Volume2 className="mr-1.5 h-3.5 w-3.5" />
                     Enable Audio
                   </Button>
                 )}
                 <Badge variant="outline" className={cn("uppercase text-[10px] tracking-wider font-bold shadow-sm", micReady ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-zinc-700 bg-zinc-800 text-zinc-400")}>
                   {micReady ? <Mic className="mr-1.5 h-3 w-3" /> : <MicOff className="mr-1.5 h-3 w-3" />}
                   {micReady ? "Mic Ready" : "Mic On Demand"}
                 </Badge>
               </div>
            </div>

            <div className="flex-1 flex flex-col items-center justify-center relative z-10">
              <div className="absolute top-4 flex flex-col items-center">
                {isTransmitting ? (
                  <Badge className="bg-red-500 text-white border-none uppercase tracking-widest px-4 py-1.5 animate-pulse shadow-[0_0_15px_rgba(239,68,68,0.5)]">Transmitting</Badge>
                ) : isReceiving ? (
                  <Badge className="bg-emerald-500 text-white border-none uppercase tracking-widest px-4 py-1.5 shadow-[0_0_15px_rgba(16,185,129,0.5)]">Receiving</Badge>
                ) : (
                  <Badge className="bg-zinc-800 text-zinc-400 border-none uppercase tracking-widest px-4 py-1.5">Channel Idle</Badge>
                )}

                {isReceiving && currentTalker && (
                  <div className="mt-3 text-base font-bold text-emerald-400 tracking-wide flex items-center gap-2">
                    <Volume2 className="h-4 w-4 animate-pulse" />
                    {currentTalker.name} is speaking
                  </div>
                )}
                {isTransmitting && (
                  <div className="mt-3 text-sm font-bold text-red-400 tracking-wide flex items-center gap-2">
                     <RadioTower className="h-4 w-4 animate-pulse" />
                     Live on {selected.name}
                  </div>
                )}
                {isTransmitting && transmitSecondsLeft !== null && (
                  <div
                    className={cn(
                      "mt-1 text-xs font-semibold tracking-wide tabular-nums",
                      transmitSecondsLeft <= 10 ? "text-amber-400" : "text-zinc-500",
                    )}
                    data-testid="ptt-transmit-countdown"
                  >
                    {transmitSecondsLeft}s left on this transmission
                  </div>
                )}
              </div>

              <button
                 type="button"
                 disabled={!connected || (!isTransmitting && isReceiving)}
                 onPointerDown={(event) => {
                   if (!connected || isReceiving) return;
                   event.currentTarget.setPointerCapture(event.pointerId);
                   void beginTransmit();
                 }}
                 onPointerUp={endTransmit}
                 onPointerCancel={endTransmit}
                 onPointerLeave={endTransmit}
                 onContextMenu={(e) => e.preventDefault()}
                 className={cn(
                   "relative group flex h-56 w-56 sm:h-64 sm:w-64 select-none flex-col items-center justify-center rounded-full transition-all duration-100 disabled:cursor-not-allowed disabled:opacity-90 focus:outline-none mt-12",
                   isTransmitting
                     ? "bg-red-600 scale-95 shadow-[0_0_40px_rgba(220,38,38,0.6),inset_0_10px_20px_rgba(0,0,0,0.3)] border-4 border-red-500"
                     : isReceiving
                       ? "bg-emerald-600 shadow-[0_0_40px_rgba(16,185,129,0.4),inset_0_10px_20px_rgba(0,0,0,0.2)] border-4 border-emerald-500"
                       : !connected
                         ? "bg-zinc-800 border-4 border-zinc-700 text-zinc-500 shadow-none"
                         : "bg-orange-500 hover:bg-orange-400 shadow-[0_15px_35px_rgba(249,115,22,0.3),inset_0_4px_10px_rgba(255,255,255,0.3)] hover:scale-[1.02] active:scale-95 active:shadow-[inset_0_10px_20px_rgba(0,0,0,0.3)] border-4 border-orange-400"
                 )}
                 style={{ touchAction: 'none' }}
                 data-testid="ptt-transmit-button"
              >
                 {isTransmitting && (
                    <div className="absolute inset-0 rounded-full border-4 border-red-400 animate-ping opacity-50" style={{ animationDuration: '1.5s' }} />
                 )}
                 {isReceiving && (
                    <div className="absolute inset-0 rounded-full border-4 border-emerald-400 animate-ping opacity-30" style={{ animationDuration: '2s' }} />
                 )}

                 {isTransmitting ? (
                   <Mic className="h-14 w-14 sm:h-16 sm:w-16 text-white mb-2" />
                 ) : isReceiving ? (
                   <Volume2 className="h-14 w-14 sm:h-16 sm:w-16 text-white mb-2" />
                 ) : !connected ? (
                   <MicOff className="h-14 w-14 sm:h-16 sm:w-16 text-zinc-600 mb-2" />
                 ) : (
                   <Mic className="h-14 w-14 sm:h-16 sm:w-16 text-white mb-2 drop-shadow-md group-active:scale-90 transition-transform" />
                 )}

                 <span className="text-2xl sm:text-3xl font-black text-white tracking-widest drop-shadow-sm">
                   {isTransmitting ? "LIVE" : isReceiving ? "RX" : !connected ? "OFFLINE" : "PTT"}
                 </span>
              </button>
            </div>
          </div>

          {/* Right Column: Participants */}
          <div className="lg:col-span-3 flex flex-col gap-6">
            <PttRingPanel currentChannelId={selectedChannel} channels={channels} onJoinCall={changeChannel} />
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 flex flex-col h-[400px] lg:h-[500px] shadow-sm">
              <div className="bg-zinc-950/50 p-4 border-b border-zinc-800 flex items-center justify-between">
                <h2 className="font-bold text-zinc-300 uppercase tracking-widest text-xs flex items-center gap-2">
                  <Users className="h-4 w-4 text-zinc-500" />
                  Active Users
                </h2>
                <Badge variant="outline" className="border-zinc-700 bg-zinc-800 text-zinc-300">{participants.length}</Badge>
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {participants.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center px-4">
                    <Users className="h-8 w-8 text-zinc-700 mb-3" />
                    <p className="text-sm font-medium text-zinc-400">Empty Channel</p>
                    <p className="text-xs text-zinc-500 mt-1">No other operators are monitoring this talk group.</p>
                  </div>
                ) : (
                  participants.map((participant) => (
                    <div key={participant.id} className="flex items-center gap-3 p-2 rounded-lg border border-transparent hover:border-zinc-800 hover:bg-zinc-950/50 transition-colors">
                      <div className={cn(
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ring-2 ring-offset-2 ring-offset-zinc-900 transition-all",
                        participant.isTalking ? "bg-red-500 text-white ring-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]" : "bg-zinc-800 text-zinc-300 ring-transparent"
                      )}>
                        {participant.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-zinc-200">
                          {participant.id === clientId ? `${participant.name} (You)` : participant.name}
                        </p>
                        <p className={cn("text-[10px] font-bold uppercase tracking-widest mt-0.5", participant.isTalking ? "text-red-400" : "text-zinc-500")}>
                           {pttRoleLabel(participant.role)} · {participant.isTalking ? "Transmitting" : "Monitoring"}
                        </p>
                      </div>
                      {participant.isTalking && <Volume2 className="h-4 w-4 text-red-500 animate-pulse shrink-0" />}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Telemetry / Diagnostics Row */}
        {(telemetryLoading || telemetry) && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 mb-8 shadow-sm">
             <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
                <div>
                  <h2 className="text-lg font-bold text-white flex items-center gap-2">
                    <TrendingUp className="h-5 w-5 text-orange-500" />
                    Diagnostic Telemetry
                  </h2>
                  <p className="text-sm text-zinc-400 mt-1">Connection outcomes and peer relay health</p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <select
                      value={telemetryHours}
                      onChange={(event) => setTelemetryHours(Number(event.target.value))}
                      className="bg-zinc-950 border border-zinc-800 text-zinc-300 text-sm font-medium rounded-lg px-3 py-2 hover:border-zinc-700 focus:ring-2 focus:ring-orange-500/50 focus:border-orange-500 transition-colors outline-none cursor-pointer"
                    >
                      <option value={24}>Last 24 hours</option>
                      <option value={168}>Last 7 days</option>
                      <option value={720}>Last 30 days</option>
                  </select>
                  <select
                      value={telemetryChannel}
                      onChange={(event) => setTelemetryChannel(event.target.value)}
                      className="bg-zinc-950 border border-zinc-800 text-zinc-300 text-sm font-medium rounded-lg px-3 py-2 hover:border-zinc-700 focus:ring-2 focus:ring-orange-500/50 focus:border-orange-500 transition-colors outline-none cursor-pointer"
                    >
                      <option value="all">All talk groups</option>
                      {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
                  </select>
                </div>
             </div>

             {telemetryLoading && !telemetry ? (
                 <div className="flex h-32 items-center justify-center text-sm font-medium text-zinc-500">
                   <Loader2 className="mr-2 h-5 w-5 animate-spin text-orange-500" /> Loading relay history…
                 </div>
             ) : telemetry ? (
                 <div className="space-y-6">
                    {telemetry.incidentActive && (
                      <div className="rounded-lg bg-orange-500/10 border border-orange-500/30 p-4 flex items-center justify-between">
                        <p className="text-sm font-bold text-orange-400 flex items-center gap-2">
                           <ShieldCheck className="h-4 w-4" />
                           Connection failures detected in this time range.
                        </p>
                      </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {[
                        ["Relay Adoption", `${telemetry.summary.relayRate}%`, `${telemetry.summary.relay} of ${telemetry.summary.connected} successful paths`],
                        ["Successful Paths", telemetry.summary.connected, "Completed peer connections"],
                        ["Failed Attempts", telemetry.summary.failed, "ICE or peer connection failures"],
                      ].map(([label, value, detail]) => (
                        <div key={String(label)} className="bg-zinc-950 rounded-lg p-5 border border-zinc-800/50 flex flex-col justify-center">
                          <p className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-1">{label}</p>
                          <p className="text-3xl font-black text-white mb-1">{value}</p>
                          <p className="text-xs font-medium text-zinc-600">{detail}</p>
                        </div>
                      ))}
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pt-6 border-t border-zinc-800">
                       <div className="lg:col-span-2">
                         <p className="text-sm font-bold text-zinc-300 mb-4 uppercase tracking-widest">Connection Trend</p>
                         {telemetry.trend.length === 0 ? (
                           <div className="h-40 flex items-center justify-center bg-zinc-950 rounded-lg border border-dashed border-zinc-800 text-zinc-600 text-sm font-medium">
                             No data for this range.
                           </div>
                         ) : (
                           <div className="h-40 flex items-end gap-[2px] bg-zinc-950 p-4 rounded-lg border border-zinc-800">
                             {telemetry.trend.map((point) => (
                               <div key={point.bucket} className="flex-1 flex items-end justify-center gap-px group relative" title={`${new Date(point.bucket).toLocaleString()}: ${point.connected} success, ${point.failed} failed`}>
                                  <div className="w-full max-w-[8px] rounded-t-sm bg-emerald-500/70 group-hover:bg-emerald-400 transition-colors" style={{ height: `${Math.max(point.connected ? 4 : 0, (point.connected / maxTrendValue) * 100)}%` }} />
                                  <div className="w-full max-w-[8px] rounded-t-sm bg-red-500/70 group-hover:bg-red-400 transition-colors" style={{ height: `${Math.max(point.failed ? 4 : 0, (point.failed / maxTrendValue) * 100)}%` }} />
                               </div>
                             ))}
                           </div>
                         )}
                         <div className="flex gap-6 mt-4 text-xs font-bold uppercase tracking-widest text-zinc-500 justify-center lg:justify-start">
                            <span className="flex items-center gap-2"><div className="w-3 h-3 rounded-sm bg-emerald-500/70" /> Successful</span>
                            <span className="flex items-center gap-2"><div className="w-3 h-3 rounded-sm bg-red-500/70" /> Failed</span>
                         </div>
                       </div>

                       <div>
                         <p className="text-sm font-bold text-zinc-300 mb-4 uppercase tracking-widest">Common Failures</p>
                         {telemetry.failureReasons.length === 0 ? (
                           <div className="h-40 flex items-center justify-center bg-zinc-950 rounded-lg border border-dashed border-zinc-800 text-zinc-600 text-sm font-medium">
                             No failures logged.
                           </div>
                         ) : (
                           <div className="space-y-2 h-40 overflow-y-auto pr-2">
                             {telemetry.failureReasons.map((failure) => (
                               <div key={failure.reason} className="bg-zinc-950 p-3 rounded-lg border border-zinc-800 flex justify-between items-center gap-3">
                                  <p className="text-xs font-medium text-zinc-400 leading-relaxed">{failure.reason}</p>
                                  <Badge className="bg-red-500/10 text-red-400 border border-red-500/20 shrink-0 font-bold">{failure.count}</Badge>
                               </div>
                             ))}
                           </div>
                         )}
                       </div>
                    </div>
                 </div>
             ) : null}
          </div>
        )}

      </div>
    </div>
  );
}