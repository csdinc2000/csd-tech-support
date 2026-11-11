import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import twilio from "twilio";
import { registerTwilioForwarding } from "./twilio-forwarding";
import { renderStep } from "./twilio-tracking";
import { twilioWebhookSignatureBoundary } from "./twilio-webhook-security";
import { forwardedCallerId, withVoiceRoutingDeadline, configuredForwardTargets } from "./voice-routing";

// All providers, notifications and persistence are stubbed: no real calls,
// texts, customer records or settings are changed by these tests.
process.env.NODE_ENV = "production";
process.env.TWILIO_AUTH_TOKEN = "voice-routing-test-token";
process.env.APP_BASE_URL = "https://support.example.test";

type Dependencies = NonNullable<Parameters<typeof registerTwilioForwarding>[1]>;
const settings = {
  twilioPhoneNumber: "+19546377300", callForwardingEnabled: true,
  showCallerIdOnForward: true, dialTimeoutSeconds: 25,
  whisperEnabled: true, voicemailEnabled: true,
  businessHoursDays: "1", businessHoursStart: "00:00", businessHoursEnd: "00:01",
};

async function startServer(t: TestContext, overrides: Dependencies = {}) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use("/webhooks", twilioWebhookSignatureBoundary);
  registerTwilioForwarding(app, {
    getTwilioSettings: async () => settings as any,
    getTrackingNumberByPhone: async () => undefined,
    getCallFlow: async () => undefined,
    upsertCallLog: async () => ({}) as any,
    getActiveCallRecipientPhones: async () => ["+12025550199"],
    alertTeamOfCall: async () => undefined,
    notifyStaffEvent: async () => undefined,
    sendToVoicemail: async (response, _settings, base) => {
      response.say("Leave a message.");
      response.record({ action: `${base}/webhooks/voice/voicemail-recorded` });
    },
    ...overrides,
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return async (from: string, signed = true, callback: { path?: string; fields?: Record<string, string> } = {}) => {
    const path = callback.path || "/webhooks/voice/incoming";
    const body = { To: "+19546377300", From: from, CallSid: "CA00000000000000000000000000000001", ...callback.fields };
    const signature = twilio.getExpectedTwilioSignature(
      "voice-routing-test-token",
      `https://support.example.test${path}`,
      body,
    );
    return fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(signed ? { "x-twilio-signature": signature } : {}),
      },
      body: new URLSearchParams(body),
    });
  };
}

function assertGreeting(xml: string, nextVerb: string) {
  assert.match(xml, /^<\?xml[^>]*><Response><Say voice="alice">Computer Systems Depot<\/Say>/);
  assert.equal(xml.split("Computer Systems Depot").length - 1, 1);
  assert.ok(xml.indexOf("Computer Systems Depot") < xml.indexOf(nextVerb));
  assert.ok(!xml.includes("127.0.0.1"), "continuations must use the canonical public URL");
}

test("known, new, international, blocked and missing caller IDs hear the Computer Systems Depot greeting before dial, regardless of hours", async t => {
  const post = await startServer(t);
  for (const from of ["+12025550101", "+12025550102", "+447700900123", "anonymous", "restricted", "Unknown", ""]) {
    const response = await post(from);
    assert.equal(response.status, 200);
    const xml = await response.text();
    assertGreeting(xml, "<Dial");
    const expectedCallerId = /^\+\d+$/.test(from) ? from : "+19546377300";
    assert.ok(xml.includes(`callerId="${expectedCallerId}"`));
    assert.ok(xml.includes("answerOnBridge=\"true\""));
    assert.ok(xml.includes("+12025550199"));
  }
});

test("custom tracking flows still start with the main-line greeting", async t => {
  const post = await startServer(t, {
    getTrackingNumberByPhone: async () => ({ id: 1, active: true, callFlowId: 7 }) as any,
    getCallFlow: async () => ({ id: 7, steps: [{ type: "menu" }] }) as any,
    alertTeamOfCall: async () => new Promise<void>(() => {}),
  });
  const response = await post("anonymous");
  assert.equal(response.status, 200);
  assertGreeting(await response.text(), "<Redirect");
});

test("no available staff or disabled forwarding still answers with the Computer Systems Depot greeting before voicemail", async t => {
  for (const overrides of [
    { getActiveCallRecipientPhones: async () => [] },
    { getTwilioSettings: async () => ({ ...settings, callForwardingEnabled: false }) as any },
  ]) {
    const post = await startServer(t, overrides);
    const response = await post("+12025550102");
    assert.equal(response.status, 200);
    assertGreeting(await response.text(), "<Record");
  }
});

