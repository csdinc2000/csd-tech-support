import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import twilio from "twilio";
import { registerOutboundCallRoutes, type OutboundCallRouteOptions } from "./routes/outbound-call-routes";
import {
  createBrowserCallGrant,
  registerBrowserVoiceRoutes,
  verifyBrowserCallGrant,
  type BrowserVoiceRouteOptions,
} from "./routes/browser-voice-routes";
import type { OutboundCallOutcome } from "./outbound-call-outcomes";
import { twilioWebhookSignatureBoundary } from "./twilio-webhook-security";

// Twilio, contacts and call logging are all stubbed: no real calls are placed.
process.env.NODE_ENV = "production";
process.env.TWILIO_AUTH_TOKEN = "outbound-call-test-token";
process.env.APP_BASE_URL = "https://support.example.test";

const BASE = "https://support.example.test";
const BUSINESS = "+19546377300";
const STAFF = "+19546706084";
const CUSTOMER = "+13055550123";

const fullScope = { unrestricted: true, staffAdministrator: false, clientIds: new Set<number>(), jobIds: new Set<number>(), contactIds: new Set<number>(), editableContactIds: new Set<number>() };

async function startServer(
  t: TestContext,
  overrides: Partial<OutboundCallRouteOptions> = {},
  browserSetup: "ready" | "missing" = "ready",
  browserOverrides: Partial<BrowserVoiceRouteOptions> = {},
) {
  const created: Parameters<OutboundCallRouteOptions["createCall"]>[0][] = [];
  const logged: unknown[] = [];
  const outcomes = new Map<string, OutboundCallOutcome>();
  const createOutcome = async (input: Omit<OutboundCallOutcome, "parentCallSid" | "childCallSid" | "durationSeconds" | "createdAt" | "updatedAt">) => {
    const now = new Date().toISOString();
    outcomes.set(input.callId, {
      ...input,
      parentCallSid: null,
      childCallSid: null,
      durationSeconds: 0,
      createdAt: now,
      updatedAt: now,
    });
  };
  const updateOutcome = async (
    callId: string,
    patch: { status: OutboundCallOutcome["status"]; parentCallSid?: string | null; childCallSid?: string | null; durationSeconds?: number },
  ) => {
    const existing = outcomes.get(callId);
    if (existing) outcomes.set(callId, { ...existing, ...patch, updatedAt: new Date().toISOString() });
  };
  const getOutcome = async (callId: string) => outcomes.get(callId) ?? null;
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use("/webhooks", twilioWebhookSignatureBoundary);
  registerOutboundCallRoutes(app, {
    isTwilioConfigured: () => true,
    getFromNumber: async () => BUSINESS,
    getAgentPhones: async () => [STAFF, "+19546706124"],
    createCall: async (input) => { created.push(input); return { sid: "CA-test", status: "queued" }; },
    recordCall: async (entry) => { logged.push(entry); },
    canSeeContact: () => true,
    canEditContact: () => true,
    publicBaseUrl: () => BASE,
    getContacts: async () => [{ id: 7, fullName: "Pat Customer", mobilePhone: "(305) 555-0123" }],
    getScope: async () => fullScope,
    isApprovedStaff: async () => true,
    getActorUserId: () => "staff-test-user",
    getScopeForUserId: async () => fullScope,
    isApprovedStaffForUserId: async () => true,
    createOutcome,
    updateOutcome,
    getOutcome,
    ...overrides,
  });
  registerBrowserVoiceRoutes(app, {
    getFromNumber: async () => BUSINESS,
    canSeeContact: () => true,
    canEditContact: () => true,
    getContacts: async () => [{ id: 7, fullName: "Pat Customer", mobilePhone: "(305) 555-0123" }],
    getScopeForUserId: async () => fullScope,
    getActorUserId: () => "staff-test-user",
    isApprovedStaffForUserId: async () => true,
    publicBaseUrl: () => BASE,
    recordCall: async (entry) => { logged.push(entry); },
    createOutcome,
    updateOutcome,
    getOutcome,
    env: {
      NODE_ENV: "production",
      APP_BASE_URL: BASE,
      TWILIO_ACCOUNT_SID: "AC-test",
      TWILIO_API_KEY_SID: browserSetup === "ready" ? "SK-test" : "",
      TWILIO_API_KEY_SECRET: browserSetup === "ready" ? "browser-test-api-key-secret" : "",
      TWILIO_TWIML_APP_SID: browserSetup === "ready" ? "AP-test" : "",
      TWILIO_AUTH_TOKEN: "outbound-call-test-token",
      SESSION_SECRET: "browser-test-signing-secret",
    },
    ...browserOverrides,
  });
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}`;
  const post = (body: unknown) => fetch(`${url}/api/twilio/calls/outbound`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const postBrowser = (body: unknown) => fetch(`${url}/api/twilio/calls/browser-token`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const getStatus = (callId: string) => fetch(`${url}/api/twilio/calls/outbound/${callId}/status`);
  return { url, post, postBrowser, getStatus, created, logged, outcomes };
}

test("rings the default staff phone and logs the call against the customer", async (t) => {
  const { post, created, logged } = await startServer(t);
  const res = await post({ to: "305-555-0123" });
  assert.equal(res.status, 200);
  const payload = await res.json() as { success: boolean; sid: string; callId: string; to: string; agentPhone: string; contactId: number };
  assert.deepEqual(
    { success: payload.success, sid: payload.sid, to: payload.to, agentPhone: payload.agentPhone, contactId: payload.contactId },
    { success: true, sid: "CA-test", to: CUSTOMER, agentPhone: STAFF, contactId: 7 },
  );
  assert.match(payload.callId, /^[0-9a-f-]{36}$/i);
  assert.equal(created.length, 1);
  assert.equal(created[0].to, STAFF);
  assert.equal(created[0].from, BUSINESS);
  assert.equal(created[0].statusCallback, `${BASE}/webhooks/voice/callback-status?callId=${payload.callId}`);
  assert.match(created[0].twiml, /<Gather[^>]*numDigits="1"/);
  assert.match(created[0].twiml, /outbound-connect\?to=%2B13055550123/);
  assert.match(created[0].twiml, /Pat Customer/);
  assert.deepEqual(logged, [{
    callSid: "CA-test", fromNumber: BUSINESS, toNumber: CUSTOMER, status: "queued",
    direction: "outbound", durationSeconds: 0, hadVoicemail: false, contactId: 7,
  }]);
});

test("refuses to ring a staff leg that is not a configured forwarding phone", async (t) => {
  const { post, created } = await startServer(t);
  const res = await post({ to: CUSTOMER, agentPhone: "+12025550100" });
  assert.equal(res.status, 400);
  assert.equal(created.length, 0);
});

test("enforces contact access before placing a call", async (t) => {
  const hidden = await startServer(t, { canSeeContact: () => false });
  assert.equal((await hidden.post({ to: CUSTOMER })).status, 404);
  const readOnly = await startServer(t, { canEditContact: () => false });
  assert.equal((await readOnly.post({ to: CUSTOMER })).status, 403);
  const unapproved = await startServer(t, { getContacts: async () => [], isApprovedStaff: async () => false });
  assert.equal((await unapproved.post({ to: CUSTOMER })).status, 403);
  const unapprovedKnown = await startServer(t, { isApprovedStaff: async () => false });
  assert.equal((await unapprovedKnown.post({ to: CUSTOMER })).status, 403);
  assert.equal(hidden.created.length + readOnly.created.length + unapproved.created.length + unapprovedKnown.created.length, 0);
});

test("rejects invalid numbers and mismatched contactId", async (t) => {
  const { post, created } = await startServer(t);
  assert.equal((await post({ to: "12" })).status, 400);
  assert.equal((await post({ to: CUSTOMER, contactId: 99 })).status, 400);
  assert.equal(created.length, 0);
});

function signedPost(url: string, path: string, params: Record<string, string>) {
  const signature = twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN!, `${BASE}${path}`, params);
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
    body: new URLSearchParams(params),
  });
}

test("connect webhook dials the customer only after staff press 1", async (t) => {
  const { url, post } = await startServer(t);
  const started = await post({ to: CUSTOMER });
  const { callId } = await started.json() as { callId: string };
  const path = `/webhooks/voice/outbound-connect?to=${encodeURIComponent(CUSTOMER)}&callId=${callId}`;
  const accepted = await (await signedPost(url, path, { Digits: "1" })).text();
  assert.match(accepted, new RegExp(`<Dial callerId="\\${BUSINESS}"[^>]*><Number[^>]*>\\${CUSTOMER}</Number></Dial>`));
  const declined = await (await signedPost(url, path, { Digits: "2" })).text();
  assert.doesNotMatch(declined, /<Dial/);
  assert.match(declined, /<Hangup/);
});

test("saved-phone callback reports customer-leg outcome rather than staff-leg completion", async (t) => {
  const { url, post, getStatus, outcomes, logged } = await startServer(t);
  const started = await post({ to: CUSTOMER });
  const { callId } = await started.json() as { callId: string };
  const connectPath = `/webhooks/voice/outbound-connect?to=${encodeURIComponent(CUSTOMER)}&callId=${callId}`;
  const connect = await signedPost(url, connectPath, { Digits: "1" });
  assert.equal(connect.status, 200);
  assert.equal(outcomes.get(callId)?.status, "customer-dialing");

  const result = await signedPost(url, `/webhooks/voice/outbound-result?callId=${callId}`, {
    CallSid: "CA-test",
    DialCallSid: "CA-customer-leg",
    DialCallStatus: "no-answer",
    DialCallDuration: "0",
  });
  assert.equal(result.status, 200);
  assert.equal(outcomes.get(callId)?.status, "no-answer");
  assert.ok(logged.some((entry) =>
    (entry as any).callSid === "CA-customer-leg" && (entry as any).status === "no-answer",
  ));
  const status = await getStatus(callId);
  assert.equal((await status.json() as { status: string }).status, "no-answer");
});

test("connect webhook rejects unsigned or retargeted requests", async (t) => {
  const { url, post } = await startServer(t);
  const started = await post({ to: CUSTOMER });
  const { callId } = await started.json() as { callId: string };
  const path = `/webhooks/voice/outbound-connect?to=${encodeURIComponent(CUSTOMER)}&callId=${callId}`;
  const unsigned = await fetch(`${url}${path}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "Digits=1",
  });
  assert.equal(unsigned.status, 403);
  const signature = twilio.getExpectedTwilioSignature(
    process.env.TWILIO_AUTH_TOKEN!, `${BASE}${path}`, { Digits: "1" },
  );
  const retargeted = await fetch(`${url}/webhooks/voice/outbound-connect?to=%2B12025550100&callId=${callId}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature }, body: "Digits=1",
  });
  assert.equal(retargeted.status, 403);
});

test("browser tokens fail closed with an actionable list when Voice setup is missing", async (t) => {
  const { postBrowser } = await startServer(t, {}, "missing");
  const response = await postBrowser({ to: CUSTOMER, contactId: 7 });
  assert.equal(response.status, 503);
  const body = await response.json() as { error: string; missing: string[]; voiceWebhookUrl: string };
  assert.match(body.error, /not configured/i);
  assert.deepEqual(body.missing, ["TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_TWIML_APP_SID"]);
  assert.equal(body.voiceWebhookUrl, `${BASE}/webhooks/voice/browser-connect`);
});

test("browser token issuance requires approved staff and editable contact assignment", async (t) => {
  const readOnly = await startServer(t, {}, "ready", { canEditContact: () => false });
  assert.equal((await readOnly.postBrowser({ to: CUSTOMER, contactId: 7 })).status, 403);
  const unapproved = await startServer(t, {}, "ready", { isApprovedStaffForUserId: async () => false });
  assert.equal((await unapproved.postBrowser({ to: CUSTOMER, contactId: 7 })).status, 403);
});

test("browser calls use a signed grant, recheck access, and record customer-leg results", async (t) => {
  const { url, postBrowser, getStatus, logged, outcomes } = await startServer(t);
  const tokenResponse = await postBrowser({ to: CUSTOMER, contactId: 7 });
  assert.equal(tokenResponse.status, 200);
  const token = await tokenResponse.json() as { token: string; callGrant: string; callId: string; identity: string };
  assert.ok(token.token.length > 100);
  assert.equal(token.identity, "staff-test-user");
  assert.match(token.callId, /^[0-9a-f-]{36}$/i);

  const connected = await signedPost(url, "/webhooks/voice/browser-connect", {
    CallGrant: token.callGrant,
    To: CUSTOMER,
    From: `client:${token.identity}`,
    CallSid: "CA-browser-parent",
  });
  assert.equal(connected.status, 200);
  const twiml = await connected.text();
  assert.match(twiml, new RegExp(`<Dial callerId="\\${BUSINESS}"[^>]*action="[^"]*browser-result`));
  assert.match(twiml, new RegExp(`<Number[^>]*statusCallback="[^"]*browser-status`));
  assert.equal(outcomes.get(token.callId)?.status, "customer-dialing");

  const result = await signedPost(url, `/webhooks/voice/browser-result?callId=${token.callId}`, {
    CallSid: "CA-browser-parent",
    DialCallSid: "CA-browser-customer",
    DialCallStatus: "completed",
    DialCallDuration: "42",
  });
  assert.equal(result.status, 200);
  assert.equal(outcomes.get(token.callId)?.status, "completed");
  assert.equal(outcomes.get(token.callId)?.durationSeconds, 42);
  assert.ok(logged.some((entry) => (entry as any).callSid === "CA-browser-customer"));
  const status = await getStatus(token.callId);
  assert.equal(status.status, 200);
  assert.equal((await status.json() as { status: string }).status, "completed");
});

test("browser call grants reject tampered and expired grants", () => {
  const secret = "test-signing-secret";
  const grant = {
    callId: "ccf61621-acc7-461c-9461-acb75b14d8f0",
    userId: "staff-test-user",
    to: CUSTOMER,
    contactId: 7,
    expiresAt: 1000,
  };
  const token = createBrowserCallGrant(grant, secret);
  assert.deepEqual(verifyBrowserCallGrant(token, secret, 999), grant);
  assert.equal(verifyBrowserCallGrant(`${token.slice(0, -1)}x`, secret, 999), null);
  assert.equal(verifyBrowserCallGrant("not-a-grant", secret, 999), null);
  assert.equal(verifyBrowserCallGrant(token, secret, 1001), null);
});
