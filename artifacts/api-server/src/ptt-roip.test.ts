import assert from "node:assert/strict";
import { test } from "node:test";
import { canUseDispatchRadio, normalizeTwilioIceServers, shouldForwardBrowserAudioToRoip } from "./ptt.ts";
import {
  FrameCadenceGate,
  getRoipConfig,
  isNonSilentPcmuFrame,
  validPcmuFrame,
} from "./roip.ts";

test("RoIP configuration requires the server-side SIP credential", () => {
  const complete = {
    ROIP_ENABLED: "true",
    ROIP_SINGLE_INSTANCE: "true",
    ROIP_SIP_DOMAIN: "csd-roip-gateway.sip.twilio.com",
    ROIP_SIP_USERNAME: "csd-radio-gateway",
    ROIP_SIP_PASSWORD: "server-only-password",
    TWILIO_AUTH_TOKEN: "server-only-token",
    APP_BASE_URL: "https://support.computersystemsdepot.com/",
  } as NodeJS.ProcessEnv;

  const config = getRoipConfig(complete);
  assert.equal(config.configured, true);
  assert.equal(config.vendor, "Twilio");
  assert.equal(config.physicalChannel, "dispatch");
  assert.equal(config.talkGroup, "Dispatch");
  assert.equal(getRoipConfig({ ...complete, ROIP_SIP_PASSWORD: "" }).configured, false);
});

test("PCMU frames are one 20 ms mono packet and VAD ignores digital silence", () => {
  const silence = Buffer.alloc(160, 0xff).toString("base64");
  const voice = Buffer.alloc(160, 0x00).toString("base64");

  assert.equal(validPcmuFrame(silence), true);
  assert.equal(validPcmuFrame(silence.slice(0, -4)), false);
  assert.equal(isNonSilentPcmuFrame(silence), false);
  assert.equal(isNonSilentPcmuFrame(voice), true);
});

test("RoIP frame cadence rejects bursts that could overrun the gateway", () => {
  const cadence = new FrameCadenceGate();
  assert.equal(cadence.accept(1_000), true);
  assert.equal(cadence.accept(1_009), false);
  assert.equal(cadence.accept(1_010), true);
});

test("radio access stays administrator-scoped to the Dispatch talk group", () => {
  assert.equal(canUseDispatchRadio(false, "dispatch"), false);
  assert.equal(canUseDispatchRadio(true, "field"), false);
  assert.equal(canUseDispatchRadio(true, "dispatch"), true);
});

test("offline radio bridge never becomes a prerequisite for browser PTT", () => {
  assert.equal(shouldForwardBrowserAudioToRoip({
    canDispatchRadio: true,
    channelId: "dispatch",
    holdsFloor: true,
    transportReady: false,
  }), false);
  assert.equal(shouldForwardBrowserAudioToRoip({
    canDispatchRadio: false,
    channelId: "dispatch",
    holdsFloor: true,
    transportReady: true,
  }), false);
});

test("radio forwarding resumes only when an authorized floor holder has a ready bridge", () => {
  assert.equal(shouldForwardBrowserAudioToRoip({
    canDispatchRadio: true,
    channelId: "dispatch",
    holdsFloor: true,
    transportReady: true,
  }), true);
  assert.equal(shouldForwardBrowserAudioToRoip({
    canDispatchRadio: true,
    channelId: "dispatch",
    holdsFloor: false,
    transportReady: true,
  }), false);
});

test("Twilio Network Traversal credentials become browser-safe ICE servers", () => {
  assert.deepEqual(
    normalizeTwilioIceServers([
      { url: "stun:global.stun.twilio.com:3478" },
      {
        url: "turn:global.turn.twilio.com:3478?transport=udp",
        username: "temporary-user",
        credential: "temporary-password",
      },
    ]),
    [
      { urls: "stun:global.stun.twilio.com:3478" },
      {
        urls: "turn:global.turn.twilio.com:3478?transport=udp",
        username: "temporary-user",
        credential: "temporary-password",
        credentialType: "password",
      },
    ],
  );
});