test("settings outage returns an authenticated greeting and voicemail rather than an unanswered HTTP error", async t => {
  const post = await startServer(t, {
    getTwilioSettings: async () => { throw new Error("Database unavailable"); },
  });
  const response = await post("anonymous");
  assert.equal(response.status, 200);
  const xml = await response.text();
  assertGreeting(xml, "<Record");
  assert.match(xml, /Please leave a message after the tone/);
  assert.match(xml, /https:\/\/support.example.test\/webhooks\/voice\/voicemail-recorded/);
});

test("logging and tracking failures cannot prevent the greeting", async t => {
  const post = await startServer(t, {
    getTrackingNumberByPhone: async () => { throw new Error("Unavailable"); },
    upsertCallLog: async () => { throw new Error("Unavailable"); },
  });
  const response = await post("+12025550102");
  assert.equal(response.status, 200);
  assertGreeting(await response.text(), "<Dial");
});

test("a stalled settings lookup reaches voicemail within the routing deadline", async t => {
  const post = await startServer(t, {
    getTwilioSettings: async () => new Promise<any>(() => {}),
  });
  const response = await post("anonymous");
  assert.equal(response.status, 200);
  assertGreeting(await response.text(), "<Record");
  await assert.rejects(withVoiceRoutingDeadline(new Promise(() => {}), 5), /timed out/);
});

test("unknown callers do not bypass webhook signature verification", async t => {
  const post = await startServer(t);
  assert.equal((await post("anonymous", false)).status, 403);
});

test("custom-flow forwarding replaces blocked caller IDs with the called business number", () => {
  assert.equal(forwardedCallerId("anonymous", "+19546377300", true), "+19546377300");
  const xml = renderStep({ type: "dial", to: "+12025550199", callerId: "original" }, {
    base: "https://support.example.test", flowId: 7, idx: 0, totalSteps: 1,
    fromNumber: "anonymous", trackingPhone: "+19546377300",
  });
  assert.match(xml, /callerId="\+19546377300"/);
  assert.ok(!xml.includes('callerId="anonymous"'));
});

test("main-line calls ring the requested three numbers in order, bypass mobile voicemail and finally record a message", async t => {
  const notices: string[] = [];
  const orderedSettings = {
    ...settings, forwardToNumber: "+19546706084",
    backupForwardNumber: "+19546706124", backupForwardNumber2: "+19542533135",
  };
  const post = await startServer(t, {
    getTwilioSettings: async () => orderedSettings as any,
    getTrackingNumberByPhone: async () => ({ id: 1, active: true, callFlowId: 7 }) as any,
    getCallFlow: async () => ({ id: 7, steps: [{ type: "hangup" }] }) as any,
    notifyStaffEvent: async event => { notices.push(event.kind); },
  });
  const initial = await post("anonymous");
  assert.equal(initial.status, 200);
  const initialXml = await initial.text();
  assertGreeting(initialXml, "<Dial");
  assert.match(initialXml, /\+19546706084<\/Number>/);
  assert.ok(!initialXml.includes("+19546706124</Number>"));
  assert.ok(!initialXml.includes("<Redirect"));
  assert.match(initialXml, /attempt=primary&amp;screened=1/);
  assert.match(initialXml, /confirm=1/);

  for (const [attempt, status, nextNumber] of [
    ["primary", "no-answer", "+19546706124"],
    ["primary", "completed", "+19546706124"], // Mobile voicemail answered, but never accepted.
    ["backup1", "busy", "+19542533135"],
  ]) {
    const response = await post("anonymous", true, {
      path: `/webhooks/voice/dial-result?attempt=${attempt}&screened=1`,
      fields: { DialCallStatus: status, DialBridged: "false" },
    });
    assert.equal(response.status, 200);
    const xml = await response.text();
    assert.ok(xml.includes(`${nextNumber}</Number>`));
    assert.match(xml, /callerId="\+19546377300"/);
    assert.match(xml, /confirm=1/);
  }
  const final = await post("anonymous", true, {
    path: "/webhooks/voice/dial-result?attempt=backup2&screened=1",
    fields: { DialCallStatus: "failed", DialBridged: "false" },
  });
  assert.equal(final.status, 200);
  const finalXml = await final.text();
  assert.match(finalXml, /<Record/);
  assert.ok(!finalXml.includes("<Dial"));
  assert.deepEqual(notices, ["call", "missed-call"]);

  const accepted = await post("+12025550102", true, {
    path: "/webhooks/voice/dial-result?attempt=backup1&screened=1",
    fields: { DialCallStatus: "completed", DialBridged: "true" },
  });
  assert.match(await accepted.text(), /<Hangup\/>/);
  assert.deepEqual(notices, ["call", "missed-call"], "answered calls do not create missed notices");
});

