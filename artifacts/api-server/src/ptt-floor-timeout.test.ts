import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { WebSocket, type WebSocketServer } from "ws";
import { createPttSessionToken, setupPttServer } from "./ptt.ts";

// Set before setupPttServer runs: the limit is read once per server. The suite
// runs in its own process and run-tests.mjs is serial, so this cannot leak.
// There are no fake timers in this package, so the limit has to be short enough
// for a real-clock wait to stay inside waitFor's 2 s default.
const TRANSMIT_LIMIT_MS = 600;
// waitFor headroom for the cut itself: generous, because the assertion that
// matters is that it happens, not precisely when.
const CUT_TIMEOUT_MS = 6_000;
process.env.PTT_MAX_TRANSMIT_MS = String(TRANSMIT_LIMIT_MS);

type ServerMessage = {
  type: string;
  clientId?: string;
  users?: Array<{ id: string; name: string }>;
  user?: { id: string; name: string };
  floorHolder?: string | null;
  action?: string;
  reason?: string;
  forced?: boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class BrowserOperator {
  readonly messages: ServerMessage[] = [];
  readonly participants = new Map<string, string>();
  floorHolder: string | null = null;
  lastFloor: ServerMessage | null = null;
  clientId = "";

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      this.messages.push(message);
      if (message.type === "hello") this.clientId = message.clientId ?? "";
      if (message.type === "channel-state") {
        this.participants.clear();
        for (const user of message.users ?? []) this.participants.set(user.id, user.name);
        this.floorHolder = message.floorHolder ?? null;
      }
      if (message.type === "user-joined" && message.user) {
        this.participants.set(message.user.id, message.user.name);
      }
      if (message.type === "user-left" && message.clientId) {
        this.participants.delete(message.clientId);
      }
      if (message.type === "floor") {
        this.floorHolder = message.action === "released" ? null : message.clientId ?? null;
        this.lastFloor = message;
      }
    });
  }

  send(payload: unknown) {
    this.socket.send(JSON.stringify(payload));
  }

  forcedReleases() {
    return this.messages.filter((message) => message.type === "floor" && message.forced === true);
  }

  async waitFor(predicate: () => boolean, description: string, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await sleep(10);
    }
    assert.fail(`Timed out waiting for ${description}`);
  }

  async joinDispatch() {
    await this.waitFor(() => Boolean(this.clientId), "PTT hello");
    this.send({ type: "join", channelId: "dispatch" });
    await this.waitFor(() => this.participants.has(this.clientId), "operator to join Dispatch");
  }

  close() {
    this.socket.close();
  }
}

let httpServer: Server;
let pttServer: WebSocketServer;
let port: number;

before(async () => {
  httpServer = createServer();
  pttServer = setupPttServer(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  assert(address && typeof address === "object");
  port = address.port;
});

after(async () => {
  for (const client of pttServer.clients) client.terminate();
  await new Promise<void>((resolve) => pttServer.close(() => resolve()));
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => error ? reject(error) : resolve());
  });
});

