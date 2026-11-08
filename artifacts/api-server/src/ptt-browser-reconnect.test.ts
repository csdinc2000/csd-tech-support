import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { WebSocket, type WebSocketServer } from "ws";
import { createPttSessionToken, setupPttServer } from "./ptt.ts";

type ServerMessage = {
  type: string;
  clientId?: string;
  users?: Array<{ id: string; name: string; role?: string }>;
  user?: { id: string; name: string; role?: string };
  floorHolder?: string | null;
  action?: string;
  from?: string;
  payload?: unknown;
};

class BrowserOperator {
  readonly messages: ServerMessage[] = [];
  readonly participants = new Map<string, string>();
  readonly participantRoles = new Map<string, string>();
  floorHolder: string | null = null;
  clientId = "";

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      this.messages.push(message);
      if (message.type === "hello") this.clientId = message.clientId ?? "";
      if (message.type === "channel-state") {
        this.participants.clear();
        this.participantRoles.clear();
        for (const user of message.users ?? []) {
          this.participants.set(user.id, user.name);
          this.participantRoles.set(user.id, user.role ?? "");
        }
        this.floorHolder = message.floorHolder ?? null;
      }
      if (message.type === "user-joined" && message.user) {
        this.participants.set(message.user.id, message.user.name);
        this.participantRoles.set(message.user.id, message.user.role ?? "");
      }
      if (message.type === "user-left" && message.clientId) {
        this.participants.delete(message.clientId);
        this.participantRoles.delete(message.clientId);
      }
      if (message.type === "floor") {
        this.floorHolder = message.action === "released" ? null : message.clientId ?? null;
      }
    });
  }

  send(payload: unknown) {
    this.socket.send(JSON.stringify(payload));
  }

  async waitFor(predicate: () => boolean, description: string, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Timed out waiting for ${description}`);
  }

  async joinDispatch() {
    await this.joinChannel("dispatch", "Dispatch");
  }

  async joinChannel(channelId: string, channelName: string) {
    await this.waitFor(() => Boolean(this.clientId), "PTT hello");
    this.send({ type: "join", channelId });
    await this.waitFor(
      () => this.participants.has(this.clientId),
      `operator to join ${channelName}`,
    );
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

async function connectOperator(userId: string, name: string, role = "field_technician") {
  const token = createPttSessionToken({ id: userId, name, role });
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/ptt?token=${token}`);
  const operator = new BrowserOperator(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await operator.joinDispatch();
  return operator;
}

test("two browser operators recover floor and peer signaling after one reconnects", async () => {
  const alpha = await connectOperator("operator-alpha", "Operator Alpha", "field_technician");
  const bravo = await connectOperator("operator-bravo", "Operator Bravo", "administrator");

  await alpha.waitFor(() => alpha.participants.size === 2, "both operators in Alpha's roster");
  assert.deepEqual(
    [...alpha.participants.values()].sort(),
    ["Operator Alpha", "Operator Bravo"],
  );
  assert.deepEqual(
    [...bravo.participants.values()].sort(),
    ["Operator Alpha", "Operator Bravo"],
  );
  assert.equal(alpha.participantRoles.get(bravo.clientId), "administrator");
  assert.equal(bravo.participantRoles.get(alpha.clientId), "field_technician");

  alpha.send({ type: "floor-request", channelId: "dispatch" });
  await bravo.waitFor(() => bravo.floorHolder === alpha.clientId, "Alpha to acquire the floor");

  const staleAlphaId = alpha.clientId;
  const replacementAlpha = await connectOperator("operator-alpha", "Operator Alpha", "field_technician");
  assert.notEqual(replacementAlpha.clientId, staleAlphaId);
  await bravo.waitFor(
    () =>
      bravo.floorHolder === null &&
      bravo.participants.size === 2 &&
      bravo.participants.has(replacementAlpha.clientId) &&
      !bravo.participants.has(staleAlphaId),
    "one replacement Alpha participant and a clear floor",
  );
  assert.equal(
    [...bravo.participants.values()].filter((name) => name === "Operator Alpha").length,
    1,
  );
  assert.equal(bravo.participantRoles.get(replacementAlpha.clientId), "field_technician");

  replacementAlpha.send({
    type: "signal",
    to: bravo.clientId,
    channelId: "dispatch",
    payload: { description: { type: "offer", sdp: "fresh-peer-offer" } },
  });
  await bravo.waitFor(
    () => bravo.messages.some(
      (message) =>
        message.type === "signal" &&
        message.from === replacementAlpha.clientId,
    ),
    "fresh peer offer after reconnect",
  );
  bravo.send({
    type: "signal",
    to: replacementAlpha.clientId,
    channelId: "dispatch",
    payload: { description: { type: "answer", sdp: "fresh-peer-answer" } },
  });
  await replacementAlpha.waitFor(
    () => replacementAlpha.messages.some(
      (message) => message.type === "signal" && message.from === bravo.clientId,
    ),
    "fresh peer answer after reconnect",
  );

  bravo.send({ type: "floor-request", channelId: "dispatch" });
  await replacementAlpha.waitFor(
    () => replacementAlpha.floorHolder === bravo.clientId,
    "Bravo to acquire the floor after reconnect",
  );
  bravo.send({ type: "floor-release", channelId: "dispatch" });
  await replacementAlpha.waitFor(
    () => replacementAlpha.floorHolder === null,
    "Bravo to release the floor after reconnect",
  );

  alpha.close();
  replacementAlpha.close();
  bravo.close();
});

