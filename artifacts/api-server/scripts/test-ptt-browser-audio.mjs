import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright";
import { createPttSessionToken, setupPttServer } from "../src/ptt.ts";

const frontendDir = path.resolve(process.cwd(), "../csd-rmm-crm");
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/repl/tools/bin/chromium";
const browserUrl = "http://127.0.0.1";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      assert(address && typeof address === "object");
      resolve(address.port);
    });
  });
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "unknown error"}`);
}

async function waitFor(description, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

function sessionFor(userId, name) {
  const token = createPttSessionToken({ id: userId, name });
  return {
    token,
    expiresInSeconds: 300,
    channels: [
      {
        id: "dispatch",
        name: "Dispatch",
        description: "Primary service desk and field coordination",
      },
    ],
    iceServers: [],
    network: {
      relayConfigured: false,
      turnCredentialExpiresAt: null,
    },
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
      model: "Offline",
      codec: "PCMU",
      sampleRate: 8000,
      physicalChannel: "dispatch",
      channelMapping: {
        physicalChannel: "dispatch",
        channelId: "dispatch",
        talkGroup: "Dispatch",
      },
      channelId: "dispatch",
      singleInstanceRequired: true,
      websocketPath: "/ws/roip",
      protocol: "CSD-RoIP/1",
    },
  };
}

async function getAudioStats(page) {
  return page.evaluate(async () => {
    const peers = window.__pttPeerConnections ?? [];
    const outbound = [];
    const inbound = [];
    for (const peer of peers) {
      const reports = await peer.getStats();
      reports.forEach((report) => {
        const isAudio = report.kind === "audio" || report.mediaType === "audio";
        if (!isAudio || report.ssrc === undefined) return;
        if (report.type === "outbound-rtp") {
          outbound.push({
            ssrc: String(report.ssrc),
            packets: report.packetsSent ?? 0,
            bytes: report.bytesSent ?? 0,
          });
        }
        if (report.type === "inbound-rtp") {
          inbound.push({
            ssrc: String(report.ssrc),
            packets: report.packetsReceived ?? 0,
            bytes: report.bytesReceived ?? 0,
          });
        }
      });
    }
    return { outbound, inbound };
  });
}

function packetCount(reports) {
  return reports.reduce((total, report) => total + report.packets, 0);
}

function byteCount(reports) {
  return reports.reduce((total, report) => total + report.bytes, 0);
}

function hasMatchingSsrc(outbound, inbound) {
  const inboundSsrcs = new Set(inbound.map((report) => report.ssrc));
  return outbound.some((report) => inboundSsrcs.has(report.ssrc));
}

async function assertTransmission(sender, receiver, description) {
  const senderBefore = await getAudioStats(sender);
  const receiverBefore = await getAudioStats(receiver);

  await waitFor(`${description} RTP`, async () => {
    const senderAfter = await getAudioStats(sender);
    const receiverAfter = await getAudioStats(receiver);
    return (
      packetCount(senderAfter.outbound) > packetCount(senderBefore.outbound) &&
      byteCount(senderAfter.outbound) > byteCount(senderBefore.outbound) &&
      packetCount(receiverAfter.inbound) > packetCount(receiverBefore.inbound) &&
      byteCount(receiverAfter.inbound) > byteCount(receiverBefore.inbound) &&
      hasMatchingSsrc(senderAfter.outbound, receiverAfter.inbound)
    );
  });
}

async function assertStableConnected(...pages) {
  await Promise.all(
    pages.map((page) =>
      waitFor("stable connected browser peers", async () =>
        page.evaluate(() => {
          const peers = (window.__pttPeerConnections ?? []).filter(
            (peer) => peer.connectionState !== "closed",
          );
          return (
            peers.length > 0 &&
            peers.every(
              (peer) =>
                peer.connectionState === "connected" &&
                (peer.iceConnectionState === "connected" ||
                  peer.iceConnectionState === "completed") &&
                peer.signalingState === "stable",
            )
          );
        }),
      ),
    ),
  );
}

async function press(page) {
  const button = page.getByTestId("ptt-transmit-button");
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  assert(box, "PTT transmit button should have a bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

async function release(page) {
  await page.mouse.up();
}

async function generatedTrackEnabled(page) {
  return page.evaluate(() => window.__pttGeneratedAudio?.track.enabled ?? false);
}

async function waitForTwoOperators(page) {
  await waitFor("both operators in Dispatch", async () =>
    page.getByText("2 Online", { exact: true }).isVisible(),
  );
}

async function waitForOneOperator(page) {
  await waitFor("one remaining operator in Dispatch", async () =>
    page.getByText("1 Online", { exact: true }).isVisible(),
  );
}

async function createOperator(browser, vitePort, wsPort, userId, name, frequency) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ["microphone"],
  });
  const session = sessionFor(userId, name);

  await context.addInitScript(
    ({ wsPort: targetPort, frequency: oscillatorFrequency }) => {
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class RoutedWebSocket extends NativeWebSocket {
        constructor(url, protocols) {
          const parsed = new URL(String(url), window.location.href);
          if (parsed.pathname === "/ws/ptt") {
            const routed = `ws://127.0.0.1:${targetPort}${parsed.pathname}${parsed.search}`;
            if (protocols === undefined) {
              super(routed);
            } else {
              super(routed, protocols);
            }
            return;
          }
          if (protocols === undefined) {
            super(url);
          } else {
            super(url, protocols);
          }
        }
      };

      const NativePeerConnection = window.RTCPeerConnection;
      window.__pttPeerConnections = [];
      window.RTCPeerConnection = class InstrumentedPeerConnection extends NativePeerConnection {
        constructor(...args) {
          super(...args);
          window.__pttPeerConnections.push(this);
        }
      };

      const mediaDevices = navigator.mediaDevices;
      const nativeGetUserMedia = mediaDevices?.getUserMedia?.bind(mediaDevices);
      if (!mediaDevices || !nativeGetUserMedia) {
        throw new Error("Browser test requires navigator.mediaDevices.getUserMedia.");
      }
      mediaDevices.getUserMedia = async (constraints) => {
        if (!constraints?.audio) return nativeGetUserMedia(constraints);
        const audio = new AudioContext({ sampleRate: 48_000 });
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        const destination = audio.createMediaStreamDestination();
        oscillator.frequency.value = oscillatorFrequency;
        gain.gain.value = 0.15;
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        const track = destination.stream.getAudioTracks()[0];
        track.enabled = false;
        window.__pttGeneratedAudio = { audio, oscillator, stream: destination.stream, track };
        return destination.stream;
      };
    },
    { wsPort, frequency },
  );

  await context.route("**/api/ptt/session", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) }),
  );
  await context.route("**/api/ptt/telemetry**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        filters: { hours: 24, channelId: null, bucket: "hour" },
        summary: { connected: 0, relay: 0, failed: 0, relayRate: 0 },
        trend: [],
        failureReasons: [],
        incidentActive: false,
      }),
    }),
  );

  const page = await context.newPage();
  await page.goto(`${browserUrl}:${vitePort}/tests/ptt-dispatch.fixture.html`);
  await waitFor(`${name} signaling`, () =>
    page.getByTestId("ptt-signaling-status").getByText("Signaling Online", { exact: true }).isVisible(),
  );
  return { context, page, name };
}

