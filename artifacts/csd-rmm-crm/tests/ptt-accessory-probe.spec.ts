import { expect, test, type Page } from "@playwright/test";

type ProbeWindow = Window & {
  __probeTest: {
    bleOptions: { optionalServices?: string[] } | null;
    clipboard: string[];
    downloads: Array<{ href: string; download: string }>;
    socketUrls: () => string[];
    getUserMediaCalls: () => number;
    emitNotify: (bytes: number[]) => void;
    emitReport: (reportId: number, bytes: number[]) => void;
    disconnectBle: () => void;
    fireDeviceChange: () => void;
    failNextGetUserMedia: (message: string) => void;
    failNextRequestDevice: (message: string) => void;
    listenerCounts: () => { bluetooth: number; notifications: number; hid: number };
  };
};

const probe = (page: Page) => page.evaluate(() => (window as unknown as ProbeWindow).__probeTest);

/** Fakes every accessory API the probe observes. No hardware is involved. */
async function installAccessoryFakes(page: Page) {
  await page.addInitScript(() => {
    let getUserMediaCalls = 0;
    const socketUrls: string[] = [];
    let getUserMediaError: string | null = null;
    let requestDeviceError: string | null = null;
    const deviceChangeHandlers: Array<() => void> = [];
    const mediaHandlers: Record<string, (() => void) | null> = {};
    let notifyHandler: ((event: { target: unknown }) => void) | null = null;
    let reportHandler: ((event: { reportId: number; data: DataView }) => void) | null = null;
    let bleDisconnectHandler: (() => void) | null = null;

    const notifyingCharacteristic = {
      uuid: "0000ffe1-0000-1000-8000-00805f9b34fb",
      properties: { notify: true, indicate: false, read: true, write: false, writeWithoutResponse: false },
      value: null as DataView | null,
      startNotifications() {
        return Promise.resolve(this);
      },
      stopNotifications() {
        return Promise.resolve(this);
      },
      addEventListener(_type: string, handler: (event: { target: unknown }) => void) {
        notifyHandler = handler;
      },
      removeEventListener(_type: string, handler: (event: { target: unknown }) => void) {
        if (notifyHandler === handler) notifyHandler = null;
      },
    };

    const plainCharacteristic = {
      uuid: "0000ffe2-0000-1000-8000-00805f9b34fb",
      properties: { notify: false, indicate: false, read: true, write: true, writeWithoutResponse: false },
      value: null as DataView | null,
      startNotifications: () => Promise.resolve(plainCharacteristic),
      addEventListener: () => {},
    };

    const gattServer = {
      connected: true,
      connect() {
        return Promise.resolve(gattServer);
      },
      getPrimaryServices: () =>
        Promise.resolve([
          {
            uuid: "0000ffe0-0000-1000-8000-00805f9b34fb",
            getCharacteristics: () => Promise.resolve([notifyingCharacteristic, plainCharacteristic]),
          },
        ]),
      disconnect: () => {},
    };

    const bleDevice = {
      id: "ble-device-1",
      name: "Inrico B01",
      gatt: gattServer,
      addEventListener(_type: string, handler: () => void) {
        bleDisconnectHandler = handler;
      },
      removeEventListener(_type: string, handler: () => void) {
        if (bleDisconnectHandler === handler) bleDisconnectHandler = null;
      },
    };

    const hidDevice = {
      productName: "ANYSECU PTT",
      vendorId: 0x1234,
      productId: 0x5678,
      opened: false,
      open() {
        this.opened = true;
        return Promise.resolve();
      },
      addEventListener(_type: string, handler: (event: { reportId: number; data: DataView }) => void) {
        reportHandler = handler;
      },
      removeEventListener(_type: string, handler: (event: { reportId: number; data: DataView }) => void) {
        if (reportHandler === handler) reportHandler = null;
      },
      close() {
        this.opened = false;
        return Promise.resolve();
      },
    };

    const control = {
      listenerCounts: () => ({
        bluetooth: Number(bleDisconnectHandler !== null),
        notifications: Number(notifyHandler !== null),
        hid: Number(reportHandler !== null),
      }),
      bleOptions: null as unknown,
      clipboard: [] as string[],
      downloads: [] as Array<{ href: string; download: string }>,
      socketUrls: () => socketUrls.slice(),
      getUserMediaCalls: () => getUserMediaCalls,
      emitNotify(bytes: number[]) {
        notifyingCharacteristic.value = new DataView(new Uint8Array(bytes).buffer);
        notifyHandler?.({ target: notifyingCharacteristic });
      },
      emitReport(reportId: number, bytes: number[]) {
        reportHandler?.({ reportId, data: new DataView(new Uint8Array(bytes).buffer) });
      },
      disconnectBle: () => bleDisconnectHandler?.(),
      fireDeviceChange: () => deviceChangeHandlers.forEach((handler) => handler()),
      failNextGetUserMedia: (message: string) => {
        getUserMediaError = message;
      },
      failNextRequestDevice: (message: string) => {
        requestDeviceError = message;
      },
      invokeMedia: (action: string) => mediaHandlers[action]?.(),
    };

    Object.defineProperty(navigator, "bluetooth", {
      configurable: true,
      value: {
        requestDevice: (options: unknown) => {
          control.bleOptions = options;
          if (requestDeviceError) {
            const message = requestDeviceError;
            requestDeviceError = null;
            return Promise.reject(new Error(message));
          }
          return Promise.resolve(bleDevice);
        },
      },
    });

    Object.defineProperty(navigator, "hid", {
      configurable: true,
      value: { requestDevice: () => Promise.resolve([hidDevice]) },
    });

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => {
          getUserMediaCalls += 1;
          if (getUserMediaError) {
            const message = getUserMediaError;
            getUserMediaError = null;
            return Promise.reject(new Error(message));
          }
          return Promise.resolve({ getTracks: () => [{ stop: () => {} }] });
        },
        enumerateDevices: () =>
          Promise.resolve([
            { kind: "audioinput", label: "Inrico B01 Hands-Free", deviceId: "mic-1", groupId: "g1" },
            { kind: "audiooutput", label: "Inrico B01 Hands-Free", deviceId: "spk-1", groupId: "g1" },
            { kind: "videoinput", label: "Webcam", deviceId: "cam-1", groupId: "g2" },
          ]),
        addEventListener: (_type: string, handler: () => void) => deviceChangeHandlers.push(handler),
        removeEventListener: () => {},
      },
    });

    Object.defineProperty(navigator, "mediaSession", {
      configurable: true,
      value: {
        playbackState: "none",
        setActionHandler: (action: string, handler: (() => void) | null) => {
          mediaHandlers[action] = handler;
        },
      },
    });

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (text: string) => { control.clipboard.push(text); return Promise.resolve(); } },
    });

    // The silent keep-alive must resolve rather than hit autoplay policy.
    HTMLMediaElement.prototype.play = () => Promise.resolve();

    // downloadReport revokes the object URL on the next line, which races a
    // real download event — record the click instead.
    HTMLAnchorElement.prototype.click = function recordClick(this: HTMLAnchorElement) {
      control.downloads.push({ href: this.href, download: this.download });
    };

    // Vite's HMR client also constructs a WebSocket, so record URLs rather
    // than a bare count.
    class RecordingSocket {
      constructor(url: string | URL) {
        socketUrls.push(String(url));
      }
      send() {}
      close() {}
    }
    Object.defineProperty(window, "WebSocket", { value: RecordingSocket });

    Object.assign(window, { __probeTest: control });
  });

  await page.route("**/api/**", (route) => route.abort());
}

