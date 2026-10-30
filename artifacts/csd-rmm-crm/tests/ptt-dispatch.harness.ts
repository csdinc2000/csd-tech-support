import type { Page } from "@playwright/test";

/**
 * Shared browser fakes for the PTT dispatch page.
 *
 * Playwright's default testMatch only collects `*.spec.ts` / `*.test.ts`, so
 * this file sits in `tests/` without being run as a suite.
 */

export type PttApiOptions = {
  /** Advertised server transmit ceiling, in milliseconds. */
  maxTransmitMs?: number;
};

/**
 * Replaces RTCPeerConnection, WebSocket and mediaDevices with inspectable
 * fakes and exposes them on `window.__pttTest`. Nothing here dials a real
 * server or opens a real microphone.
 */
export async function installPttFakes(page: Page) {
  await page.addInitScript(() => {
    type PeerState = "new" | "connected" | "failed" | "closed";

    class FakePeerConnection {
      static instances: FakePeerConnection[] = [];
      readonly instanceId: number;
      connectionState: PeerState = "new";
      iceConnectionState: PeerState = "new";
      signalingState = "stable";
      localDescription: RTCSessionDescription | null = null;
      remoteDescription: RTCSessionDescriptionInit | null = null;
      onconnectionstatechange: (() => void) | null = null;
      oniceconnectionstatechange: (() => void) | null = null;
      onicecandidate: ((event: { candidate: null }) => void) | null = null;
      onicecandidateerror: (() => void) | null = null;
      onsignalingstatechange: (() => void) | null = null;
      ontrack: (() => void) | null = null;
      closed = false;
      private offerCount = 0;
      // Unlike a bare stub, replaceTrack actually lands the track: the page
      // throws "Browser did not attach the microphone track" otherwise.
      private readonly sender = {
        track: null as unknown,
        replaceTrack(track: unknown) {
          this.track = track;
          return Promise.resolve(undefined);
        },
      };

      constructor() {
        this.instanceId = FakePeerConnection.instances.length;
        FakePeerConnection.instances.push(this);
      }

      addTransceiver() {
        return { sender: this.sender, direction: "sendrecv", currentDirection: "sendrecv" };
      }

      getTransceivers() {
        return [{ sender: this.sender, direction: "sendrecv", currentDirection: "sendrecv" }];
      }

      async createOffer() {
        this.offerCount += 1;
        return { type: "offer" as const, sdp: `offer-${this.offerCount}` };
      }

      async createAnswer() {
        return { type: "answer" as const, sdp: "answer" };
      }

      async setLocalDescription(description: RTCSessionDescriptionInit) {
        this.localDescription = {
          type: description.type,
          sdp: description.sdp ?? "",
          toJSON: () => ({ type: description.type, sdp: description.sdp ?? "" }),
        } as RTCSessionDescription;
        this.signalingState = description.type === "offer" ? "have-local-offer" : "stable";
      }

      async setRemoteDescription(description: RTCSessionDescriptionInit) {
        this.remoteDescription = description;
        this.signalingState = description.type === "answer" ? "stable" : "have-remote-offer";
      }

      async addIceCandidate() {}

      async getStats() {
        return new Map();
      }

      close() {
        this.closed = true;
        this.connectionState = "closed";
        this.iceConnectionState = "closed";
      }

      connect() {
        this.signalingState = "stable";
        this.connectionState = "connected";
        this.iceConnectionState = "connected";
        this.onconnectionstatechange?.();
        this.oniceconnectionstatechange?.();
      }

      async becomeUnrecoverable() {
        this.signalingState = "stable";
        this.iceConnectionState = "failed";
        this.oniceconnectionstatechange?.();
        await Promise.resolve();
        await Promise.resolve();
        this.connectionState = "failed";
        this.onconnectionstatechange?.();
      }
    }

    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      static instances: FakeWebSocket[] = [];
      readyState = FakeWebSocket.CONNECTING;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      sent: string[] = [];
      readonly instanceId: number;
      readonly url: string;

      constructor(url: string | URL) {
        this.instanceId = FakeWebSocket.instances.length;
        this.url = String(url);
        FakeWebSocket.instances.push(this);
      }

      send(payload: string) {
        this.sent.push(payload);
      }

      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      }

      close() {
        this.readyState = FakeWebSocket.CLOSED;
      }

      receive(payload: unknown) {
        this.onmessage?.({ data: JSON.stringify(payload) });
      }
    }

    // A microphone track whose `enabled` flag is the assertion target: it is
    // what syncMicrophoneState drives, and therefore what "hot mic" means.
    const tracks: Array<{ enabled: boolean; kind: string; stopped: boolean }> = [];
    let getUserMediaCalls = 0;

    const makeStream = () => {
      const track = {
        enabled: true,
        kind: "audio",
        stopped: false,
        stop() {
          this.stopped = true;
        },
      };
      tracks.push(track);
      return {
        getAudioTracks: () => [track],
        getTracks: () => [track],
      };
    };

    Object.defineProperty(window, "RTCPeerConnection", { value: FakePeerConnection });
    Object.defineProperty(window, "WebSocket", { value: FakeWebSocket });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          getUserMediaCalls += 1;
          return makeStream();
        },
        enumerateDevices: async () => [],
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });

    Object.assign(window, {
      __pttTest: {
        peers: FakePeerConnection.instances,
        sockets: FakeWebSocket.instances,
        tracks,
        getUserMediaCalls: () => getUserMediaCalls,
        pttSocket: () => FakeWebSocket.instances.find((socket) => socket.url.includes("/ws/ptt")),
        sentTypes: () => {
          const socket = FakeWebSocket.instances.find((entry) => entry.url.includes("/ws/ptt"));
          return (socket?.sent ?? []).map((raw: string) => JSON.parse(raw));
        },
        hide: () => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        },
      },
    });
  });
}

/** Fulfils the two endpoints the page calls; everything else fails loudly. */
export async function routePttApi(page: Page, options: PttApiOptions = {}) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/ptt/session") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          token: "browser-test-token",
          ...(options.maxTransmitMs === undefined ? {} : { maxTransmitMs: options.maxTransmitMs }),
          channels: [
            { id: "dispatch", name: "Dispatch", description: "Primary service desk and field coordination" },
            { id: "field", name: "Field Technicians", description: "Technician coordination" },
          ],
          iceServers: [],
          network: { relayConfigured: true, turnCredentialExpiresAt: null },
          roip: {
            configured: false,
            enabled: false,
            connected: false,
            ready: false,
            live: false,
            lastSeen: null,
            lastMediaAt: null,
            disconnectReason: null,
            vendor: "Test",
            model: "Fixture",
            codec: "PCMU",
            sampleRate: 8000,
            physicalChannel: "1",
            channelMapping: { physicalChannel: "1", channelId: "dispatch", talkGroup: "Dispatch" },
            channelId: "dispatch",
            singleInstanceRequired: true,
            websocketPath: "/ws/ptt",
            protocol: "CSD-RoIP/1",
          },
        }),
      });
      return;
    }
    if (path === "/api/ptt/telemetry") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          filters: { hours: 24, channelId: null, bucket: "hour" },
          summary: { connected: 0, relay: 0, failed: 0, relayRate: 0 },
          trend: [],
          failureReasons: [],
          incidentActive: false,
        }),
      });
      return;
    }
    await route.abort();
  });
}