test("press-1 screening and acceptance remain signature protected", async t => {
  const post = await startServer(t);
  const screening = await post("anonymous", true, { path: "/webhooks/voice/whisper?confirm=1" });
  const xml = await screening.text();
  assert.match(xml, /<Gather[^>]*numDigits="1"/);
  assert.match(xml, /Press any key to take this C S D call/);
  assert.match(xml, /<Hangup\/>/);
  const accept = await post("anonymous", true, { path: "/webhooks/voice/accept", fields: { Digits: "1" } });
  assert.match(await accept.text(), /Connecting your call/);
  const reject = await post("anonymous", true, { path: "/webhooks/voice/accept" });
  assert.match(await reject.text(), /<Hangup\/>/);
  assert.equal((await post("anonymous", false, { path: "/webhooks/voice/accept", fields: { Digits: "1" } })).status, 403);
});

test("a technician's explicit acceptance prevents ringing the next configured number even if Twilio reports unbridged", async t => {
  const outcomes: any[] = [];
  const parentCallSid = "CA00000000000000000000000000000001";
  const childCallSid = "CA00000000000000000000000000000002";
  const orderedSettings = {
    ...settings, forwardToNumber: "+19546706084",
    backupForwardNumber: "+19546706124", backupForwardNumber2: "+19542533135",
  };
  const post = await startServer(t, {
    getTwilioSettings: async () => orderedSettings as any,
    saveForwardingOutcome: async outcome => { outcomes.push(outcome); },
    loadForwardingOutcomes: async callSid => outcomes.filter(outcome => outcome.parentCallSid === callSid),
  });

  const incoming = await post("anonymous");
  const incomingXml = await incoming.text();
  assert.match(incomingXml, new RegExp(
    `voice/whisper\\?from=.*confirm=1&amp;attempt=primary&amp;parent=${parentCallSid}&amp;destination=%2B19546706084`,
  ));

  const whisper = await post("anonymous", true, {
    path: `/webhooks/voice/whisper?confirm=1&attempt=primary&parent=${parentCallSid}&destination=%2B19546706084`,
  });
  assert.match(await whisper.text(), new RegExp(
    `voice/accept\\?parent=${parentCallSid}&amp;destination=%2B19546706084&amp;attempt=primary`,
  ));

  const accepted = await post("anonymous", true, {
    path: `/webhooks/voice/accept?attempt=primary&parent=${parentCallSid}&destination=%2B19546706084`,
    fields: { CallSid: childCallSid, Digits: "7" },
  });
  assert.match(await accepted.text(), /Connecting your call/);
  assert.equal(outcomes[0].humanAccepted, true);
  assert.equal(outcomes[0].attemptKey, "primary");

  const result = await post("anonymous", true, {
    path: "/webhooks/voice/dial-result?attempt=primary&screened=1&destination=%2B19546706084",
    fields: {
      CallSid: parentCallSid,
      DialCallSid: childCallSid,
      DialCallStatus: "completed",
      DialBridged: "false",
    },
  });
  const resultXml = await result.text();
  assert.match(resultXml, /<Hangup\/>/);
  assert.ok(!resultXml.includes("+19546706124"), "a backup must not ring after a technician explicitly accepted");
});

test("dial results persist provider status separately from press-1 human acceptance", async t => {
  const outcomes: any[] = [];
  const post = await startServer(t, {
    saveForwardingOutcome: async outcome => { outcomes.push(outcome); },
  });
  const common = {
    fields: {
      CallSid: "CA00000000000000000000000000000001",
      DialCallSid: "CA00000000000000000000000000000002",
    },
  };

  await post("+12025550101", true, {
    ...common,
    path: "/webhooks/voice/dial-result?attempt=primary&screened=1&destination=%2B19546706084",
    fields: { ...common.fields, DialCallStatus: "completed", DialBridged: "true" },
  });
  await post("+12025550101", true, {
    ...common,
    path: "/webhooks/voice/dial-result?attempt=backup1&screened=1&destination=%2B19546706124",
    fields: { ...common.fields, DialCallSid: "CA00000000000000000000000000000003", DialCallStatus: "busy", DialBridged: "false" },
  });

  assert.deepEqual(outcomes.map(({ attemptKey, destinationNumber, providerStatus, humanAccepted }) => ({
    attemptKey, destinationNumber, providerStatus, humanAccepted,
  })), [
    { attemptKey: "primary", destinationNumber: "+19546706084", providerStatus: "completed", humanAccepted: true },
    { attemptKey: "backup1", destinationNumber: "+19546706124", providerStatus: "busy", humanAccepted: false },
  ]);
});

