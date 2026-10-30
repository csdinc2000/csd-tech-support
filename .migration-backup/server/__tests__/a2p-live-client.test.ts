import { test } from "node:test";
import assert from "node:assert/strict";

import {
  subscribeA2PLive,
  ES_READYSTATE_OPEN,
  type A2PEventSource,
} from "../../client/src/lib/a2p-live";

/**
 * Client-side coverage for the Messages-page live banner subscription.
 *
 * The banner component (`A2pStatusBanner`) wires a real EventSource into
 * `subscribeA2PLive`; here we drive that same logic with a fake EventSource
 * so we can assert the reconnect / poll-fallback / cleanup behaviour without
 * a browser. Mirrors the `event: status` / `event: hello` shape published by
 * `server/a2p-events.ts`.
 */

const ES_CONNECTING = 0;
const ES_CLOSED = 2;

class FakeEventSource implements A2PEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = ES_CONNECTING;
  closed = false;

  private listeners: Record<string, Array<() => void>> = {};

  addEventListener(type: "status" | "hello", listener: () => void): void {
    (this.listeners[type] ||= []).push(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = ES_CLOSED;
  }

  // --- test helpers to simulate the server / network ---
  emit(type: "status" | "hello"): void {
    for (const l of this.listeners[type] || []) l();
  }
  fireOpen(): void {
    this.readyState = ES_READYSTATE_OPEN;
    this.onopen?.();
  }
  fireError(readyState: number): void {
    this.readyState = readyState;
    this.onerror?.();
  }
}

test("opens an EventSource and refreshes the banner on a 'status' event", () => {
  let created = 0;
  let statusRefreshes = 0;
  const connectedStates: boolean[] = [];
  let es!: FakeEventSource;

  const cleanup = subscribeA2PLive({
    createEventSource: () => {
      created++;
      es = new FakeEventSource();
      return es;
    },
    onStatus: () => statusRefreshes++,
    onConnectedChange: (c) => connectedStates.push(c),
    openState: ES_READYSTATE_OPEN,
  });

  // It opened exactly one stream and started in the not-yet-connected state.
  assert.equal(created, 1);
  assert.deepEqual(connectedStates, [false]);

  // Server confirms the stream is live (hello), then a status change arrives.
  es.emit("hello");
  assert.deepEqual(connectedStates, [false, true]);

  es.emit("status");
  assert.equal(statusRefreshes, 1, "status event should refresh the banner");

  cleanup();
});

test("native onopen also marks the stream connected", () => {
  const connectedStates: boolean[] = [];
  let es!: FakeEventSource;

  const cleanup = subscribeA2PLive({
    createEventSource: () => (es = new FakeEventSource()),
    onStatus: () => {},
    onConnectedChange: (c) => connectedStates.push(c),
  });

  es.fireOpen();
  assert.deepEqual(connectedStates, [false, true]);

  cleanup();
});

test("on a connection error it falls back to the poll (indicator not connected)", () => {
  const connectedStates: boolean[] = [];
  let es!: FakeEventSource;

  const cleanup = subscribeA2PLive({
    createEventSource: () => (es = new FakeEventSource()),
    onStatus: () => {},
    onConnectedChange: (c) => connectedStates.push(c),
    openState: ES_READYSTATE_OPEN,
  });

  // Connect, then the stream drops and EventSource is reconnecting.
  es.emit("hello");
  assert.deepEqual(connectedStates, [false, true]);

  es.fireError(ES_CONNECTING);
  assert.deepEqual(
    connectedStates,
    [false, true, false],
    "reconnecting error should flip back to the poll-fallback indicator",
  );

  // A permanent close (gave up) also reports not-connected; poll still covers it.
  es.fireError(ES_CLOSED);
  assert.deepEqual(connectedStates, [false, true, false, false]);

  cleanup();
});

test("a transient error while still OPEN does not flip the indicator", () => {
  const connectedStates: boolean[] = [];
  let es!: FakeEventSource;

  const cleanup = subscribeA2PLive({
    createEventSource: () => (es = new FakeEventSource()),
    onStatus: () => {},
    onConnectedChange: (c) => connectedStates.push(c),
    openState: ES_READYSTATE_OPEN,
  });

  es.fireOpen();
  assert.deepEqual(connectedStates, [false, true]);

  // Error event but the socket is still OPEN — stay in live mode.
  es.fireError(ES_READYSTATE_OPEN);
  assert.deepEqual(connectedStates, [false, true]);

  cleanup();
});

test("closes and cleans up the EventSource on unmount", () => {
  let statusRefreshes = 0;
  let es!: FakeEventSource;

  const cleanup = subscribeA2PLive({
    createEventSource: () => (es = new FakeEventSource()),
    onStatus: () => statusRefreshes++,
    onConnectedChange: () => {},
  });

  cleanup();
  assert.equal(es.closed, true, "unmount should close the stream");

  // Any late events after unmount must be ignored.
  es.emit("status");
  assert.equal(statusRefreshes, 0, "no refresh should fire after cleanup");
});

test("falls back to the poll when the EventSource can't be constructed", () => {
  const connectedStates: boolean[] = [];
  let statusRefreshes = 0;

  const cleanup = subscribeA2PLive({
    createEventSource: () => {
      throw new Error("EventSource blocked");
    },
    onStatus: () => statusRefreshes++,
    onConnectedChange: (c) => connectedStates.push(c),
  });

  // Reports not-connected (poll mode) and never wires up a status refresh.
  assert.deepEqual(connectedStates, [false]);
  assert.equal(statusRefreshes, 0);

  // Cleanup is safe to call even though no stream was created.
  assert.doesNotThrow(() => cleanup());
});
