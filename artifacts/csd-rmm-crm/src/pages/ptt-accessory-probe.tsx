import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bluetooth,
  Copy,
  Download,
  Gamepad2,
  Keyboard,
  Mic,
  Radio,
  Square,
  Trash2,
  Usb,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Phase 0 discovery instrument for Bluetooth PTT accessories.
 *
 * This page only observes. It never requests the floor, never touches the
 * dispatch socket, and shares no state with /ptt — its single job is to record
 * what each accessory actually emits so per-device adapters can be written
 * against evidence instead of assumption.
 */

type ProbeChannel = "hid" | "webhid" | "media-key" | "ble-gatt" | "gamepad" | "audio-device";
type ProbeEdge = "down" | "up" | "info";

type ProbeEvent = {
  seq: number;
  /** ms since the probe was armed — the number that matters for debounce work */
  at: number;
  wallClock: string;
  device: string;
  channel: ProbeChannel;
  edge: ProbeEdge;
  detail: string;
  raw?: Record<string, unknown>;
};

const CHANNEL_STYLES: Record<ProbeChannel, string> = {
  hid: "bg-sky-500/10 text-sky-400 border-sky-500/30",
  webhid: "bg-indigo-500/10 text-indigo-400 border-indigo-500/30",
  "media-key": "bg-violet-500/10 text-violet-400 border-violet-500/30",
  "ble-gatt": "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
  gamepad: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  "audio-device": "bg-zinc-500/10 text-zinc-400 border-zinc-500/30",
};

const EDGE_STYLES: Record<ProbeEdge, string> = {
  down: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  up: "bg-orange-500/10 text-orange-400 border-orange-500/30",
  info: "bg-zinc-700/40 text-zinc-400 border-zinc-600/40",
};

const MAX_EVENTS = 500;

/**
 * Chrome's Web Bluetooth blocklist rejects the HID service (0x1812), so BLE-HID
 * buttons are invisible here by design — they surface on the keyboard channel
 * instead. These are the services cheap BT modules and PTT vendors actually use.
 */
const DEFAULT_OPTIONAL_SERVICES = [
  "battery_service",
  "device_information",
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART
  "0000ffe0-0000-1000-8000-00805f9b34fb",
  "0000fff0-0000-1000-8000-00805f9b34fb",
  "0000ffd0-0000-1000-8000-00805f9b34fb",
];

const MEDIA_ACTIONS: MediaSessionAction[] = [
  "play",
  "pause",
  "stop",
  "previoustrack",
  "nexttrack",
  "seekbackward",
  "seekforward",
];

// --- Minimal Web Bluetooth / WebHID typings (absent from lib.dom) ---------

type BleCharacteristic = {
  uuid: string;
  properties: {
    notify: boolean;
    indicate: boolean;
    read: boolean;
    write: boolean;
    writeWithoutResponse: boolean;
  };
  value?: DataView | null;
  startNotifications(): Promise<BleCharacteristic>;
  stopNotifications(): Promise<BleCharacteristic>;
  addEventListener(type: "characteristicvaluechanged", listener: (event: Event) => void): void;
  removeEventListener(type: "characteristicvaluechanged", listener: (event: Event) => void): void;
};

type BleService = { uuid: string; getCharacteristics(): Promise<BleCharacteristic[]> };
type BleServer = {
  connected: boolean;
  connect(): Promise<BleServer>;
  getPrimaryServices(): Promise<BleService[]>;
  disconnect(): void;
};

type BleDevice = {
  id: string;
  name?: string;
  gatt?: BleServer;
  addEventListener(type: "gattserverdisconnected", listener: () => void): void;
  removeEventListener(type: "gattserverdisconnected", listener: () => void): void;
};

type BluetoothApi = {
  requestDevice(options: { acceptAllDevices?: boolean; optionalServices?: string[] }): Promise<BleDevice>;
};

type HidInputReportEvent = Event & { reportId: number; data: DataView };

type HidDevice = {
  productName?: string;
  vendorId: number;
  productId: number;
  opened: boolean;
  open(): Promise<void>;
  addEventListener(type: "inputreport", listener: (event: HidInputReportEvent) => void): void;
  removeEventListener(type: "inputreport", listener: (event: HidInputReportEvent) => void): void;
  close(): Promise<void>;
};

type HidApi = { requestDevice(options: { filters: unknown[] }): Promise<HidDevice[]> };

