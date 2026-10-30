import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import path from "path";

// Storage import pulls in ./db which throws unless DATABASE_URL is set. We
// don't actually talk to a database here — the test seam swaps `deps.storage`
// for an in-memory fake — but the URL must exist at module-load time. Set it
// before importing so the import chain doesn't blow up.
process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";
// Force the email path to be exercised: sendOwnerEmail short-circuits without
// an owner address or without a SendGrid API key. Both are stubbed by the
// test seam so the values themselves never reach the network.
process.env.A2P_ALERT_EMAIL = "owner@example.com";
process.env.SENDGRID_API_KEY = "SG.test-key";

const STATE_FILE = path.join(process.cwd(), ".local", "a2p-monitor-state.json");

type A2PStatusResult = import("../a2p-status").A2PStatusResult;
type Alert = import("@shared/schema").Alert;

const mod = await import("../a2p-monitor");
const {
  runA2PMonitorOnce,
  __setA2PMonitorDepsForTests,
  snoozeA2PAlerts,
  getA2PSnoozeStatus,
} = mod;

let nextAlertId = 1;
let alerts: Alert[] = [];
let sentEmails: Array<{ subject: string; text: string }> = [];
let currentStatus: A2PStatusResult;

function makeAlert(input: Partial<Alert> & { title: string }): Alert {
  return {
    id: nextAlertId++,
    title: input.title,
    description: input.description ?? null,
    severity: input.severity ?? "high",
    category: input.category ?? "messaging",
    deviceId: input.deviceId ?? null,
    clientId: input.clientId ?? null,
    status: input.status ?? "active",
    isEmergency: input.isEmergency ?? false,
    emergencyNotificationSent: input.emergencyNotificationSent ?? false,
    acknowledgedBy: input.acknowledgedBy ?? null,
    acknowledgedAt: input.acknowledgedAt ?? null,
    alertSource: input.alertSource ?? "a2p-monitor",
    affectedServices: input.affectedServices ?? null,
    estimatedDowntime: input.estimatedDowntime ?? null,
    businessImpact: input.businessImpact ?? "high",
    createdAt: input.createdAt ?? new Date(),
    resolvedAt: input.resolvedAt ?? null,
  } as Alert;
}

const fakeStorage = {
  async getActiveAlerts() {
    return alerts.filter((a) => a.status === "active");
  },
  async createAlert(input: Partial<Alert> & { title: string }) {
    const a = makeAlert(input);
    alerts.push(a);
    return a;
  },
  async updateAlert(id: number, update: Partial<Alert>) {
    const idx = alerts.findIndex((a) => a.id === id);
    if (idx === -1) return undefined;
    alerts[idx] = { ...alerts[idx], ...update } as Alert;
    return alerts[idx];
  },
};

const storageStub = fakeStorage as unknown as typeof import("../storage").storage;

const sgMailStub = {
  setApiKey(_k: string) {},
  async send(msg: { subject?: string; text?: string }) {
    sentEmails.push({
      subject: String(msg.subject ?? ""),
      text: String(msg.text ?? ""),
    });
    return [{ statusCode: 202 }, {}];
  },
} as unknown as typeof import("@sendgrid/mail").default;

function statusResult(overrides: Partial<A2PStatusResult>): A2PStatusResult {
  return {
    configured: true,
    status: "approved",
    brands: [],
    campaigns: [],
    bundleRejections: [],
    error: null,
    ...overrides,
  } as A2PStatusResult;
}

before(() => {
  __setA2PMonitorDepsForTests({
    getA2PStatus: async () => currentStatus,
    storage: storageStub,
    sgMail: sgMailStub,
  });
});

after(() => {
  __setA2PMonitorDepsForTests(null);
});

beforeEach(async () => {
  alerts = [];
  sentEmails = [];
  nextAlertId = 1;
  await fs.rm(STATE_FILE, { force: true });
});

test("rejected -> approved transition resolves open a2p-monitor alerts and emails recovery", async () => {
  // Cycle 1: Twilio reports rejection. Monitor opens an alert.
  currentStatus = statusResult({
    status: "rejected",
    brands: [{ sid: "BN1", status: "FAILED", failureReason: "Bad EIN" }],
  });
  await runA2PMonitorOnce();

  const openAfterRejection = alerts.filter(
    (a) => a.status === "active" && a.alertSource === "a2p-monitor",
  );
  assert.equal(openAfterRejection.length, 1, "rejection cycle should open one alert");
  assert.equal(sentEmails.length, 1, "rejection cycle should send one alert email");
  sentEmails = [];

  // Cycle 2: Twilio reports approved. Monitor should resolve the open alert
  // and send a recovery email.
  currentStatus = statusResult({ status: "approved" });
  await runA2PMonitorOnce();

  const stillOpen = alerts.filter(
    (a) => a.status === "active" && a.alertSource === "a2p-monitor",
  );
  assert.equal(stillOpen.length, 0, "approved cycle should auto-resolve the open alert");

  const resolved = alerts.filter((a) => a.status === "resolved");
  assert.equal(resolved.length, 1, "the previously-open alert should be marked resolved");
  assert.ok(resolved[0].resolvedAt instanceof Date, "resolvedAt should be set");

  assert.equal(sentEmails.length, 1, "recovery should send exactly one email");
  assert.match(sentEmails[0].subject, /healthy again/i);
  assert.match(sentEmails[0].text, /auto-resolved/i);
});