async function closeOperator(operator) {
  await operator.context.close();
}

async function main() {
  const pttHttpServer = createServer();
  const pttServer = setupPttServer(pttHttpServer);
  const wsPort = await listen(pttHttpServer);
  const vitePort = 4175;
  const vite = spawn("pnpm", ["run", "dev"], {
    cwd: frontendDir,
    env: { ...process.env, BASE_PATH: "/", PORT: String(vitePort), NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const viteOutput = [];
  vite.stdout.on("data", (chunk) => viteOutput.push(chunk.toString()));
  vite.stderr.on("data", (chunk) => viteOutput.push(chunk.toString()));

  let browser;
  const operators = [];
  try {
    await waitForHttp(`${browserUrl}:${vitePort}/tests/ptt-dispatch.fixture.html`);
    browser = await chromium.launch({
      headless: true,
      executablePath: chromiumPath,
      args: ["--autoplay-policy=no-user-gesture-required"],
    });

  const alpha = await createOperator(browser, vitePort, wsPort, "browser-alpha", "Browser Alpha", 440);
  const bravo = await createOperator(browser, vitePort, wsPort, "browser-bravo", "Browser Bravo", 660);
  operators.push(alpha, bravo);
  await Promise.all([waitForTwoOperators(alpha.page), waitForTwoOperators(bravo.page)]);
  await assertStableConnected(alpha.page, bravo.page);

  // First press is simultaneous. The server's serialized floor messages define
  // the winner; no timing assumption is made about either browser.
  await Promise.all([press(alpha.page), press(bravo.page)]);
  await waitFor("one simultaneous floor winner", async () => {
    const enabled = await Promise.all([generatedTrackEnabled(alpha.page), generatedTrackEnabled(bravo.page)]);
    return enabled.filter(Boolean).length === 1;
  });
  const alphaWon = await generatedTrackEnabled(alpha.page);
  const winner = alphaWon ? alpha : bravo;
  const loser = alphaWon ? bravo : alpha;
  assert.equal(await generatedTrackEnabled(loser.page), false, "the simultaneous loser must be muted");
  await assertStableConnected(alpha.page, bravo.page);
  await assertTransmission(winner.page, loser.page, "simultaneous winner");
  await release(winner.page);
  await waitFor("simultaneous winner release", async () =>
    !(await generatedTrackEnabled(winner.page)) && !(await generatedTrackEnabled(loser.page)),
  );

  // The denied browser must be able to transmit in the reverse direction.
  await press(loser.page);
  await waitFor("reverse floor grant", () => generatedTrackEnabled(loser.page));
  await assertTransmission(loser.page, winner.page, "reverse transmission");
  await release(loser.page);
  await waitFor("reverse floor release", async () =>
    !(await generatedTrackEnabled(winner.page)) && !(await generatedTrackEnabled(loser.page)),
  );

  // Close and recreate one isolated browser context. This exercises the actual
  // component cleanup/rejoin path while the other operator remains connected.
  await closeOperator(alpha);
  await waitForOneOperator(bravo.page);
  const rejoinedAlpha = await createOperator(
    browser,
    vitePort,
    wsPort,
    "browser-alpha",
    "Browser Alpha",
    440,
  );
  operators.push(rejoinedAlpha);
  await Promise.all([waitForTwoOperators(bravo.page), waitForTwoOperators(rejoinedAlpha.page)]);
  await assertStableConnected(bravo.page, rejoinedAlpha.page);

  // Both directions must still carry RTP after the leave/rejoin.
  await press(rejoinedAlpha.page);
  await waitFor("rejoined Alpha floor grant", () => generatedTrackEnabled(rejoinedAlpha.page));
  await assertTransmission(rejoinedAlpha.page, bravo.page, "rejoined Alpha transmission");
  await release(rejoinedAlpha.page);
  await waitFor("rejoined Alpha release", async () => !(await generatedTrackEnabled(rejoinedAlpha.page)));

  await press(bravo.page);
  await waitFor("rejoined Bravo floor grant", () => generatedTrackEnabled(bravo.page));
  await assertTransmission(bravo.page, rejoinedAlpha.page, "rejoined Bravo transmission");
  await release(bravo.page);
  await waitFor("rejoined Bravo release", async () => !(await generatedTrackEnabled(bravo.page)));
  await assertStableConnected(bravo.page, rejoinedAlpha.page);

    console.log(JSON.stringify({
      ok: true,
      assertions: [
        "simultaneous floor arbitration",
        "muted losing microphone",
        "bidirectional RTP with matching SSRC",
        "leave and rejoin recovery",
        "reverse transmission after rejoin",
      ],
      radioBridge: "offline and not gating browser assertions",
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      browserLogs: viteOutput.slice(-30),
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await Promise.all(operators.map(closeOperator));
    await browser?.close();
    for (const client of pttServer.clients) client.terminate();
    await Promise.race([
      new Promise((resolve) => pttServer.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    await Promise.race([
      new Promise((resolve) => pttHttpServer.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    if (vite.pid) {
      try {
        process.kill(-vite.pid, "SIGTERM");
      } catch {
        // The Vite process may already have exited after its parent closed.
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});