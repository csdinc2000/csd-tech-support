import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import twilio from "twilio";
import {
  persistSmsStatusCallback,
  registerTwilioForwarding,
  resolveLiveCallTargets,
} from "./twilio-forwarding";
import {
  twilioWebhookSignatureBoundary,
  verifyTwilioSignature,
} from "./twilio-webhook-security";
import { registerTwilioTracking } from "./twilio-tracking";
import { registerRoipRoutes } from "./roip";

const CALLBACK_ROUTES = [
  "/webhooks/sms/incoming",
  "/webhooks/sms/status",
  "/webhooks/sms/tracking",
  "/webhooks/roip/sip",
  "/webhooks/voice/incoming",
  "/webhooks/voice/dial-result",
  "/webhooks/voice/staff-destination-status",
  "/webhooks/voice/whisper",
  "/webhooks/voice/accept",
  "/webhooks/voice/voicemail-recorded",
  "/webhooks/voice/voicemail-transcription",
  "/webhooks/voice/status",
  "/webhooks/voice/flow/1/step/0",
  "/webhooks/voice/flow/1/step/0/menu",
  "/webhooks/voice/flow/1/voicemail-saved",
] as const;

function createCallbackServer(settings?: Record<string, unknown>) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use("/webhooks", twilioWebhookSignatureBoundary);
  registerTwilioForwarding(
    app,
    settings
      ? { getTwilioSettings: async () => settings as any }
      : undefined,
  );
  registerTwilioTracking(app);
  registerRoipRoutes(app);
  return app.listen(0, "127.0.0.1");
}

function createFutureCallbackServer() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use("/webhooks", twilioWebhookSignatureBoundary);
  app.post("/webhooks/future-callback", (_req, res) => res.sendStatus(204));
  app.get("/webhooks/public-resource", (_req, res) => res.status(200).send("public"));
  return app.listen(0, "127.0.0.1");
}

function createTrackingApiServer() {
  const app = express();
  app.use(express.json());
  registerTwilioTracking(app);
  return app.listen(0, "127.0.0.1");
}

test("call-tracking contact creation rejects malformed phones before storage", async (t) => {
  const server = createTrackingApiServer();
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  for (const [field, phone, message] of [
    ["mobilePhone", "+44 20 CALL-NOW", "Mobile phone must be a valid phone number"],
    ["officePhone", "+44++2071234567", "Office phone must be a valid phone number"],
  ] as const) {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/call-tracking/calls/999999/contact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fullName: "Invalid Phone", email: `invalid-${field}@example.com`, [field]: phone }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: message });
  }
});

async function postCallback(
  baseUrl: string,
  path: string,
  body: Record<string, string> = {},
  signature?: string,
) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(signature ? { "x-twilio-signature": signature } : {}),
    },
    body: new URLSearchParams(body),
  });
}

test("production Twilio callbacks reject a missing signature", async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldToken = process.env.TWILIO_AUTH_TOKEN;
  const oldSkip = process.env.TWILIO_SKIP_SIGNATURE_VERIFY;
  process.env.NODE_ENV = "production";
  process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
  process.env.TWILIO_SKIP_SIGNATURE_VERIFY = "1";
  let statusCode = 200;
  let responseBody = "";
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    type() {
      return this;
    },
    send(body: string) {
      responseBody = body;
      return this;
    },
  };
  const request = {
    get(name: string) {
      if (name.toLowerCase() === "host") return "example.test";
      return undefined;
    },
    protocol: "https",
    originalUrl: "/webhooks/sms/incoming",
    body: { From: "+15555550123", Body: "CLAIM SEC-1" },
  };
  try {
    assert.equal(
      await verifyTwilioSignature(request as any, response as any),
      false,
    );
    assert.equal(statusCode, 403);
    assert.equal(responseBody, "Invalid Twilio signature");

    delete process.env.TWILIO_AUTH_TOKEN;
    statusCode = 200;
    responseBody = "";
    assert.equal(
      await verifyTwilioSignature(request as any, response as any),
      false,
    );
    assert.equal(statusCode, 503);
    assert.equal(responseBody, "Twilio webhook verification is not configured");
  } finally {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    if (oldToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = oldToken;
    if (oldSkip === undefined) delete process.env.TWILIO_SKIP_SIGNATURE_VERIFY;
    else process.env.TWILIO_SKIP_SIGNATURE_VERIFY = oldSkip;
  }
});

test("every registered Twilio callback rejects unsigned production requests", async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldToken = process.env.TWILIO_AUTH_TOKEN;
  const oldSkip = process.env.TWILIO_SKIP_SIGNATURE_VERIFY;
  process.env.NODE_ENV = "production";
  process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
  process.env.TWILIO_SKIP_SIGNATURE_VERIFY = "1";
  const server = createCallbackServer();
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    for (const route of CALLBACK_ROUTES) {
      const response = await postCallback(baseUrl, route);
      assert.equal(response.status, 403, route);
      assert.equal(await response.text(), "Invalid Twilio signature", route);
    }

    delete process.env.TWILIO_AUTH_TOKEN;
    for (const route of CALLBACK_ROUTES) {
      const response = await postCallback(baseUrl, route);
      assert.equal(response.status, 503, route);
      assert.equal(
        await response.text(),
        "Twilio webhook verification is not configured",
        route,
      );
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    if (oldToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = oldToken;
    if (oldSkip === undefined) delete process.env.TWILIO_SKIP_SIGNATURE_VERIFY;
    else process.env.TWILIO_SKIP_SIGNATURE_VERIFY = oldSkip;
  }
});