test("flapping rejected -> approved -> rejected does not create duplicate active alerts", async () => {
  currentStatus = statusResult({ status: "rejected" });
  await runA2PMonitorOnce();
  assert.equal(
    alerts.filter((a) => a.status === "active").length,
    1,
    "first rejection opens one alert",
  );

  currentStatus = statusResult({ status: "approved" });
  await runA2PMonitorOnce();
  assert.equal(
    alerts.filter((a) => a.status === "active").length,
    0,
    "approved cycle clears the active alert",
  );

  currentStatus = statusResult({ status: "rejected" });
  await runA2PMonitorOnce();
  const activeAfterReflap = alerts.filter((a) => a.status === "active");
  assert.equal(
    activeAfterReflap.length,
    1,
    "second rejection should open exactly one new alert (no duplicates)",
  );
  // Total ever created should be 2 (original + reflap), never more.
  assert.equal(alerts.length, 2, "should never accumulate duplicate a2p-monitor alerts");
});

test("a persistent rejection does not re-page within the 24-hour cooldown", async () => {
  currentStatus = statusResult({ status: "rejected" });

  await runA2PMonitorOnce();
  assert.equal(alerts.length, 1, "the first rejected cycle should create one alert");
  assert.equal(sentEmails.length, 1, "the first rejected cycle should send one email");

  await runA2PMonitorOnce();

  assert.equal(
    alerts.length,
    1,
    "a second rejected cycle within the cooldown should not create another alert",
  );
  assert.equal(
    sentEmails.length,
    1,
    "a second rejected cycle within the cooldown should not send another email",
  );
});

test("a persistent rejection re-pages after the 24-hour cooldown elapses", async () => {
  const olderThanCooldown = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(
    STATE_FILE,
    JSON.stringify({
      lastStatus: "rejected",
      lastAlertAt: olderThanCooldown,
      lastAlertKind: "rejected",
    }),
    "utf8",
  );

  currentStatus = statusResult({ status: "rejected" });
  await runA2PMonitorOnce();

  assert.equal(alerts.length, 1, "a rejected cycle after the cooldown should create a new alert");
  assert.equal(sentEmails.length, 1, "a rejected cycle after the cooldown should send a new email");
});

test("approved cycle with no open alerts is a no-op (no recovery email)", async () => {
  // Pre-seed an unrelated non-a2p alert so we can also verify scoping.
  alerts.push(
    makeAlert({
      title: "unrelated",
      alertSource: "monitoring",
      status: "active",
    }),
  );

  currentStatus = statusResult({ status: "approved" });
  await runA2PMonitorOnce();

  assert.equal(sentEmails.length, 0, "should not send a recovery email when nothing was open");
  // Unrelated alert must remain untouched.
  const unrelated = alerts.find((a) => a.title === "unrelated")!;
  assert.equal(unrelated.status, "active");
  assert.equal(unrelated.resolvedAt, null);
});

test("not_registered leaves an open a2p-monitor alert active and sends no recovery email", async () => {
  currentStatus = statusResult({ status: "rejected" });
  await runA2PMonitorOnce();

  const openAlert = alerts.find(
    (a) => a.status === "active" && a.alertSource === "a2p-monitor",
  );
  assert.ok(openAlert, "rejection cycle should open an A2P alert");
  sentEmails = [];

  currentStatus = statusResult({ status: "not_registered" });
  await runA2PMonitorOnce();

  assert.equal(
    alerts.find((a) => a.id === openAlert.id)?.status,
    "active",
    "not_registered must not auto-resolve the open alert",
  );
  assert.equal(
    alerts.find((a) => a.id === openAlert.id)?.resolvedAt,
    null,
    "not_registered must not stamp the alert as resolved",
  );
  assert.equal(sentEmails.length, 0, "not_registered must not send a recovery email");
});