test("parallel staff call legs save their own provider status and press-1 acceptance", async t => {
  const outcomes: any[] = [];
  const parentCallSid = "CA00000000000000000000000000000001";
  const firstChildSid = "CA00000000000000000000000000000002";
  const secondChildSid = "CA00000000000000000000000000000003";
  const destinations = ["+12025550101", "+12025550102"];
  const post = await startServer(t, {
    getActiveCallRecipientPhones: async () => destinations,
    saveForwardingOutcome: async outcome => { outcomes.push(outcome); },
  });

  const incoming = await post("anonymous");
  const xml = await incoming.text();
  assert.match(xml, /route=staff/);
  assert.match(xml, /staff-destination-status\?parent=CA00000000000000000000000000000001&amp;destination=%2B12025550101/);
  assert.match(xml, /staff-destination-status\?parent=CA00000000000000000000000000000001&amp;destination=%2B12025550102/);
  const whisper = await post("anonymous", true, {
    path: `/webhooks/voice/whisper?confirm=1&route=staff&parent=${parentCallSid}&destination=${encodeURIComponent(destinations[0])}`,
  });
  const whisperXml = await whisper.text();
  assert.match(whisperXml, /Press any key to take this C S D call/);
  assert.match(whisperXml, /voice\/accept\?route=staff&amp;parent=CA00000000000000000000000000000001&amp;destination=%2B12025550101/);

  for (const [destination, childCallSid, providerStatus] of [
    [destinations[0], firstChildSid, "ringing"],
    [destinations[1], secondChildSid, "canceled"],
  ]) {
    const query = new URLSearchParams({ parent: parentCallSid, destination });
    const response = await post("anonymous", true, {
      path: `/webhooks/voice/staff-destination-status?${query}`,
      fields: { CallSid: childCallSid, CallStatus: providerStatus },
    });
    assert.equal(response.status, 204);
  }
  const accepted = await post("anonymous", true, {
    path: `/webhooks/voice/accept?route=staff&parent=${parentCallSid}&destination=${encodeURIComponent(destinations[0])}`,
    fields: { CallSid: firstChildSid, Digits: "1" },
  });
  assert.match(await accepted.text(), /Connecting your call/);
  assert.deepEqual(outcomes.map(({ parentCallSid: parent, childCallSid, attemptKey, destinationNumber, providerStatus, humanAccepted }) => ({
    parentCallSid: parent, childCallSid, attemptKey, destinationNumber, providerStatus, humanAccepted,
  })), [
    {
      parentCallSid, childCallSid: firstChildSid, attemptKey: "staff",
      destinationNumber: destinations[0], providerStatus: "ringing", humanAccepted: false,
    },
    {
      parentCallSid, childCallSid: secondChildSid, attemptKey: "staff",
      destinationNumber: destinations[1], providerStatus: "canceled", humanAccepted: false,
    },
    {
      parentCallSid, childCallSid: firstChildSid, attemptKey: "staff",
      destinationNumber: destinations[0], providerStatus: "unknown", humanAccepted: true,
    },
  ]);
});

test("notification failures do not stop forwarding and failed continuation settings still reach voicemail", async t => {
  const post = await startServer(t, {
    notifyStaffEvent: async () => { throw new Error("Queue unavailable"); },
  });
  assertGreeting(await (await post("anonymous")).text(), "<Dial");
  const unavailable = await startServer(t, {
    getTwilioSettings: async () => { throw new Error("Unavailable"); },
  });
  const response = await unavailable("anonymous", true, {
    path: "/webhooks/voice/dial-result?attempt=primary&screened=1", fields: { DialCallStatus: "busy" },
  });
  assert.equal(response.status, 200);
  assertGreeting(await response.text(), "<Record");
});

test("configured forwarding skips invalid, empty and duplicate destinations", () => {
  assert.deepEqual(configuredForwardTargets({
    forwardToNumber: "+19546706084", backupForwardNumber: "", backupForwardNumber2: "+19546706084",
  }), [{ key: "primary", number: "+19546706084" }]);
  assert.deepEqual(configuredForwardTargets({ forwardToNumber: "anonymous", backupForwardNumber: "+19546706124" }),
    [{ key: "backup1", number: "+19546706124" }]);
});