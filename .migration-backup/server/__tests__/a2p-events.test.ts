import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import path from "path";
import http from "http";
import express from "express";

// storage -> ./db throws unless DATABASE_URL is present at import time. The
// monitor's test seam swaps the storage singleton for a fake, so no real DB
// connection is ever opened — but the env var must exist before the import
// chain runs. Mirror the sibling a2p-monitor.test.ts setup.
process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const STATE_FILE = path.join(process.cwd(), ".local", "a2p-monitor-state.json");

type A2PStatusResult = import("../a2p-status").A2PStatusResult;
type Alert = import("@shared/schema").Alert;

const events = await import("../a2p-events");
const {
  fingerprintA2PResult,
  addA2PEventClient,
  a2pEventClientCount,
  publishA2PStatusChange,
} = events;

const monitor = await import("../a2p-monitor");
const { runA2PMonitorOnce, __setA2PMonitorDepsForTests } = monitor;

function statusResult(overrides: Partial<A2PStatusResult>): A2PStatusResult {
  return {
    configured: true,
    status: "approved",
    brands: [],
    campaigns: [],
    bundleRejections: [],
    error: null,
    ...overrides,
  } as A2PStatusResult;
}

// ---------------------------------------------------------------------------
// Unit tests: fingerprintA2PResult
// ---------------------------------------------------------------------------

test("fingerprintA2PResult: same result yields identical fingerprint (no-op)", () => {
  const a = statusResult({
    status: "approved",
    brands: [{ sid: "BN1", status: "APPROVED", failureReason: null }],
  });
  const b = statusResult({
    status: "approved",
    brands: [{ sid: "BN1", status: "APPROVED", failureReason: null }],
  });
  assert.equal(
    fingerprintA2PResult(a),
    fingerprintA2PResult(b),
    "structurally identical results must fingerprint the same",
  );
});

test("fingerprintA2PResult: top-level status change flips the fingerprint", () => {
  const before = statusResult({ status: "pending" });
  const after = statusResult({ status: "approved" });
  assert.notEqual(
    fingerprintA2PResult(before),
    fingerprintA2PResult(after),
    "a status verdict change must produce a different fingerprint",
  );
});

test("fingerprintA2PResult: adding a rejection flips the fingerprint", () => {
  const clean = statusResult({ status: "pending", bundleRejections: [] });
  const withRejection = statusResult({
    status: "pending",
    bundleRejections: [
      {
        bundleSid: "BU1",
        section: "business",
        field: "business_name",
        failureReason: "Name mismatch",
      },
    ],
  });
  assert.notEqual(
    fingerprintA2PResult(clean),
    fingerprintA2PResult(withRejection),
    "adding a rejection must produce a different fingerprint",
  );
});

test("fingerprintA2PResult: removing a rejection flips the fingerprint", () => {
  const withRejection = statusResult({
    status: "rejected",
    bundleRejections: [
      {
        bundleSid: "BU1",
        section: "business",
        field: "business_name",
        failureReason: "Name mismatch",
      },
    ],
  });
  const cleared = statusResult({ status: "rejected", bundleRejections: [] });
  assert.notEqual(
    fingerprintA2PResult(withRejection),
    fingerprintA2PResult(cleared),
    "removing a rejection must produce a different fingerprint",
  );
});

test("fingerprintA2PResult: rejection ordering does not matter (deterministic)", () => {
  const order1 = statusResult({
    status: "rejected",
    bundleRejections: [
      { bundleSid: "BU1", section: "business", field: "a", failureReason: "x" },
      { bundleSid: "BU2", section: "rep", field: "b", failureReason: "y" },
    ],
  });
  const order2 = statusResult({
    status: "rejected",
    bundleRejections: [
      { bundleSid: "BU2", section: "rep", field: "b", failureReason: "y" },
      { bundleSid: "BU1", section: "business", field: "a", failureReason: "x" },
    ],
  });
  assert.equal(
    fingerprintA2PResult(order1),
    fingerprintA2PResult(order2),
    "fingerprint must be order-independent so reordering alone never pushes",
  );
});

// ---------------------------------------------------------------------------
// Integration tests: SSE delivery driven by the real monitor publish path.
//
// We mount the exact same handler the production route uses
// (addA2PEventClient + req close/error cleanup) on a throwaway Express app,
// minus the auth wrapper which is not what's under test here. A real HTTP
// client connects, then runA2PMonitorOnce() runs with a mocked Twilio
// result — exercising fingerprint diffing -> publishA2PStatusChange ->
// over-the-wire SSE delivery end to end.
// ---------------------------------------------------------------------------

let currentStatus: A2PStatusResult;

const fakeStorage = {
  async getActiveAlerts() {
    return [] as Alert[];
  },
  async createAlert(input: Partial<Alert> & { title: string }) {
    return { id: 1, ...input } as unknown as Alert;
  },
  async updateAlert() {
    return undefined;
  },
} as unknown as typeof import("../storage").storage;

const sgMailStub = {
  setApiKey(_k: string) {},
  async send() {
    return [{ statusCode: 202 }, {}];
  },
} as unknown as typeof import("@sendgrid/mail").default;

let server: http.Server;
let baseUrl: string;
const openSockets = new Set<http.ClientRequest>();