async function openProbe(page: Page) {
  await installAccessoryFakes(page);
  await page.goto("/tests/ptt-accessory-probe.fixture.html");
  await expect(page.getByTestId("page-ptt-accessory-probe")).toBeVisible();
}

async function arm(page: Page, label = "Inrico B01") {
  await page.getByTestId("probe-device-label").fill(label);
  await page.getByTestId("probe-arm-toggle").click();
  await expect(page.getByTestId("probe-armed-status")).toHaveText("Capturing");
}

const rows = (page: Page) => page.getByTestId("probe-event-log").locator("li");

test("the idle probe captures nothing and offers nothing to export", async ({ page }) => {
  await openProbe(page);
  await expect(page.getByTestId("probe-empty")).toBeVisible();
  await expect(page.getByTestId("probe-armed-status")).toHaveText("Idle");
  await expect(page.getByRole("button", { name: "Copy" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Download" })).toBeDisabled();
});

test("unsupported capture channels are disabled before the page loads", async ({ page }) => {
  // Capability is a useMemo fixed at mount, so it must be decided up front.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "bluetooth", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "hid", { configurable: true, value: undefined });
  });
  await page.route("**/api/**", (route) => route.abort());
  await page.goto("/tests/ptt-accessory-probe.fixture.html");

  await expect(page.getByTestId("probe-pair-ble")).toBeDisabled();
  await expect(page.getByTestId("probe-pair-hid")).toBeDisabled();
});

test("arming captures keyboard edges and disarming stops capture", async ({ page }) => {
  await openProbe(page);
  await arm(page);
  // Arming itself logs one marker row.
  await expect(rows(page)).toHaveCount(1);

  await page.keyboard.down("KeyT");
  await page.keyboard.up("KeyT");
  await expect(rows(page)).toHaveCount(3);

  // Newest first: the key-up is row 0.
  await expect(rows(page).nth(0)).toContainText("up");
  await expect(rows(page).nth(0)).toContainText('code="KeyT"');
  await expect(rows(page).nth(1)).toContainText("down");
  await expect(rows(page).nth(1)).toContainText("Inrico B01");

  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", code: "KeyT", repeat: true, bubbles: true })),
  );
  await expect(rows(page).nth(0)).toContainText("(repeat)");

  await page.getByTestId("probe-arm-toggle").click();
  await expect(page.getByTestId("probe-armed-status")).toHaveText("Idle");
  const settled = await rows(page).count();
  await page.keyboard.down("KeyY");
  await page.keyboard.up("KeyY");
  await page.waitForTimeout(150);
  expect(await rows(page).count()).toBe(settled);
});

