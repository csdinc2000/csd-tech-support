import type { Page } from "@playwright/test";

/** Deferred browser APIs let navigation win at every await boundary, without hardware. */
export async function installLifecycleHardware(page: Page) {
  await page.addInitScript(() => {
    const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    function target(name: string) {
      const events = new EventTarget();
      return {
        addEventListener(type: string, callback: EventListenerOrEventListenerObject) {
          const key = `${name}:${type}`;
          if (!listeners.has(key)) listeners.set(key, new Set());
          listeners.get(key)!.add(callback);
          events.addEventListener(type, callback);
        },
        removeEventListener(type: string, callback: EventListenerOrEventListenerObject) {
          listeners.get(`${name}:${type}`)?.delete(callback);
          events.removeEventListener(type, callback);
        },
      };
    }
    let blocked = "";
    let pending: { resolve: () => void; reject: () => void } | null = null;
    let waiting = "";
    let connected = false;
    let notifying = false;
    let opened = false;
    const pause = async (stage: string) => {
      if (blocked !== stage) return;
      waiting = stage;
      try {
        await new Promise<void>((resolve, reject) => {
          pending = { resolve, reject: () => reject(new Error("Pairing cancelled")) };
        });
      } finally {
        pending = null;
        waiting = "";
        blocked = "";
      }
    };
    const characteristic = {
      ...target("notification"),
      uuid: "ffe1",
      properties: { notify: true },
      async startNotifications() {
        await pause("ble-notifications");
        notifying = true;
        return characteristic;
      },
      async stopNotifications() { notifying = false; },
    };
    const service = {
      uuid: "ffe0",
      async getCharacteristics() {
        await pause("ble-characteristics");
        return [characteristic];
      },
    };
    const gatt = {
      get connected() { return connected; },
      async connect() { await pause("ble-connect"); connected = true; return gatt; },
      async getPrimaryServices() { await pause("ble-services"); return [service]; },
      disconnect() { connected = false; },
    };
    const ble = { ...target("bluetooth"), id: "test-ble", name: "Test BLE", gatt };
    const hid = {
      ...target("hid"),
      productName: "Test HID", vendorId: 1, productId: 2,
      get opened() { return opened; },
      async open() { await pause("hid-open"); opened = true; },
      async close() { opened = false; },
    };
    Object.defineProperty(navigator, "bluetooth", { configurable: true, value: {
      async requestDevice() { await pause("ble-chooser"); return ble; },
    } });
    Object.defineProperty(navigator, "hid", { configurable: true, value: {
      async requestDevice() { await pause("hid-chooser"); return [hid]; },
    } });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      ...target("media"),
      async enumerateDevices() { return []; },
    } });
    const actions = new Map<string, unknown>();
    Object.defineProperty(navigator, "mediaSession", { configurable: true, value: {
      playbackState: "none",
      setActionHandler(action: string, handler: unknown) {
        if (handler) actions.set(action, handler);
        else actions.delete(action);
      },
    } });
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    HTMLMediaElement.prototype.pause = () => {};
    const urls = new Set<string>();
    const createUrl = URL.createObjectURL.bind(URL);
    const revokeUrl = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      const url = createUrl(blob); urls.add(url); return url;
    };
    URL.revokeObjectURL = (url: string) => { urls.delete(url); revokeUrl(url); };
    Object.assign(window, { __hardware: {
      block(stage: string) { blocked = stage; },
      waiting: () => waiting,
      async settle(reject = false) {
        if (!pending) throw new Error("No pending pairing operation");
        if (reject) pending.reject(); else pending.resolve();
        // Drain the finite promise chain after chooser/connect/notification completion.
        for (let i = 0; i < 30; i++) await Promise.resolve();
      },
      snapshot: () => ({
        listeners: [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
        connected, notifying, opened, actions: actions.size, urls: urls.size,
        pending: pending !== null,
      }),
    } });
  });
}