test("pending during a flap leaves the alert open and preserves the owner snooze", async () => {
  currentStatus = statusResult({ status: "rejected" });
  await runA2PMonitorOnce();

  const openAlert = alerts.find(
    (a) => a.status === "active" && a.alertSource === "a2p-monitor",
  );
  assert.ok(openAlert, "rejection cycle should open an A2P alert");

  const snoozed = await snoozeA2PAlerts(2, "owner@example.com");
  assert.equal(snoozed.active, true, "owner snooze should be active before the flap");
  sentEmails = [];

  currentStatus = statusResult({ status: "pending" });
  await runA2PMonitorOnce();

  assert.equal(
    alerts.find((a) => a.id === openAlert.id)?.status,
    "active",
    "pending must not auto-resolve the open alert during a flap",
  );
  assert.equal(sentEmails.length, 0, "pending must not send a recovery email");

  const snoozeAfterPending = await getA2PSnoozeStatus();
  assert.equal(snoozeAfterPending.active, true, "pending must not clear the owner snooze");
  assert.equal(
    snoozeAfterPending.snoozeUntil,
    snoozed.snoozeUntil,
    "pending must preserve the existing snooze deadline",
  );
  assert.equal(
    snoozeAfterPending.snoozeStartedBy,
    "owner@example.com",
    "pending must preserve who started the snooze",
  );
});

test("snooze suppresses new alerts but a healthy approved cycle still auto-resolves and clears the snooze", async () => {
  // An incident already opened an A2P alert before the owner snoozed paging.
  const openAlert = makeAlert({
    title: "A2P 10DLC registration was rejected",
    alertSource: "a2p-monitor",
    status: "active",
  });
  alerts.push(openAlert);

  // Seed monitor state so the prior incident is reflected (lastAlertKind set,
  // so the later approved cycle recognizes a degraded->healthy recovery), but
  // leave lastAlertAt null so the 24h cooldown is NOT what suppresses below —
  // the snooze must be the deciding factor.
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(
    STATE_FILE,
    JSON.stringify({ lastStatus: "rejected", lastAlertKind: "rejected" }),
    "utf8",
  );

  const snoozed = await snoozeA2PAlerts(2, "owner@example.com");
  assert.equal(snoozed.active, true, "snooze should be active after snoozeA2PAlerts");

  // Cycle 1: Twilio still reports rejected while snoozed. No NEW alert row and
  // no email — the snooze suppresses paging even though the cooldown is clear.
  currentStatus = statusResult({ status: "rejected" });
  await runA2PMonitorOnce();

  const activeA2pDuringSnooze = alerts.filter(
    (a) => a.status === "active" && a.alertSource === "a2p-monitor",
  );
  assert.equal(
    activeA2pDuringSnooze.length,
    1,
    "snooze should suppress creating a new alert (only the pre-existing one remains)",
  );
  assert.equal(alerts.length, 1, "no duplicate alert row should be created while snoozed");
  assert.equal(sentEmails.length, 0, "snooze should suppress the alert email");
  assert.equal(
    (await getA2PSnoozeStatus()).active,
    true,
    "snooze should remain active across a suppressed cycle",
  );

  // Cycle 2: Twilio reports approved. Even though paging was snoozed, a real
  // recovery must still auto-resolve the open alert and lift the snooze.
  currentStatus = statusResult({ status: "approved" });
  await runA2PMonitorOnce();

  const stillOpen = alerts.filter(
    (a) => a.status === "active" && a.alertSource === "a2p-monitor",
  );
  assert.equal(stillOpen.length, 0, "approved cycle should auto-resolve the open alert despite snooze");
  assert.equal(
    alerts.find((a) => a.id === openAlert.id)!.status,
    "resolved",
    "the pre-existing alert should be marked resolved",
  );
  assert.equal(sentEmails.length, 1, "recovery should still send exactly one email");
  assert.match(sentEmails[0].subject, /healthy again/i);
  assert.equal(
    (await getA2PSnoozeStatus()).active,
    false,
    "a healthy recovery should clear the owner snooze",
  );
});

test("a single failed lookup does not fire; two consecutive failed lookups fire a lookup_failed alert", async () => {
  // Cycle 1: a transient Twilio API error surfaces as status "failed" + error.
  // One blip should NOT page — the monitor requires the 2-strike threshold.
  currentStatus = statusResult({ status: "failed", error: "Twilio API 503" });
  await runA2PMonitorOnce();

  assert.equal(
    alerts.filter((a) => a.status === "active").length,
    0,
    "a single failed lookup should not fire an alert",
  );
  assert.equal(sentEmails.length, 0, "no email should be sent on the first failed lookup");

  // Cycle 2: the failure persists. The second consecutive failure crosses the
  // threshold and fires exactly one lookup_failed alert + email.
  currentStatus = statusResult({ status: "failed", error: "Twilio API 503" });
  await runA2PMonitorOnce();

  const active = alerts.filter(
    (a) => a.status === "active" && a.alertSource === "a2p-monitor",
  );
  assert.equal(active.length, 1, "two consecutive failed lookups should fire exactly one alert");
  assert.equal(alerts.length, 1, "should not create more than one lookup_failed alert");
  assert.equal(sentEmails.length, 1, "two consecutive failed lookups should send one email");
  assert.match(active[0].title, /failing/i, "the alert should be the lookup_failed kind");
  assert.match(sentEmails[0].subject, /failing/i);
});