test("stale channel commands cannot seize a new channel floor or forward old signaling", async () => {
  const alpha = await connectOperator("operator-channel-alpha", "Channel Alpha");
  const bravo = await connectOperator("operator-channel-bravo", "Channel Bravo");
  await alpha.waitFor(() => alpha.participants.size === 2, "both channel-test operators");

  alpha.send({ type: "join", channelId: "field" });
  await alpha.waitFor(
    () => alpha.participants.size === 1 && alpha.participants.has(alpha.clientId),
    "Alpha to join Field",
  );

  const bravoSignalCount = bravo.messages.filter((message) => message.type === "signal").length;
  alpha.send({ type: "floor-request", channelId: "dispatch" });
  alpha.send({
    type: "signal",
    to: bravo.clientId,
    channelId: "dispatch",
    payload: { description: { type: "offer", sdp: "stale-dispatch-offer" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(alpha.floorHolder, null);
  assert.equal(
    bravo.messages.filter((message) => message.type === "signal").length,
    bravoSignalCount,
  );

  alpha.send({ type: "floor-request", channelId: "field" });
  await alpha.waitFor(() => alpha.floorHolder === alpha.clientId, "Alpha to acquire the Field floor");
  alpha.send({ type: "floor-release", channelId: "field" });

  alpha.close();
  bravo.close();
});

test("reconnecting while switching channels leaves rosters, floors, and signaling in the current channel", async () => {
  const dispatchPeer = await connectOperator("operator-dispatch", "Dispatch Peer");
  const switchingOperator = await connectOperator("operator-switching", "Switching Operator");
  const fieldPeer = await connectOperator("operator-field", "Field Peer");
  await fieldPeer.joinChannel("field", "Field Technicians");

  await dispatchPeer.waitFor(
    () => dispatchPeer.participants.size === 2,
    "Dispatch roster before reconnect",
  );
  switchingOperator.send({ type: "floor-request", channelId: "dispatch" });
  await dispatchPeer.waitFor(
    () => dispatchPeer.floorHolder === switchingOperator.clientId,
    "switching operator to acquire the Dispatch floor",
  );

  const staleSwitchingId = switchingOperator.clientId;
  const replacement = await connectOperator("operator-switching", "Switching Operator");
  await replacement.joinChannel("field", "Field Technicians");

  await dispatchPeer.waitFor(
    () =>
      dispatchPeer.floorHolder === null &&
      dispatchPeer.participants.size === 1 &&
      dispatchPeer.participants.has(dispatchPeer.clientId) &&
      !dispatchPeer.participants.has(staleSwitchingId) &&
      !dispatchPeer.participants.has(replacement.clientId),
    "only the Dispatch peer and a clear Dispatch floor",
  );
  await fieldPeer.waitFor(
    () =>
      fieldPeer.floorHolder === null &&
      fieldPeer.participants.size === 2 &&
      fieldPeer.participants.has(fieldPeer.clientId) &&
      fieldPeer.participants.has(replacement.clientId),
    "the expected Field Technicians roster and a clear floor",
  );
  assert.deepEqual([...dispatchPeer.participants.values()], ["Dispatch Peer"]);
  assert.deepEqual(
    [...fieldPeer.participants.values()].sort(),
    ["Field Peer", "Switching Operator"],
  );

  const crossChannelSignalCount = dispatchPeer.messages.filter(
    (message) => message.type === "signal" && message.from === replacement.clientId,
  ).length;
  replacement.send({
    type: "signal",
    to: dispatchPeer.clientId,
    channelId: "field",
    payload: { description: { type: "offer", sdp: "must-not-cross-channels" } },
  });
  replacement.send({
    type: "signal",
    to: fieldPeer.clientId,
    channelId: "field",
    payload: { description: { type: "offer", sdp: "current-channel-offer" } },
  });
  await fieldPeer.waitFor(
    () => fieldPeer.messages.some(
      (message) =>
        message.type === "signal" &&
        message.from === replacement.clientId &&
        (message.payload as { description?: { sdp?: string } })?.description?.sdp ===
          "current-channel-offer",
    ),
    "signaling to the current-channel peer",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    dispatchPeer.messages.filter(
      (message) => message.type === "signal" && message.from === replacement.clientId,
    ).length,
    crossChannelSignalCount,
  );

  dispatchPeer.close();
  switchingOperator.close();
  replacement.close();
  fieldPeer.close();
});