test("clearing the log returns the probe to its empty state", async ({ page }) => {
  await openProbe(page);
  await arm(page);
  await page.keyboard.down("KeyT");
  await page.keyboard.up("KeyT");
  await expect(rows(page)).toHaveCount(3);

  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page.getByTestId("probe-empty")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy" })).toBeDisabled();
});

test("HID input reports are logged as hex", async ({ page }) => {
  await openProbe(page);
  await arm(page, "ANYSECU PTT");
  await page.getByTestId("probe-pair-hid").click();
  await expect(page.getByTestId("page-ptt-accessory-probe")).toContainText("Listening to 1 HID device(s)");

  await page.evaluate(() => (window as unknown as ProbeWindow).__probeTest.emitReport(1, [0x01, 0xa0]));
  await expect(rows(page).nth(0)).toContainText("report 1: 01 a0");
  await expect(rows(page).nth(0)).toContainText("webhid");
});

test("paired accessory listeners detach on disarm without accumulating after rearming", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openProbe(page);
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await arm(page);
    await page.getByTestId("probe-pair-ble").click();
    await expect(page.getByTestId("page-ptt-accessory-probe")).toContainText(
      "Subscribed to 1 notifying characteristic(s)",
    );
    await page.getByTestId("probe-pair-hid").click();
    await expect(page.getByTestId("page-ptt-accessory-probe")).toContainText("Listening to 1 HID device(s)");
    expect(await page.evaluate(() =>
      (window as unknown as ProbeWindow).__probeTest.listenerCounts(),
    )).toEqual({ bluetooth: 1, notifications: 1, hid: 1 });

    await page.getByTestId("probe-arm-toggle").click();
    await expect(page.getByTestId("probe-armed-status")).toHaveText("Idle");
    expect(await page.evaluate(() =>
      (window as unknown as ProbeWindow).__probeTest.listenerCounts(),
    )).toEqual({ bluetooth: 0, notifications: 0, hid: 0 });
    const count = await rows(page).count();
    await page.evaluate(() => {
      const control = (window as unknown as ProbeWindow).__probeTest;
      control.emitNotify([1]);
      control.emitReport(1, [1]);
      control.disconnectBle();
    });
    await expect(rows(page)).toHaveCount(count);
  }
  expect(errors).toEqual([]);
});