type ProbeNavigator = Navigator & { bluetooth?: BluetoothApi; hid?: HidApi };

// --- Helpers --------------------------------------------------------------

function toHex(view: DataView): string {
  const bytes: string[] = [];
  for (let i = 0; i < view.byteLength; i++) bytes.push(view.getUint8(i).toString(16).padStart(2, "0"));
  return bytes.join(" ") || "(empty)";
}

/** Media Session handlers only fire while media is actually playing. */
function createSilentLoopUrl(): string {
  const sampleRate = 8000;
  const samples = sampleRate; // one second, looped
  const buffer = new ArrayBuffer(44 + samples);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  writeAscii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeAscii(36, "data");
  view.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) view.setUint8(44 + i, 128); // 8-bit silence
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

export default function PttAccessoryProbe() {
  const [deviceLabel, setDeviceLabel] = useState("");
  const [extraServices, setExtraServices] = useState("");
  const [armed, setArmed] = useState(false);
  const [events, setEvents] = useState<ProbeEvent[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const seqRef = useRef(0);
  const armedAtRef = useRef(0);
  const deviceLabelRef = useRef("");
  const silentAudioRef = useRef<HTMLAudioElement | null>(null);
  const silentUrlRef = useRef<string | null>(null);
  const gamepadFrameRef = useRef<number | null>(null);
  const gamepadStateRef = useRef(new Map<string, boolean>());
  const bleDeviceRef = useRef<BleDevice | null>(null);
  const bleCharacteristicsRef = useRef<BleCharacteristic[]>([]);
  const bleListenerRemoversRef = useRef<Array<() => void>>([]);
  const hidDevicesRef = useRef<HidDevice[]>([]);
  const hidListenerRemoversRef = useRef<Array<() => void>>([]);
  const bluetoothGenerationRef = useRef(0);
  const hidGenerationRef = useRef(0);
  const mountedRef = useRef(false);

  deviceLabelRef.current = deviceLabel.trim() || "(unlabelled)";

  const cleanupBluetooth = useCallback(() => {
    for (const removeListener of bleListenerRemoversRef.current.splice(0)) {
      try { removeListener(); } catch { /* device may already be disconnected */ }
    }
    for (const characteristic of bleCharacteristicsRef.current.splice(0)) {
      void characteristic.stopNotifications().catch(() => {});
    }
    const device = bleDeviceRef.current;
    bleDeviceRef.current = null;
    try { device?.gatt?.disconnect(); } catch { /* device may already be disconnected */ }
  }, []);

  const cleanupHid = useCallback(() => {
    for (const removeListener of hidListenerRemoversRef.current.splice(0)) {
      try { removeListener(); } catch { /* device may already be closed */ }
    }
    for (const device of hidDevicesRef.current.splice(0)) {
      if (device.opened) void device.close().catch(() => {});
    }
  }, []);

  const support = useMemo(() => {
    const nav = typeof navigator === "undefined" ? undefined : (navigator as ProbeNavigator);
    return {
      bluetooth: Boolean(nav?.bluetooth),
      hid: Boolean(nav?.hid),
      mediaSession: typeof navigator !== "undefined" && "mediaSession" in navigator,
      gamepad: typeof navigator !== "undefined" && "getGamepads" in navigator,
      secureContext: typeof window !== "undefined" && window.isSecureContext,
    };
  }, []);

  const log = useCallback(
    (channel: ProbeChannel, edge: ProbeEdge, detail: string, raw?: Record<string, unknown>) => {
      const now = performance.now();
      const entry: ProbeEvent = {
        seq: ++seqRef.current,
        at: Math.round(armedAtRef.current ? now - armedAtRef.current : 0),
        wallClock: new Date().toISOString(),
        device: deviceLabelRef.current,
        channel,
        edge,
        detail,
        raw,
      };
      setEvents((previous) => [entry, ...previous].slice(0, MAX_EVENTS));
    },
    [],
  );

  // --- Keyboard / HID-as-keyboard ----------------------------------------

  useEffect(() => {
    if (!armed) return;
    const describe = (event: KeyboardEvent) =>
      `key="${event.key}" code="${event.code}" keyCode=${event.keyCode}${event.repeat ? " (repeat)" : ""}`;
    const onDown = (event: KeyboardEvent) => {
      log("hid", "down", describe(event), {
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        repeat: event.repeat,
      });
    };
    const onUp = (event: KeyboardEvent) => {
      log("hid", "up", describe(event), { key: event.key, code: event.code, keyCode: event.keyCode });
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
    };
  }, [armed, log]);

  // --- Media Session (headset hook / play-pause) --------------------------

  useEffect(() => {
    if (!armed || !support.mediaSession) return;
    const handlers: MediaSessionAction[] = [];
    for (const action of MEDIA_ACTIONS) {
      try {
        navigator.mediaSession.setActionHandler(action, () => {
          log("media-key", "down", `mediaSession action "${action}"`, { action });
        });
        handlers.push(action);
      } catch {
        // Browser does not support this action; nothing to clean up.
      }
    }
    navigator.mediaSession.playbackState = "playing";
    return () => {
      for (const action of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Ignore teardown failures on unsupported actions.
        }
      }
      navigator.mediaSession.playbackState = "none";
    };
  }, [armed, support.mediaSession, log]);

  // --- Gamepad-style buttons ---------------------------------------------

  useEffect(() => {
    if (!armed || !support.gamepad) return;
    const poll = () => {
      for (const pad of navigator.getGamepads()) {
        if (!pad) continue;
        pad.buttons.forEach((button, index) => {
          const key = `${pad.index}:${index}`;
          const was = gamepadStateRef.current.get(key) ?? false;
          if (button.pressed === was) return;
          gamepadStateRef.current.set(key, button.pressed);
          log("gamepad", button.pressed ? "down" : "up", `${pad.id} button ${index}`, {
            padId: pad.id,
            button: index,
          });
        });
      }
      gamepadFrameRef.current = requestAnimationFrame(poll);
    };
    gamepadFrameRef.current = requestAnimationFrame(poll);
    return () => {
      if (gamepadFrameRef.current !== null) cancelAnimationFrame(gamepadFrameRef.current);
      gamepadFrameRef.current = null;
      gamepadStateRef.current.clear();
    };
  }, [armed, support.gamepad, log]);

  // --- Audio device inventory --------------------------------------------

  const listAudioDevices = useCallback(async () => {
    setError("");
    try {
      // Labels stay empty until microphone permission is granted once.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audio = devices.filter((device) => device.kind === "audioinput" || device.kind === "audiooutput");
      for (const device of audio) {
        log("audio-device", "info", `${device.kind}: ${device.label || "(no label)"}`, {
          kind: device.kind,
          label: device.label,
          deviceId: device.deviceId,
          groupId: device.groupId,
        });
      }
      setNotice(`Logged ${audio.length} audio device(s). deviceId values feed AudioRouteManager.routeTo().`);
    } catch (deviceError) {
      const reason = deviceError instanceof Error ? deviceError.message : "unknown error";
      setError(`Could not enumerate audio devices: ${reason}`);
    }
  }, [log]);

  useEffect(() => {
    if (!armed || !navigator.mediaDevices) return;
    const onChange = () => {
      log("audio-device", "info", "devicechange fired — accessory connected or dropped");
      void navigator.mediaDevices.enumerateDevices().then((devices) => {
        const audio = devices.filter((device) => device.kind === "audioinput");
        log("audio-device", "info", `${audio.length} audio input(s) now present`, {
          inputs: audio.map((device) => device.label || device.deviceId),
        });
      });
    };
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
  }, [armed, log]);

  // --- Web Bluetooth GATT -------------------------------------------------

  const pairBluetooth = useCallback(async () => {
    setError("");
    const generation = ++bluetoothGenerationRef.current;
    cleanupBluetooth();
    const isCurrent = () => mountedRef.current && generation === bluetoothGenerationRef.current;
    let device: BleDevice | null = null;
    const nav = navigator as ProbeNavigator;
    if (!nav.bluetooth) {
      setError("Web Bluetooth is unavailable in this browser. Chromium on Android or desktop only — never iOS Safari.");
      return;
    }
    const custom = extraServices
      .split(/[\s,]+/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    try {
      device = await nav.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [...DEFAULT_OPTIONAL_SERVICES, ...custom],
      });
      if (!isCurrent()) {
        device.gatt?.disconnect();
        return;
      }
      bleDeviceRef.current = device;
      log("ble-gatt", "info", `paired "${device.name || "(unnamed)"}"`, { id: device.id, name: device.name });
      const onDisconnected = () => {
        log("ble-gatt", "info", "gattserverdisconnected — an adapter must force a synthetic 'up' here");
      };
      device.addEventListener("gattserverdisconnected", onDisconnected);
      bleListenerRemoversRef.current.push(() =>
        device?.removeEventListener("gattserverdisconnected", onDisconnected),
      );

      const server = await device.gatt?.connect?.();
      if (!isCurrent()) {
        if (bleDeviceRef.current === device) cleanupBluetooth();
        else device.gatt?.disconnect();
        return;
      }
      const connected = server ?? device.gatt;
      if (!connected) {
        cleanupBluetooth();
        setError("Device exposed no GATT server.");
        return;
      }
      const services = await connected.getPrimaryServices();
      if (!isCurrent()) {
        if (bleDeviceRef.current === device) cleanupBluetooth();
        else device.gatt?.disconnect();
        return;
      }
      log("ble-gatt", "info", `${services.length} primary service(s) readable`);
      let subscribed = 0;
      for (const service of services) {
        if (!isCurrent()) return;
        const characteristics = await service.getCharacteristics();
        if (!isCurrent()) return;
        for (const characteristic of characteristics) {
          if (!isCurrent()) return;
          const flags = Object.entries(characteristic.properties)
            .filter(([, enabled]) => enabled)
            .map(([name]) => name)
            .join(",");
          log("ble-gatt", "info", `${service.uuid} → ${characteristic.uuid} [${flags}]`);
          if (!characteristic.properties.notify && !characteristic.properties.indicate) continue;
          try {
            await characteristic.startNotifications();
            if (!isCurrent()) {
              void characteristic.stopNotifications().catch(() => {});
              return;
            }
            bleCharacteristicsRef.current.push(characteristic);
            const onValueChanged = (event: Event) => {
              const target = event.target as unknown as BleCharacteristic;
              const value = target.value;
              log("ble-gatt", "info", `notify ${characteristic.uuid}: ${value ? toHex(value) : "(no value)"}`, {
                characteristic: characteristic.uuid,
                hex: value ? toHex(value) : null,
              });
            };
            characteristic.addEventListener("characteristicvaluechanged", onValueChanged);
            bleListenerRemoversRef.current.push(() =>
              characteristic.removeEventListener("characteristicvaluechanged", onValueChanged),
            );
            subscribed += 1;
          } catch {
            log("ble-gatt", "info", `could not subscribe to ${characteristic.uuid}`);
          }
        }
      }
      if (!isCurrent()) return;
      setNotice(
        subscribed > 0
          ? `Subscribed to ${subscribed} notifying characteristic(s). Press the PTT button now.`
          : "No notifying characteristics found. This device likely signals over HID, SPP, or a vendor intent instead.",
      );
    } catch (bluetoothError) {
      if (device && bleDeviceRef.current === device) cleanupBluetooth();
      else device?.gatt?.disconnect();
      if (!isCurrent()) return;
      const reason = bluetoothError instanceof Error ? bluetoothError.message : "unknown error";
      setError(`Bluetooth pairing failed: ${reason}`);
    }
  }, [cleanupBluetooth, extraServices, log]);

  // --- WebHID -------------------------------------------------------------

  const pairHid = useCallback(async () => {
    setError("");
    const generation = ++hidGenerationRef.current;
    cleanupHid();
    const isCurrent = () => mountedRef.current && generation === hidGenerationRef.current;
    const openedDevices: HidDevice[] = [];
    const nav = navigator as ProbeNavigator;
    if (!nav.hid) {
      setError("WebHID is unavailable in this browser. Chromium desktop and Android only.");
      return;
    }
    try {
      const devices = await nav.hid.requestDevice({ filters: [] });
      if (!isCurrent()) {
        await Promise.all(devices.map((device) =>
          device.opened ? device.close().catch(() => {}) : Promise.resolve(),
        ));
        return;
      }
      if (devices.length === 0) {
        setNotice("No HID device selected.");
        return;
      }
      for (const device of devices) {
        if (!isCurrent()) {
          await Promise.all(openedDevices.map((opened) => opened.close().catch(() => {})));
          return;
        }
        if (!device.opened) await device.open();
        if (!isCurrent()) {
          if (device.opened) await device.close().catch(() => {});
          await Promise.all(openedDevices.map((opened) => opened.close().catch(() => {})));
          return;
        }
        openedDevices.push(device);
        hidDevicesRef.current.push(device);
        log("webhid", "info", `opened "${device.productName || "(unnamed)"}"`, {
          vendorId: device.vendorId,
          productId: device.productId,
        });
        const onInputReport = (event: HidInputReportEvent) => {
          log("webhid", "info", `report ${event.reportId}: ${toHex(event.data)}`, {
            reportId: event.reportId,
            hex: toHex(event.data),
          });
        };
        device.addEventListener("inputreport", onInputReport);
        hidListenerRemoversRef.current.push(() => device.removeEventListener("inputreport", onInputReport));
      }
      if (!isCurrent()) return;
      setNotice(`Listening to ${devices.length} HID device(s). Press the PTT button now.`);
    } catch (hidError) {
      if (generation === hidGenerationRef.current) cleanupHid();
      await Promise.all(openedDevices.filter((device) => device.opened).map((device) => device.close().catch(() => {})));
      if (!isCurrent()) return;
      const reason = hidError instanceof Error ? hidError.message : "unknown error";
      setError(`HID pairing failed: ${reason}`);
    }
  }, [cleanupHid, log]);

  // --- Arm / disarm -------------------------------------------------------

  const arm = useCallback(async () => {
    setError("");
    seqRef.current = 0;
    armedAtRef.current = performance.now();
    if (support.mediaSession) {
      if (!silentUrlRef.current) silentUrlRef.current = createSilentLoopUrl();
      const audio = silentAudioRef.current ?? new Audio(silentUrlRef.current);
      audio.loop = true;
      audio.volume = 0;
      silentAudioRef.current = audio;
      try {
        await audio.play();
      } catch {
        setNotice("Silent keep-alive could not start; media-key capture may stay inactive.");
      }
    }
    setArmed(true);
    log("audio-device", "info", "probe armed — timestamps are relative to this moment");
  }, [support.mediaSession, log]);

  const disarm = useCallback(() => {
    bluetoothGenerationRef.current += 1;
    hidGenerationRef.current += 1;
    cleanupBluetooth();
    cleanupHid();
    silentAudioRef.current?.pause();
    setArmed(false);
  }, [cleanupBluetooth, cleanupHid]);

  useEffect(
    () => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        bluetoothGenerationRef.current += 1;
        hidGenerationRef.current += 1;
        silentAudioRef.current?.pause();
        if (silentUrlRef.current) URL.revokeObjectURL(silentUrlRef.current);
        cleanupBluetooth();
        cleanupHid();
      };
    },
    [cleanupBluetooth, cleanupHid],
  );

  // --- Export -------------------------------------------------------------

  const exportPayload = useMemo(
    () =>
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
          support,
          events: [...events].reverse(),
        },
        null,
        2,
      ),
    [events, support],
  );

  const copyReport = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(exportPayload);
      setNotice("Signal map copied to clipboard.");
    } catch {
      setError("Clipboard write was blocked. Use Download instead.");
    }
  }, [exportPayload]);

  const downloadReport = useCallback(() => {
    const url = URL.createObjectURL(new Blob([exportPayload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ptt-signal-map-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [exportPayload]);

  return (
    <div
      className="min-h-[calc(100vh-4rem)] bg-zinc-950 p-4 md:p-6 font-sans text-zinc-100"
      data-testid="page-ptt-accessory-probe"
    >
      <div className="mx-auto max-w-[1100px] flex flex-col gap-6">
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 rounded-xl bg-zinc-900 border border-zinc-800 p-4 shadow-sm">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-3">
              <Radio className="h-6 w-6 text-orange-500" />
              Accessory Signal Probe
            </h1>
            <p className="text-sm text-zinc-400 mt-1">
              Phase 0 discovery. Observes only — never requests the dispatch floor.
            </p>
          </div>
          <Badge
            className={cn(
              "px-3 py-1.5 uppercase tracking-wider text-[10px] font-bold",
              armed
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                : "bg-zinc-700/40 text-zinc-400 border border-zinc-600/40",
            )}
            data-testid="probe-armed-status"
          >
            {armed ? "Capturing" : "Idle"}
          </Badge>
        </header>

        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <span className="flex-1">{error}</span>
            <Button variant="ghost" size="sm" className="hover:bg-red-500/20" onClick={() => setError("")}>
              Dismiss
            </Button>
          </div>
        )}
        {notice && (
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-300">
            {notice}
          </div>
        )}

        <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <Input
              value={deviceLabel}
              onChange={(event) => setDeviceLabel(event.target.value)}
              placeholder="Accessory under test (e.g. Inrico B01, ANYSECU W-10)"
              className="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600"
              data-testid="probe-device-label"
            />
            <Button
              onClick={armed ? disarm : () => void arm()}
              className={cn("shrink-0", armed ? "bg-red-600 hover:bg-red-500" : "bg-emerald-600 hover:bg-emerald-500")}
              data-testid="probe-arm-toggle"
            >
              {armed ? <Square className="h-4 w-4 mr-2" /> : <Radio className="h-4 w-4 mr-2" />}
              {armed ? "Stop capture" : "Arm capture"}
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void pairBluetooth()} disabled={!support.bluetooth} data-testid="probe-pair-ble">
              <Bluetooth className="h-4 w-4 mr-2" />
              Pair BLE device
            </Button>
            <Button variant="outline" onClick={() => void pairHid()} disabled={!support.hid} data-testid="probe-pair-hid">
              <Usb className="h-4 w-4 mr-2" />
              Pair HID device
            </Button>
            <Button variant="outline" onClick={() => void listAudioDevices()} data-testid="probe-list-audio">
              <Mic className="h-4 w-4 mr-2" />
              List audio devices
            </Button>
          </div>

          <Input
            value={extraServices}
            onChange={(event) => setExtraServices(event.target.value)}
            placeholder="Extra BLE service UUIDs to request (comma or space separated)"
            className="bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-600 text-xs"
            data-testid="probe-extra-services"
          />

          <div className="flex flex-wrap gap-2 text-[11px] text-zinc-500">
            <span className={support.secureContext ? "text-emerald-500" : "text-red-400"}>
              secure context {support.secureContext ? "ok" : "missing"}
            </span>
            <span>·</span>
            <span className={support.bluetooth ? "text-emerald-500" : "text-zinc-600"}>Web Bluetooth</span>
            <span>·</span>
            <span className={support.hid ? "text-emerald-500" : "text-zinc-600"}>WebHID</span>
            <span>·</span>
            <span className={support.mediaSession ? "text-emerald-500" : "text-zinc-600"}>Media Session</span>
            <span>·</span>
            <span className={support.gamepad ? "text-emerald-500" : "text-zinc-600"}>Gamepad</span>
          </div>
        </section>

        <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs text-amber-200/90 flex gap-3">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />
          <div className="flex flex-col gap-1">
            <p>
              <span className="font-semibold">Vendor broadcast intents and SPP serial strings cannot be captured
              here.</span>{" "}
              No browser exposes them. If an accessory shows nothing on any channel below, that is itself the finding:
              it needs a native wrapper or companion app.
            </p>
            <p>
              Chrome blocklists the BLE HID service (0x1812), so BLE-HID buttons appear on the keyboard channel rather
              than as GATT notifications. Media Session capture only works while the silent keep-alive is playing.
            </p>
          </div>
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
            <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
              <Keyboard className="h-4 w-4 text-zinc-500" />
              Signal map
              <span className="text-zinc-500 font-normal">({events.length})</span>
            </h2>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => void copyReport()} disabled={events.length === 0}>
                <Copy className="h-4 w-4 mr-2" />
                Copy
              </Button>
              <Button variant="ghost" size="sm" onClick={downloadReport} disabled={events.length === 0}>
                <Download className="h-4 w-4 mr-2" />
                Download
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEvents([])} disabled={events.length === 0}>
                <Trash2 className="h-4 w-4 mr-2" />
                Clear
              </Button>
            </div>
          </div>

          {events.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-zinc-500" data-testid="probe-empty">
              <Gamepad2 className="h-5 w-5 mx-auto mb-2 text-zinc-700" />
              Arm the capture, name the accessory, then press and release its PTT button several times.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-800 max-h-[520px] overflow-y-auto" data-testid="probe-event-log">
              {events.map((event) => (
                <li key={event.seq} className="flex items-start gap-3 px-4 py-2 text-xs">
                  <span className="font-mono text-zinc-600 w-16 shrink-0 text-right">+{event.at}ms</span>
                  <Badge className={cn("shrink-0 border text-[10px] font-semibold", CHANNEL_STYLES[event.channel])}>
                    {event.channel}
                  </Badge>
                  <Badge className={cn("shrink-0 border text-[10px] font-semibold w-12 justify-center", EDGE_STYLES[event.edge])}>
                    {event.edge}
                  </Badge>
                  <span className="font-mono text-zinc-300 break-all flex-1">{event.detail}</span>
                  <span className="text-zinc-600 shrink-0 hidden md:inline">{event.device}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
