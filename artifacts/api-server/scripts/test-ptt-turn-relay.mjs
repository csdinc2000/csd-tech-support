import { createHmac, randomUUID } from "node:crypto";
import { chromium } from "playwright";

const urls = (process.env.PTT_TURN_URLS ?? process.env.TURN_URLS ?? process.env.PTT_TURN_URL ?? process.env.TURN_URL ?? "")
  .split(/[,\s]+/)
  .map((url) => url.trim())
  .filter(Boolean);
const secret = (process.env.PTT_TURN_SHARED_SECRET ?? process.env.TURN_SHARED_SECRET ?? "").trim();

if (urls.length === 0 || !secret) {
  console.error(JSON.stringify({
    ok: false,
    reason: "TURN relay test requires PTT_TURN_URLS and PTT_TURN_SHARED_SECRET (or TURN_URLS and TURN_SHARED_SECRET).",
  }, null, 2));
  process.exit(2);
}

const expiresAt = Math.floor(Date.now() / 1000) + 600;
const username = `${expiresAt}:${randomUUID()}`;
const credential = createHmac("sha1", secret).update(username).digest("base64");
const iceServers = [{ urls, username, credential, credentialType: "password" }];
const browser = await chromium.launch({ headless: true });

async function createOperator(label) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("about:blank");
  await page.evaluate(({ label, iceServers }) => {
    const diagnostics = {
      label,
      candidateErrors: [],
      localCandidateTypes: [],
      states: [],
    };
    const pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: "relay",
      bundlePolicy: "max-bundle",
    });
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const destination = audio.createMediaStreamDestination();
    oscillator.frequency.value = label === "operator-a" ? 440 : 660;
    gain.gain.value = 0.15;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    for (const track of destination.stream.getAudioTracks()) pc.addTrack(track, destination.stream);
    pc.onicecandidate = (event) => {
      if (event.candidate?.type) diagnostics.localCandidateTypes.push(event.candidate.type);
    };
    pc.onicecandidateerror = (event) => {
      diagnostics.candidateErrors.push({
        url: event.url,
        address: event.address,
        port: event.port,
        errorCode: event.errorCode,
        errorText: event.errorText,
      });
    };
    const recordState = () => diagnostics.states.push({
      at: new Date().toISOString(),
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      iceGatheringState: pc.iceGatheringState,
      signalingState: pc.signalingState,
    });
    pc.onconnectionstatechange = recordState;
    pc.oniceconnectionstatechange = recordState;
    window.relayProbe = { pc, audio, oscillator, diagnostics };
  }, { label, iceServers });
  return { context, page, label };
}

async function waitForIceGathering(page) {
  await page.evaluate(async () => {
    const { pc } = window.relayProbe;
    if (pc.iceGatheringState === "complete") return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("ICE gathering timed out")), 20_000);
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  });
}

async function selectedPath(page) {
  return page.evaluate(async () => {
    const { pc } = window.relayProbe;
    const stats = await pc.getStats();
    let selected;
    stats.forEach((report) => {
      if (report.type === "candidate-pair" && report.state === "succeeded" && (report.selected || report.nominated)) {
        selected = report;
      }
    });
    const local = selected ? stats.get(selected.localCandidateId) : undefined;
    const remote = selected ? stats.get(selected.remoteCandidateId) : undefined;
    let inboundBytes = 0;
    let inboundPackets = 0;
    stats.forEach((report) => {
      if (report.type === "inbound-rtp" && report.kind === "audio") {
        inboundBytes += report.bytesReceived ?? 0;
        inboundPackets += report.packetsReceived ?? 0;
      }
    });
    return {
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      localCandidateType: local?.candidateType ?? "unknown",
      remoteCandidateType: remote?.candidateType ?? "unknown",
      inboundBytes,
      inboundPackets,
    };
  });
}

const operators = [];
try {
  const operatorA = await createOperator("operator-a");
  const operatorB = await createOperator("operator-b");
  operators.push(operatorA, operatorB);

  const offer = await operatorA.page.evaluate(async () => {
    const { pc } = window.relayProbe;
    await pc.setLocalDescription(await pc.createOffer());
    return pc.localDescription.toJSON();
  });
  await waitForIceGathering(operatorA.page);
  const gatheredOffer = await operatorA.page.evaluate(() => window.relayProbe.pc.localDescription.toJSON());

  await operatorB.page.evaluate(async (remoteOffer) => {
    const { pc } = window.relayProbe;
    await pc.setRemoteDescription(remoteOffer);
    await pc.setLocalDescription(await pc.createAnswer());
  }, gatheredOffer ?? offer);
  await waitForIceGathering(operatorB.page);
  const answer = await operatorB.page.evaluate(() => window.relayProbe.pc.localDescription.toJSON());
  await operatorA.page.evaluate((remoteAnswer) => window.relayProbe.pc.setRemoteDescription(remoteAnswer), answer);

  await Promise.all(operators.map(({ page }) => page.waitForFunction(
    () => window.relayProbe.pc.connectionState === "connected",
    undefined,
    { timeout: 30_000 },
  )));
  await Promise.all(operators.map(({ page }) => page.waitForFunction(async () => {
    const stats = await window.relayProbe.pc.getStats();
    let bytes = 0;
    stats.forEach((report) => {
      if (report.type === "inbound-rtp" && report.kind === "audio") bytes += report.bytesReceived ?? 0;
    });
    return bytes > 0;
  }, undefined, { timeout: 15_000 })));

  const paths = await Promise.all(operators.map(({ page }) => selectedPath(page)));
  const failures = paths.filter((path) =>
    path.connectionState !== "connected" ||
    path.localCandidateType !== "relay" ||
    path.remoteCandidateType !== "relay" ||
    path.inboundBytes <= 0
  );
  const report = { ok: failures.length === 0, forcedPolicy: "relay", paths };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) process.exitCode = 1;
} catch (error) {
  const diagnostics = await Promise.all(operators.map(async ({ page, label }) => ({
    label,
    path: await selectedPath(page).catch(() => null),
    events: await page.evaluate(() => window.relayProbe?.diagnostics).catch(() => null),
  })));
  console.error(JSON.stringify({
    ok: false,
    reason: error instanceof Error ? error.message : String(error),
    diagnostics,
  }, null, 2));
  process.exitCode = 1;
} finally {
  await Promise.all(operators.map(({ context }) => context.close()));
  await browser.close();
}