test("new Twilio POST callbacks inherit verification while public GET resources remain open", async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldToken = process.env.TWILIO_AUTH_TOKEN;
  process.env.NODE_ENV = "production";
  process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
  const server = createFutureCallbackServer();
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const forged = await postCallback(baseUrl, "/webhooks/future-callback");
    assert.equal(forged.status, 403);
    assert.equal(await forged.text(), "Invalid Twilio signature");

    const publicResource = await fetch(`${baseUrl}/webhooks/public-resource`);
    assert.equal(publicResource.status, 200);
    assert.equal(await publicResource.text(), "public");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    if (oldToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = oldToken;
  }
});

test("RoIP accepts a canonical APP_BASE_URL signature behind a different ingress host", async () => {
  const originalEnv = { ...process.env };
  const authToken = "test-auth-token";
  const canonicalBaseUrl = "https://support.example.test";
  Object.assign(process.env, {
    NODE_ENV: "production",
    TWILIO_AUTH_TOKEN: authToken,
    APP_BASE_URL: canonicalBaseUrl,
    ROIP_ENABLED: "true",
    ROIP_SINGLE_INSTANCE: "true",
    ROIP_SIP_DOMAIN: "gateway.sip.twilio.com",
    ROIP_SIP_USERNAME: "gateway",
    ROIP_SIP_PASSWORD: "server-only-password",
  });
  const server = createCallbackServer();
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const ingressBaseUrl = `http://127.0.0.1:${address.port}`;
  const path = "/webhooks/roip/sip";
  const signature = twilio.getExpectedTwilioSignature(
    authToken,
    `${canonicalBaseUrl}${path}`,
    {},
  );

  try {
    const valid = await postCallback(ingressBaseUrl, path, {}, signature);
    assert.equal(valid.status, 200);
    assert.match(await valid.text(), /<Stream url="wss:\/\/support\.example\.test\/ws\/roip\?token=/);

    const forged = await postCallback(ingressBaseUrl, path, {}, "forged");
    assert.equal(forged.status, 403);
    assert.equal(await forged.text(), "Invalid Twilio signature");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
});

test("roster no-answer callback never dials legacy personal numbers", async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldToken = process.env.TWILIO_AUTH_TOKEN;
  const oldAlerts = process.env.CSD_CALL_ALERT_ENABLED;
  const oldAppBaseUrl = process.env.APP_BASE_URL;
  const authToken = "test-auth-token";
  const legacyNumbers = ["+15555550111", "+15555550112", "+15555550113"];
  process.env.NODE_ENV = "production";
  process.env.TWILIO_AUTH_TOKEN = authToken;
  process.env.CSD_CALL_ALERT_ENABLED = "false";
  delete process.env.APP_BASE_URL;
  const server = createCallbackServer({
    forwardToNumber: legacyNumbers[0],
    backupForwardNumber: legacyNumbers[1],
    backupForwardNumber2: legacyNumbers[2],
    showCallerIdOnForward: true,
    twilioPhoneNumber: "+15555550999",
    dialTimeoutSeconds: 25,
    whisperEnabled: false,
    voicemailEnabled: false,
    voicemailNotifyNumber: "",
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const path = "/webhooks/voice/dial-result?route=staff";
  const body = {
    DialCallStatus: "no-answer",
    From: "+15555550001",
    To: "+15555550999",
  };
  const signature = twilio.getExpectedTwilioSignature(
    authToken,
    `${baseUrl}${path}`,
    body,
  );

  try {
    const response = await postCallback(baseUrl, path, body, signature);
    assert.equal(response.status, 200);
    const xml = await response.text();
    assert.match(xml, /<Hangup\/>/);
    assert.doesNotMatch(xml, /<Dial/);
    for (const number of legacyNumbers) assert.ok(!xml.includes(number), number);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    if (oldToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = oldToken;
    if (oldAlerts === undefined) delete process.env.CSD_CALL_ALERT_ENABLED;
    else process.env.CSD_CALL_ALERT_ENABLED = oldAlerts;
    if (oldAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = oldAppBaseUrl;
  }
});

test("main-line call routing never substitutes legacy numbers for an empty roster", () => {
  assert.deepEqual(resolveLiveCallTargets(null, []), []);
  assert.deepEqual(
    resolveLiveCallTargets(null, ["+15555550111", "+15555550112"]),
    ["+15555550111", "+15555550112"],
  );
  assert.deepEqual(
    resolveLiveCallTargets("+15555550999", ["+15555550111"]),
    ["+15555550999"],
  );
});

test("status callbacks fail when persistence fails so Twilio can retry", async () => {
  await assert.rejects(
    persistSmsStatusCallback(
      "SM-test",
      "delivered",
      null,
      123,
      async () => {
        throw new Error("forced database failure");
      },
    ),
    /forced database failure/,
  );
});