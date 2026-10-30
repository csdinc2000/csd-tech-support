import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import twilio from "twilio";
import { registerOutboundCallRoutes, type OutboundCallRouteOptions } from "./routes/outbound-call-routes";
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

async function startServer(t: TestContext, overrides: Partial<OutboundCallRouteOptions> = {}) {
  const created: Parameters<OutboundCallRouteOptions["createCall"]>[0][] = [];
  const logged: unknown[] = [];
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
    ...overrides,
  });
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}`;
  const post = (body: unknown) => fetch(`${url}/api/twilio/calls/outbound`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { url, post, created, logged };
}

test("rings the default staff phone and logs the call against the customer", async (t) => {
  const { post, created, logged } = await startServer(t);
  const res = await post({ to: "305-555-0123" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, sid: "CA-test", to: CUSTOMER, agentPhone: STAFF, contactId: 7 });
  assert.equal(created.length, 1);
  assert.equal(created[0].to, STAFF);
  assert.equal(created[0].from, BUSINESS);
  assert.equal(created[0].statusCallback, `${BASE}/webhooks/voice/status`);
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
  assert.equal(hidden.created.length + readOnly.created.length + unapproved.created.length, 0);
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
  const { url } = await startServer(t);
  const path = `/webhooks/voice/outbound-connect?to=${encodeURIComponent(CUSTOMER)}`;
  const accepted = await (await signedPost(url, path, { Digits: "1" })).text();
  assert.match(accepted, new RegExp(`<Dial callerId="\\${BUSINESS}"[^>]*><Number>\\${CUSTOMER}</Number></Dial>`));
  const declined = await (await signedPost(url, path, { Digits: "2" })).text();
  assert.doesNotMatch(declined, /<Dial/);
  assert.match(declined, /<Hangup/);
});

test("connect webhook rejects unsigned or retargeted requests", async (t) => {
  const { url } = await startServer(t);
  const unsigned = await fetch(`${url}/webhooks/voice/outbound-connect?to=${encodeURIComponent(CUSTOMER)}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "Digits=1",
  });
  assert.equal(unsigned.status, 403);
  const signature = twilio.getExpectedTwilioSignature(
    process.env.TWILIO_AUTH_TOKEN!, `${BASE}/webhooks/voice/outbound-connect?to=${encodeURIComponent(CUSTOMER)}`, { Digits: "1" },
  );
  const retargeted = await fetch(`${url}/webhooks/voice/outbound-connect?to=%2B12025550100`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature }, body: "Digits=1",
  });
  assert.equal(retargeted.status, 403);
});
