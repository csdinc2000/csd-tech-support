import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMulaw, encodeMulaw, mulawToPcm16, pcm16ToMulaw, resamplePcm } from "../../shared/roip-audio";
import { getRoipConfig, isNonSilentPcmuFrame, SingleUseTokenStore, validPcmuFrame } from "../roip";
import { canUseDispatchRadio } from "../ptt";
import {
  canonicalPublicAppBaseUrl,
  reconcileCredentialListMappings,
  reconcileCredentialUsernames,
} from "../../shared/roip-config";

test("µ-law encode/decode preserves representative PCM samples within companding tolerance", () => {
  const input = new Int16Array([-30000, -1000, 0, 1000, 30000]);
  const decoded = decodeMulaw(encodeMulaw(input));
  assert.equal(decoded.length, input.length);
  assert.ok(Math.abs(decoded[2]) <= 8);
  for (const index of [0, 1, 3, 4]) {
    assert.equal(Math.sign(decoded[index]), Math.sign(input[index]));
    assert.ok(Math.abs(decoded[index] - input[index]) < Math.max(100, Math.abs(input[index]) * 0.06));
  }
  assert.equal(mulawToPcm16(pcm16ToMulaw(0)), 0);
});

test("resampler produces 8 kHz length and bounded PCM", () => {
  const input = Float32Array.from({ length: 480 }, (_, index) => Math.sin(index / 10));
  const output = resamplePcm(input, 48_000, 8_000);
  assert.equal(output.length, 80);
  assert.ok(Array.from(output).every((sample) => sample >= -32768 && sample <= 32767));
});

test("stream tokens are single-use and expire", () => {
  const tokens = new SingleUseTokenStore(100);
  const first = tokens.issue(1000);
  assert.equal(tokens.take(first, 1050), true);
  assert.equal(tokens.take(first, 1051), false);
  const expired = tokens.issue(2000);
  assert.equal(tokens.take(expired, 2101), false);
});

test("RoIP config requires explicit enablement and non-secret runtime settings", () => {
  const complete = {
    ROIP_ENABLED: "true",
    ROIP_SIP_DOMAIN: "radio.sip.twilio.com",
    ROIP_SIP_USERNAME: "gateway",
    APP_BASE_URL: "https://support.computersystemsdepot.com/",
    TWILIO_AUTH_TOKEN: "present",
    ROIP_SINGLE_INSTANCE: "true",
  } as NodeJS.ProcessEnv;
  assert.deepEqual(getRoipConfig(complete), {
    enabled: true,
    sipDomain: "radio.sip.twilio.com",
    sipUsername: "gateway",
    appBaseUrl: "https://support.computersystemsdepot.com",
    singleInstanceRequired: false,
    configured: true,
  });
  assert.equal(getRoipConfig({ ...complete, ROIP_ENABLED: "false" }).configured, false);
  assert.equal(getRoipConfig({ ...complete, TWILIO_AUTH_TOKEN: "" }).configured, false);
  assert.equal(getRoipConfig({ ...complete, ROIP_SINGLE_INSTANCE: "false" }).singleInstanceRequired, true);
});

test("dispatch radio entitlement fails closed", () => {
  assert.equal(canUseDispatchRadio(false, "dispatch"), false);
  assert.equal(canUseDispatchRadio(true, "field"), false);
  assert.equal(canUseDispatchRadio(true, "dispatch"), true);
});

test("PCMU frames require exactly one 20ms payload and VAD ignores silence", () => {
  const silence = Buffer.alloc(160, 0xff).toString("base64");
  const tone = Buffer.alloc(160, pcm16ToMulaw(8_000)).toString("base64");
  assert.equal(validPcmuFrame(silence), true);
  assert.equal(validPcmuFrame(silence.slice(0, -4)), false);
  assert.equal(isNonSilentPcmuFrame(silence), false);
  assert.equal(isNonSilentPcmuFrame(tone), true);
});

test("public application URL is a canonical HTTPS origin only", () => {
  assert.deepEqual(canonicalPublicAppBaseUrl("https://support.example.com/"), {
    ok: true, origin: "https://support.example.com",
  });
  for (const bad of ["http://support.example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?", "https://example.com?q=1", "https://example.com/#x", "not a url"]) {
    assert.equal(canonicalPublicAppBaseUrl(bad).ok, false, bad);
  }
});

test("credential reconciliation fails closed for old identities or mappings", () => {
  assert.equal(reconcileCredentialListMappings([], "CL1").action, "create");
  assert.equal(reconcileCredentialListMappings(["CL1"], "CL1").action, "keep");
  assert.equal(reconcileCredentialListMappings(["CL1", "CL2"], "CL1").action, "fail");
  assert.equal(reconcileCredentialUsernames(["gateway"], "gateway").action, "update");
  assert.equal(reconcileCredentialUsernames(["gateway", "former-gateway"], "gateway").action, "fail");
});