before(async () => {
  __setA2PMonitorDepsForTests({
    getA2PStatus: async () => currentStatus,
    storage: fakeStorage,
    sgMail: sgMailStub,
  });

  const app = express();
  app.get("/api/twilio/a2p/events", (req, res) => {
    const cleanup = addA2PEventClient(res);
    req.on("close", cleanup);
    req.on("error", cleanup);
  });

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr && typeof addr === "object") {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  } else {
    throw new Error("failed to bind test server");
  }
});

after(async () => {
  __setA2PMonitorDepsForTests(null);
  for (const req of openSockets) req.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await fs.rm(STATE_FILE, { force: true });
});

/**
 * Open an SSE connection and resolve once the server has registered us
 * (signalled by the initial `hello` event). Returns a live accumulator of
 * everything received plus a destroyer.
 */
function connectSse(): Promise<{
  received: () => string;
  destroy: () => void;
}> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/api/twilio/a2p/events`, (res) => {
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.includes("event: hello")) {
          resolve({
            received: () => buffer,
            destroy: () => req.destroy(),
          });
        }
      });
      res.on("error", () => {});
    });
    openSockets.add(req);
    req.on("error", reject);
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() - start >= timeoutMs) return resolve(false);
      setTimeout(tick, 15);
    };
    tick();
  });
}

function fakeSseResponse(write: (payload: string) => boolean): {
  res: import("express").Response;
  ended: () => boolean;
} {
  let didEnd = false;
  const res = {
    setHeader() {
      return this;
    },
    flushHeaders() {},
    write,
    end() {
      didEnd = true;
      return this;
    },
  } as unknown as import("express").Response;
  return { res, ended: () => didEnd };
}

test("monitor cycle with a changed result delivers a 'status' SSE event to a connected client", async () => {
  const conn = await connectSse();
  assert.equal(a2pEventClientCount(), 1, "client should be registered before running the monitor");

  // First-ever cycle: fingerprint goes from null -> something, so it must push.
  currentStatus = statusResult({
    status: "rejected",
    brands: [{ sid: "BN1", status: "FAILED", failureReason: "Bad EIN" }],
  });
  await runA2PMonitorOnce();

  const got = await waitFor(() => conn.received().includes("event: status"));
  assert.ok(got, "a 'status' SSE event should be delivered after a changed cycle");
  assert.match(conn.received(), /"status":"rejected"/, "payload should carry the new status verdict");

  conn.destroy();
});

test("a no-change cycle does NOT push a second 'status' event (de-dup via lastFingerprint)", async () => {
  const conn = await connectSse();

  // Cycle 1: changed result -> one push.
  currentStatus = statusResult({ status: "rejected" });
  await runA2PMonitorOnce();
  const firstPush = await waitFor(() => conn.received().includes("event: status"));
  assert.ok(firstPush, "first changed cycle should push exactly one status event");

  // Cycle 2: identical result -> fingerprint matches persisted state -> no push.
  currentStatus = statusResult({ status: "rejected" });
  await runA2PMonitorOnce();
  // Give any erroneous push time to arrive before asserting absence.
  await new Promise((r) => setTimeout(r, 200));

  const statusEventCount = conn.received().split("event: status").length - 1;
  assert.equal(
    statusEventCount,
    1,
    "an unchanged cycle must not deliver a second status event",
  );

  conn.destroy();
});

test("a no-client cycle is a safe no-op (publish short-circuits with zero clients)", async () => {
  assert.equal(a2pEventClientCount(), 0, "no clients should be connected at start");
  currentStatus = statusResult({ status: "approved" });
  // Should not throw even though there's nobody to push to.
  await runA2PMonitorOnce();
  assert.equal(a2pEventClientCount(), 0, "still no clients after the cycle");
});

test("closing an HTTP SSE connection unregisters the banner client", async () => {
  const conn = await connectSse();
  assert.equal(a2pEventClientCount(), 1, "client should be registered while connected");

  conn.destroy();

  const removed = await waitFor(() => a2pEventClientCount() === 0);
  assert.ok(removed, "the request close handler should unregister the disconnected client");
});

test("publishing prunes a client whose socket write throws", () => {
  let writes = 0;
  const fake = fakeSseResponse(() => {
    writes += 1;
    if (writes > 2) throw new Error("socket closed");
    return true;
  });
  addA2PEventClient(fake.res);
  assert.equal(a2pEventClientCount(), 1, "fake client should be registered");

  publishA2PStatusChange(statusResult({ status: "rejected" }));

  assert.equal(a2pEventClientCount(), 0, "failed publish should prune the broken client");
  assert.ok(fake.ended(), "failed publish should run the full client cleanup");
});

test("heartbeat cleans up a client when socket write returns false", async () => {
  let writes = 0;
  const fake = fakeSseResponse(() => {
    writes += 1;
    return writes <= 2;
  });
  addA2PEventClient(fake.res, 5);
  assert.equal(a2pEventClientCount(), 1, "fake client should be registered");

  const removed = await waitFor(() => a2pEventClientCount() === 0);

  assert.ok(removed, "a failed heartbeat write should unregister the client");
  assert.ok(fake.ended(), "heartbeat failure should close the response");
});
