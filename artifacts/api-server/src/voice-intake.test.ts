import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import {
  containsCardNumber,
  registerVoiceIntakeRoutes,
  sanitizeInterpretation,
  type InterpretRequest,
  type ModelInterpretation,
  type VoiceInterpreter,
} from "./voice-intake";

const options = {
  deviceType: ["Laptop", "Desktop", "All-in-One", "Other"],
  operatingSystem: ["Windows 11", "Windows 10", "macOS (Mac)", "Chrome OS", "Other"],
  howDidYouHear: ["Google Search", "Referral from Friend/Family", "Other"],
  services: [{ id: 3, name: "Computer Repair" }, { id: 7, name: "Virus Removal" }],
};

const request = (overrides: Partial<InterpretRequest> = {}): InterpretRequest => ({
  step: "deviceType",
  question: "What kind of computer are you having trouble with?",
  utterance: "It's a Dell laptop and it won't turn on",
  values: {},
  options,
  followUpsRemaining: 0,
  ...overrides,
});

const empty: ModelInterpretation["updates"] = {
  customerName: null, companyName: null, phoneNumber: null, emailAddress: null, streetAddress: null,
  city: null, state: null, zip: null, contactPreference: null, serviceId: null, deviceType: null,
  deviceBrandModel: null, operatingSystem: null, problemDetail: null, howDidYouHear: null,
};

const model = (updates: Partial<ModelInterpretation["updates"]>, rest: Partial<ModelInterpretation> = {}): ModelInterpretation => ({
  intent: "answer",
  updates: { ...empty, ...updates },
  changeField: null,
  acknowledgement: "Got it.",
  followUpQuestion: null,
  ...rest,
});

test("one natural sentence fills several fields, and only those", () => {
  const out = sanitizeInterpretation(
    model({ deviceType: "laptop", deviceBrandModel: "Dell", problemDetail: "It won't turn on." }),
    request(),
  );
  assert.deepEqual(out.updates, { deviceType: "Laptop", deviceBrandModel: "Dell", problemDetail: "It won't turn on." });
});

test("dropdown answers outside the offered options are dropped, never forced", () => {
  const out = sanitizeInterpretation(
    model({ deviceType: "Tablet", operatingSystem: "Windows 12", howDidYouHear: "TikTok", serviceId: 999 }),
    request(),
  );
  assert.deepEqual(out.updates, {});
});

test("service ids must come from the offered catalog", () => {
  assert.equal(sanitizeInterpretation(model({ serviceId: 7 }), request()).updates.serviceId, 7);
});

test("spoken contact details are normalised and invalid ones discarded", () => {
  const ok = sanitizeInterpretation(
    model({ emailAddress: " Dana.Rivera @Example.com ", phoneNumber: "(954) 555-0123", zip: "33313" }),
    request({ step: "emailAddress" }),
  );
  assert.equal(ok.updates.emailAddress, "dana.rivera@example.com");
  assert.equal(ok.updates.phoneNumber, "9545550123");
  assert.equal(ok.updates.zip, "33313");

  const bad = sanitizeInterpretation(
    model({ emailAddress: "dana at example", phoneNumber: "555-0123", zip: "333" }),
    request({ step: "emailAddress" }),
  );
  assert.deepEqual(bad.updates, {});
});

test("card numbers are detected (Luhn) and never carried into the form", () => {
  assert.equal(containsCardNumber("my card is 4111 1111 1111 1111"), true);
  assert.equal(containsCardNumber("call me at 954 555 0123"), false);
  assert.equal(containsCardNumber("order 1234567890123"), false);
  const out = sanitizeInterpretation(model({ problemDetail: "charged 4111-1111-1111-1111 twice" }), request());
  assert.equal(out.updates.problemDetail, undefined);
});

test("follow-up questions only on the problem step while follow-ups remain", () => {
  const raw = model({}, { followUpQuestion: "Do you see any lights when you press the power button?" });
  assert.equal(sanitizeInterpretation(raw, request()).followUpQuestion, null);
  assert.equal(sanitizeInterpretation(raw, request({ step: "problemDescription", followUpsRemaining: 0 })).followUpQuestion, null);
  assert.match(
    sanitizeInterpretation(raw, request({ step: "problemDescription", followUpsRemaining: 1 })).followUpQuestion!,
    /lights/,
  );
});

test("changeField is limited to real form fields (never smsConsent)", () => {
  assert.equal(sanitizeInterpretation(model({}, { intent: "change", changeField: "emailAddress" }), request()).changeField, "emailAddress");
  assert.equal(sanitizeInterpretation(model({}, { intent: "change", changeField: "smsConsent" }), request()).changeField, null);
});

async function withServer(
  opts: { interpreter?: VoiceInterpreter; enabled?: boolean },
  fn: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  registerVoiceIntakeRoutes(app, opts);
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
  }
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("interpret route sanitizes model output and reports AI status", async () => {
  let calls = 0;
  const interpreter: VoiceInterpreter = async () => {
    calls++;
    return model({ deviceType: "Laptop", deviceBrandModel: "Dell", operatingSystem: "Windows 99" });
  };
  await withServer({ interpreter, enabled: true }, async (base) => {
    const status = await (await fetch(`${base}/api/portal/voice-intake/status`)).json();
    assert.equal(status.aiEnabled, true);

    const res = await post(`${base}/api/portal/voice-intake/interpret`, request());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.updates, { deviceType: "Laptop", deviceBrandModel: "Dell" });

    // Card numbers are answered locally and never reach the interpreter.
    const card = await post(`${base}/api/portal/voice-intake/interpret`, request({ utterance: "4111 1111 1111 1111" }));
    assert.equal((await card.json()).intent, "sensitive");
    assert.equal(calls, 1);

    const invalid = await post(`${base}/api/portal/voice-intake/interpret`, { step: "x" });
    assert.equal(invalid.status, 400);
  });
});

test("interpret route degrades cleanly when AI is off or failing", async () => {
  await withServer({ enabled: false }, async (base) => {
    assert.equal((await (await fetch(`${base}/api/portal/voice-intake/status`)).json()).aiEnabled, false);
    assert.equal((await post(`${base}/api/portal/voice-intake/interpret`, request())).status, 503);
  });
  await withServer({ enabled: true, interpreter: async () => { throw new Error("boom"); } }, async (base) => {
    assert.equal((await post(`${base}/api/portal/voice-intake/interpret`, request())).status, 502);
  });
});
