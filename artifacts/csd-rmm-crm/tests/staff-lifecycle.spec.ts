import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLifecycleHardware } from "./lifecycle-hardware";

declare global {
  interface Window {
    __hardware: {
      block(stage: string): void;
      waiting(): string;
      settle(reject?: boolean): Promise<void>;
      snapshot(): {
        listeners: number; connected: boolean; notifying: boolean; opened: boolean;
        actions: number; urls: number; pending: boolean;
      };
    };
    __lifecycle: {
      navigate(route: string): void;
      dirty(value: boolean): void;
      replaceCarousel(): void;
      emit(): void;
      late(): void;
      snapshot(): {
        streams: number; subscriptions: number; carouselHandlers: number;
        statusEvents: number; connectedEvents: number; navigationRestored: boolean;
      };
    };
    __resources(): { listeners: Record<string, number>; intervals: number; frames: number };
  }
}

async function openSession(page: Page) {
  await installLifecycleHardware(page);
  await page.addInitScript(() => {
    // Track only long-lived global targets. A WeakMap avoids retaining detached
    // React/Embla DOM nodes just because instrumentation once observed them.
    const registry = new WeakMap<EventTarget, Map<string, Set<unknown>>>();
    const originalAdd = EventTarget.prototype.addEventListener;
    const originalRemove = EventTarget.prototype.removeEventListener;
    const capture = (options?: boolean | AddEventListenerOptions) =>
      typeof options === "boolean" ? options : Boolean(options?.capture);
    EventTarget.prototype.addEventListener = function(type, callback, options) {
      if (callback && (this === window || this === document)) {
        let types = registry.get(this);
        if (!types) registry.set(this, types = new Map());
        const key = `${type}:${capture(options)}`;
        if (!types.has(key)) types.set(key, new Set());
        types.get(key)!.add(callback);
      }
      return originalAdd.call(this, type, callback, options);
    };
    EventTarget.prototype.removeEventListener = function(type, callback, options) {
      registry.get(this)?.get(`${type}:${capture(options)}`)?.delete(callback);
      return originalRemove.call(this, type, callback, options);
    };
    const intervals = new Set<number>();
    const setInterval = window.setInterval.bind(window);
    const clearInterval = window.clearInterval.bind(window);
    window.setInterval = ((...args: Parameters<typeof window.setInterval>) => {
      const id = setInterval(...args); intervals.add(id); return id;
    }) as typeof window.setInterval;
    window.clearInterval = (id) => {
      if (typeof id === "number") intervals.delete(id);
      clearInterval(id);
    };
    const frames = new Set<number>();
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => {
      const id = request(time => { frames.delete(id); callback(time); });
      frames.add(id);
      return id;
    };
    window.cancelAnimationFrame = id => { frames.delete(id); cancel(id); };
    window.__resources = () => {
      const listeners: Record<string, number> = {};
      for (const [name, target] of [["window", window], ["document", document]] as const) {
        for (const [type, callbacks] of registry.get(target) ?? []) {
          if (callbacks.size) listeners[`${name}:${type}`] = callbacks.size;
        }
      }
      return { listeners, intervals: intervals.size, frames: frames.size };
    };
  });
  // No real calls, customer data, or provider connections are used.
  await page.route("**/api/**", route => {
    if (route.request().url().includes("ringing-calls")) {
      return route.fulfill({ json: { ringing: [], checkedAt: new Date().toISOString() } });
    }
    return route.abort();
  });
  await page.goto("/tests/staff-lifecycle.fixture.html");
  await expect(page.getByRole("region", { name: "Incoming call alerts" })).toBeVisible();
  await expect(page.getByText("Incoming call sound is off", { exact: false })).toBeVisible();
  await navigate(page, "idle");
}

async function navigate(page: Page, route: string) {
  await page.evaluate(route => window.__lifecycle.navigate(`/session/${route}`), route);
  await expect(page.getByTestId("route")).toHaveText(`/session/${route}`);
}
const snapshot = (page: Page) => page.evaluate(() => ({
  resources: window.__resources(), hardware: window.__hardware.snapshot(),
  lifecycle: window.__lifecycle.snapshot(),
}));
async function assertIdle(page: Page, baseline: Awaited<ReturnType<typeof snapshot>>) {
  await expect.poll(async () => (await snapshot(page)).resources).toEqual(baseline.resources);
  const state = await snapshot(page);
  expect(state.hardware).toEqual(baseline.hardware);
  expect(state.lifecycle).toMatchObject({
    streams: 0, subscriptions: 0, carouselHandlers: 0, navigationRestored: true,
  });
}
async function cycle(page: Page) {
  await navigate(page, "form");
  await expect(page.getByRole("textbox", { name: "Draft" })).toBeVisible();
  await navigate(page, "carousel");
  await expect.poll(async () => (await snapshot(page)).lifecycle.carouselHandlers).toBe(2);
  await page.evaluate(() => window.__lifecycle.replaceCarousel());
  await expect.poll(async () => (await snapshot(page)).lifecycle.carouselHandlers).toBe(2);
  await navigate(page, "messages");
  await expect.poll(async () => (await snapshot(page)).lifecycle.subscriptions).toBe(2);
  const before = (await snapshot(page)).lifecycle.statusEvents;
  await page.evaluate(() => window.__lifecycle.emit());
  expect((await snapshot(page)).lifecycle.statusEvents).toBe(before + 1);
  await navigate(page, "probe");
  await page.getByTestId("probe-arm-toggle").click();
  await expect(page.getByTestId("probe-armed-status")).toHaveText("Capturing");
  await page.getByTestId("probe-pair-ble").click();
  await expect(page.getByTestId("page-ptt-accessory-probe")).toContainText("Subscribed to 1");
  await page.getByTestId("probe-pair-hid").click();
  await expect(page.getByTestId("page-ptt-accessory-probe")).toContainText("Listening to 1");
  await navigate(page, "idle");
  const stopped = (await snapshot(page)).lifecycle;
  await page.evaluate(() => window.__lifecycle.late());
  expect((await snapshot(page)).lifecycle).toEqual(stopped);
}