test("BLE pairing requests custom services and logs notifications and disconnects", async ({ page }) => {
  await openProbe(page);
  await arm(page);
  await page.getByTestId("probe-extra-services").fill("ABCD, 0000FF01-0000-1000-8000-00805F9B34FB");
  await page.getByTestId("probe-pair-ble").click();
  await expect(page.getByTestId("page-ptt-accessory-probe")).toContainText(
    "Subscribed to 1 notifying characteristic(s)",
  );

  const requested = (await probe(page)).bleOptions?.optionalServices ?? [];
  expect(requested).toContain("battery_service");
  expect(requested).toContain("6e400001-b5a3-f393-e0a9-e50e24dcca9e");
  expect(requested, "custom UUIDs are lower-cased").toContain("abcd");
  expect(requested).toContain("0000ff01-0000-1000-8000-00805f9b34fb");

  const log = page.getByTestId("probe-event-log");
  await expect(log).toContainText('paired "Inrico B01"');
  await expect(log).toContainText("0000ffe1-0000-1000-8000-00805f9b34fb [notify,read]");

  await page.evaluate(() => (window as unknown as ProbeWindow).__probeTest.emitNotify([0xff, 0x01]));
  await expect(rows(page).nth(0)).toContainText("notify 0000ffe1-0000-1000-8000-00805f9b34fb: ff 01");

  await page.evaluate(() => (window as unknown as ProbeWindow).__probeTest.disconnectBle());
  await expect(rows(page).nth(0)).toContainText("gattserverdisconnected");
});

test("audio devices and hot-plug events are recorded with their deviceIds", async ({ page }) => {
  await openProbe(page);
  await arm(page);
  await page.getByTestId("probe-list-audio").click();
  await expect(page.getByTestId("page-ptt-accessory-probe")).toContainText("AudioRouteManager.routeTo()");

  const log = page.getByTestId("probe-event-log");
  await expect(log).toContainText("audioinput: Inrico B01 Hands-Free");
  await expect(log).toContainText("audiooutput: Inrico B01 Hands-Free");
  await expect(log, "video devices are not audio routes").not.toContainText("Webcam");

  await page.evaluate(() => (window as unknown as ProbeWindow).__probeTest.fireDeviceChange());
  await expect(log).toContainText("devicechange fired");
  await expect(log).toContainText("1 audio input(s) now present");
});

test("failed permissions and pairings surface as dismissible errors", async ({ page }) => {
  await openProbe(page);
  await page.evaluate(() =>
    (window as unknown as ProbeWindow).__probeTest.failNextGetUserMedia("Permission denied"),
  );
  await page.getByTestId("probe-list-audio").click();
  const banner = page.getByText("Could not enumerate audio devices: Permission denied");
  await expect(banner).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toHaveCount(0);

  await page.evaluate(() =>
    (window as unknown as ProbeWindow).__probeTest.failNextRequestDevice("User cancelled"),
  );
  await page.getByTestId("probe-pair-ble").click();
  await expect(page.getByText("Bluetooth pairing failed: User cancelled")).toBeVisible();
});

test("the exported signal map is chronological and complete", async ({ page }) => {
  await openProbe(page);
  await arm(page);
  await page.keyboard.down("KeyT");
  await page.keyboard.up("KeyT");

  await page.getByRole("button", { name: "Copy" }).click();
  const copied = (await probe(page)).clipboard;
  expect(copied).toHaveLength(1);
  const report = JSON.parse(copied[0]) as {
    support: Record<string, boolean>;
    userAgent: string;
    events: Array<{ seq: number; channel: string; edge: string; device: string }>;
  };
  expect(report.userAgent).toBeTruthy();
  expect(report.support.bluetooth).toBe(true);
  expect(report.events.length).toBe(3);
  expect(report.events[0].seq, "exported oldest-first").toBeLessThan(report.events[1].seq);
  expect(report.events.at(-1)).toMatchObject({ channel: "hid", edge: "up", device: "Inrico B01" });

  await page.getByRole("button", { name: "Download" }).click();
  const downloads = (await probe(page)).downloads;
  expect(downloads).toHaveLength(1);
  expect(downloads[0].download).toMatch(/^ptt-signal-map-\d+\.json$/);
});

test("the probe never opens a dispatch socket or the microphone on its own", async ({ page }) => {
  await openProbe(page);
  await arm(page);
  await page.getByTestId("probe-pair-hid").click();
  await page.getByTestId("probe-pair-ble").click();
  await page.keyboard.down("KeyT");
  await page.keyboard.up("KeyT");

  // Call through in-page: functions do not survive evaluate serialization.
  const counts = await page.evaluate(() => {
    const control = (window as unknown as ProbeWindow).__probeTest;
    return { sockets: control.socketUrls(), microphones: control.getUserMediaCalls() };
  });
  expect(
    counts.sockets.filter((url) => url.includes("/ws/")),
    "observation only: no dispatch signaling socket",
  ).toEqual([]);
  expect(counts.microphones, "no microphone unless explicitly requested").toBe(0);
});