async function connectOperator(userId: string, name: string) {
  const token = createPttSessionToken({ id: userId, name });
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/ptt?token=${token}`);
  const operator = new BrowserOperator(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await operator.joinDispatch();
  return operator;
}

test("an operator who never releases loses the floor at the transmit limit", async () => {
  const alpha = await connectOperator("operator-limit-alpha", "Limit Alpha");
  const bravo = await connectOperator("operator-limit-bravo", "Limit Bravo");
  await alpha.waitFor(() => alpha.participants.size === 2, "both limit operators");

  alpha.send({ type: "floor-request", channelId: "dispatch" });
  await bravo.waitFor(() => bravo.floorHolder === alpha.clientId, "Alpha to take the floor");

  // Alpha never sends floor-release — the server has to take it back.
  await bravo.waitFor(() => bravo.floorHolder === null, "the channel to clear on its own", CUT_TIMEOUT_MS);

  const forced = alpha.forcedReleases();
  assert.equal(forced.length, 1, "the holder is told why it was cut");
  assert.equal(forced[0].action, "released");
  assert.equal(forced[0].clientId, alpha.clientId);
  assert.match(forced[0].reason ?? "", /transmit time/i);
  assert.equal(bravo.forcedReleases().length, 1, "listeners see the same release");

  alpha.close();
  bravo.close();
});

test("re-requesting the floor does not extend the transmit limit", async () => {
  const alpha = await connectOperator("operator-renew-alpha", "Renew Alpha");
  const bravo = await connectOperator("operator-renew-bravo", "Renew Bravo");
  await alpha.waitFor(() => alpha.participants.size === 2, "both renew operators");

  alpha.send({ type: "floor-request", channelId: "dispatch" });
  await alpha.waitFor(() => alpha.floorHolder === alpha.clientId, "Alpha to take the floor");
  const grantedAt = Date.now();

  // A client re-pressing on an interval must not be able to hold the channel
  // open past the limit, or the cap is cosmetic.
  const renew = setInterval(() => alpha.send({ type: "floor-request", channelId: "dispatch" }), 100);
  try {
    await bravo.waitFor(
      () => bravo.floorHolder === null,
      "the limit to fire despite re-requests",
      CUT_TIMEOUT_MS,
    );
  } finally {
    clearInterval(renew);
  }

  // Renewals ran for the whole window; had they reset the deadline the waitFor
  // above would have timed out instead. This bounds how far it drifted.
  const elapsed = Date.now() - grantedAt;
  assert.ok(
    elapsed < TRANSMIT_LIMIT_MS * 4,
    `expected the cut near the original grant, took ${elapsed}ms`,
  );
  assert.equal(alpha.forcedReleases().length, 1);

  alpha.close();
  bravo.close();
});

test("the floor is immediately grantable after a forced release", async () => {
  const alpha = await connectOperator("operator-regrant-alpha", "Regrant Alpha");
  const bravo = await connectOperator("operator-regrant-bravo", "Regrant Bravo");
  await alpha.waitFor(() => alpha.participants.size === 2, "both regrant operators");

  alpha.send({ type: "floor-request", channelId: "dispatch" });
  await bravo.waitFor(() => bravo.floorHolder === alpha.clientId, "Alpha to take the floor");
  await bravo.waitFor(() => bravo.floorHolder === null, "Alpha to be cut off", CUT_TIMEOUT_MS);

  bravo.send({ type: "floor-request", channelId: "dispatch" });
  await bravo.waitFor(() => bravo.floorHolder === bravo.clientId, "Bravo to take the floor");

  // No stale deadline from Alpha may cut Bravo short.
  await sleep(300);
  assert.equal(bravo.floorHolder, bravo.clientId);
  assert.equal(bravo.forcedReleases().length, 1, "only Alpha's cut, not a second one");

  bravo.send({ type: "floor-release", channelId: "dispatch" });
  await bravo.waitFor(() => bravo.floorHolder === null, "Bravo to release the floor");

  alpha.close();
  bravo.close();
});

test("a release inside the limit never reports a forced cut", async () => {
  const alpha = await connectOperator("operator-clean-alpha", "Clean Alpha");
  const bravo = await connectOperator("operator-clean-bravo", "Clean Bravo");
  await alpha.waitFor(() => alpha.participants.size === 2, "both clean operators");

  alpha.send({ type: "floor-request", channelId: "dispatch" });
  await bravo.waitFor(() => bravo.floorHolder === alpha.clientId, "Alpha to take the floor");
  await sleep(100);
  alpha.send({ type: "floor-release", channelId: "dispatch" });
  await bravo.waitFor(() => bravo.floorHolder === null, "Alpha to release the floor");

  await sleep(TRANSMIT_LIMIT_MS + 250);
  assert.deepEqual(alpha.forcedReleases(), [], "a normal transmission is never cut");
  assert.deepEqual(bravo.forcedReleases(), []);

  alpha.close();
  bravo.close();
});

test("disconnecting mid-transmission clears the deadline with the floor", async () => {
  const alpha = await connectOperator("operator-drop-alpha", "Drop Alpha");
  const bravo = await connectOperator("operator-drop-bravo", "Drop Bravo");
  await alpha.waitFor(() => alpha.participants.size === 2, "both drop operators");

  alpha.send({ type: "floor-request", channelId: "dispatch" });
  await bravo.waitFor(() => bravo.floorHolder === alpha.clientId, "Alpha to take the floor");
  alpha.close();
  await bravo.waitFor(() => bravo.floorHolder === null, "the floor to clear on disconnect");

  // The deadline must have been deleted, not left to fire against a dead client.
  await sleep(TRANSMIT_LIMIT_MS + 250);
  assert.deepEqual(bravo.forcedReleases(), []);

  bravo.close();
});