test("long staff session returns resources to baseline and bounds retained heap", async ({ page, context }, testInfo) => {
  test.setTimeout(300_000);
  const cycles = Number(process.env.LIFECYCLE_CYCLES ?? 120);
  expect(Number.isInteger(cycles) && cycles >= 60, "soak requires at least 60 cycles").toBe(true);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await openSession(page);
  const cdp = await context.newCDPSession(page);
  // Warm lazy React, Embla, module and browser caches before measuring retention.
  for (let i = 0; i < 10; i++) await cycle(page);
  const baseline = await snapshot(page);
  expect(baseline.resources.listeners["window:popstate:true"]).toBe(1);
  expect(baseline.resources.listeners["window:pushState:false"]).toBeGreaterThanOrEqual(1);
  expect(baseline.resources.intervals, "incoming-call freshness and polling remain active").toBeGreaterThanOrEqual(2);
  const samples: Array<{ cycle: number; heap: number; nodes: number; listeners: number }> = [];
  async function measure(cycle: number) {
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const dom = await cdp.send("Memory.getDOMCounters");
    samples.push({ cycle, heap: heap.usedSize, nodes: dom.nodes, listeners: dom.jsEventListeners });
  }
  await measure(0);
  for (let i = 1; i <= cycles; i++) {
    await cycle(page);
    await assertIdle(page, baseline);
    if (i % 20 === 0 || i === cycles) await measure(i);
  }
  // A new incoming call must still be observed after all the route churn.
  await page.route("**/api/twilio/ringing-calls", route => route.fulfill({
    json: { ringing: [{ id: "soak-call" }], checkedAt: new Date().toISOString() },
  }));
  await expect(page.getByText("Incoming CSD call — phones ringing.")).toBeVisible({ timeout: 10_000 });
  // Persist independently of the reporter: the default line reporter does not
  // write body-only attachments for successful tests.
  const report = testInfo.outputPath("lifecycle-retention.json");
  await writeFile(report, JSON.stringify({ cycles, baseline, samples }, null, 2));
  await testInfo.attach("lifecycle-retention.json", { path: report, contentType: "application/json" });
  const first = samples[0];
  const last = samples.at(-1)!;
  // Absolute retention budget plus a per-cycle slope budget catches sustained
  // growth while allowing V8/JIT and Vite bookkeeping to settle after warmup.
  expect(last.heap - first.heap, "retained JS heap growth").toBeLessThan(4 * 1024 * 1024);
  const tail = samples.slice(1);
  const meanX = tail.reduce((sum, s) => sum + s.cycle, 0) / tail.length;
  const meanY = tail.reduce((sum, s) => sum + s.heap, 0) / tail.length;
  const slope = tail.reduce((sum, s) => sum + (s.cycle - meanX) * (s.heap - meanY), 0)
    / tail.reduce((sum, s) => sum + (s.cycle - meanX) ** 2, 0);
  expect(slope, "retained bytes per route cycle").toBeLessThan(16 * 1024);
  expect(last.nodes - first.nodes, "detached DOM retention").toBeLessThan(100);
  expect(last.listeners - first.listeners, "retained DOM listeners").toBeLessThan(100);
  expect(errors).toEqual([]);
});

for (const stage of [
  "ble-chooser", "ble-connect", "ble-services", "ble-characteristics", "ble-notifications",
  "hid-chooser", "hid-open",
]) {
  test(`navigation cancels pending ${stage} without attaching stale listeners`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await openSession(page);
    const baseline = await snapshot(page);
    for (const reject of [false, true]) {
      await navigate(page, "probe");
      await page.getByTestId("probe-arm-toggle").click();
      await expect(page.getByTestId("probe-armed-status")).toHaveText("Capturing");
      await page.evaluate(stage => window.__hardware.block(stage), stage);
      await page.getByTestId(stage.startsWith("ble") ? "probe-pair-ble" : "probe-pair-hid").click();
      await expect.poll(() => page.evaluate(() => window.__hardware.waiting())).toBe(stage);
      await navigate(page, "idle");
      // Remount before the old promise settles: stale work must not bind to the
      // new probe, even if a later session already exists.
      await navigate(page, "probe");
      await page.evaluate(reject => window.__hardware.settle(reject), reject);
      await expect(page.getByTestId("probe-empty")).toBeVisible();
      await navigate(page, "idle");
      await assertIdle(page, baseline);
    }
    expect(errors).toEqual([]);
  });
}

test("persistent history protection still cancels Back after repeated guard replacement", async ({ page }) => {
  await openSession(page);
  const baseline = await snapshot(page);
  for (let i = 0; i < 30; i++) {
    await navigate(page, "form");
    await navigate(page, "idle");
  }
  await assertIdle(page, baseline);
  await navigate(page, "form");
  await page.evaluate(() => window.__lifecycle.dirty(true));
  let prompts = 0;
  page.on("dialog", async dialog => { prompts++; await dialog.dismiss(); });
  await page.goBack();
  await expect(page.getByTestId("route")).toHaveText("/session/form");
  await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue("Keep this draft");
  expect(prompts).toBe(1);
  await page.evaluate(() => window.__lifecycle.dirty(false));
  await navigate(page, "idle");
  await assertIdle(page, baseline);
});
