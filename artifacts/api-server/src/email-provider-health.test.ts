import assert from "node:assert/strict";
import test from "node:test";
import {
  __setEmailProviderHealthStorageForTests,
  __setEmailCreditFetcherForTests,
  __setEmailCapacityWarningSettingsFetcherForTests,
  checkEmailProviderCapacityOnce,
  EMAIL_CAPACITY_ALERT_SOURCE,
  getEmailCapacityMonitoringStatus,
  isEmailProviderCapacityError,
  recordEmailProviderCapacityFailure,
  resolveEmailProviderCapacityAlert,
} from "./email-provider-health";

test("recognizes SendGrid capacity errors from the nested provider response", () => {
  const error = Object.assign(new Error("Unauthorized"), {
    response: { body: { errors: [{ message: "Maximum credits exceeded" }] } },
  });
  assert.equal(isEmailProviderCapacityError(error), true);
});

test("creates a privacy-safe warning from a reliable low credit balance", async (t) => {
  const alerts: any[] = [];
  const previousKey = process.env.SENDGRID_API_KEY;
  process.env.SENDGRID_API_KEY = "test-key";
  __setEmailProviderHealthStorageForTests({
    async getActiveAlerts() {
      return alerts.filter((alert) => alert.status === "active");
    },
    async createAlert(input) {
      const alert = { ...input, id: 1, resolvedAt: null };
      alerts.push(alert);
      return alert as any;
    },
    async updateAlert(id, update) {
      Object.assign(alerts.find((entry) => entry.id === id), update);
      return alerts[0];
    },
  });
  __setEmailCreditFetcherForTests(async () =>
    new Response(JSON.stringify({ remain: 75, total: 1_000 }), { status: 200 })
  );
  __setEmailCapacityWarningSettingsFetcherForTests(async () => ({ mode: "default", value: null }));
  t.after(() => {
    __setEmailProviderHealthStorageForTests(null);
    __setEmailCreditFetcherForTests(null);
    __setEmailCapacityWarningSettingsFetcherForTests(null);
    if (previousKey === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = previousKey;
  });

  assert.equal(await checkEmailProviderCapacityOnce(), "low");
  assert.deepEqual(getEmailCapacityMonitoringStatus().balance, {
    remaining: 75,
    total: 1_000,
    percentage: 8,
    checkedAt: getEmailCapacityMonitoringStatus().checkedAt,
    stale: false,
  });
  assert.equal(alerts[0].title, "Email provider capacity is running low");
  assert.equal(alerts[0].severity, "warning");
  assert.doesNotMatch(alerts[0].description, /test-key|recipient|subject|message body/i);
});

test("uses a custom percentage only for proactive low-capacity warnings", async (t) => {
  const alerts: any[] = [];
  const previousKey = process.env.SENDGRID_API_KEY;
  process.env.SENDGRID_API_KEY = "test-key";
  __setEmailProviderHealthStorageForTests({
    async getActiveAlerts() { return alerts; },
    async createAlert(input) { alerts.push({ ...input, id: 1 }); return alerts[0]; },
    async updateAlert() { return alerts[0]; },
  });
  __setEmailCreditFetcherForTests(async () =>
    new Response(JSON.stringify({ remain: 150, total: 1_000 }), { status: 200 })
  );
  __setEmailCapacityWarningSettingsFetcherForTests(async () => ({ mode: "percentage", value: 20 }));
  t.after(() => {
    __setEmailProviderHealthStorageForTests(null);
    __setEmailCreditFetcherForTests(null);
    __setEmailCapacityWarningSettingsFetcherForTests(null);
    if (previousKey === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = previousKey;
  });

  assert.equal(await checkEmailProviderCapacityOnce(), "low");
  assert.equal(alerts[0].severity, "warning");
});

test("custom remaining-credit settings replace rather than combine with safe defaults", async (t) => {
  const previousKey = process.env.SENDGRID_API_KEY;
  process.env.SENDGRID_API_KEY = "test-key";
  __setEmailProviderHealthStorageForTests({
    async getActiveAlerts() { return []; },
    async createAlert() { throw new Error("not expected"); },
    async updateAlert() { throw new Error("not expected"); },
  });
  __setEmailCreditFetcherForTests(async () =>
    new Response(JSON.stringify({ remain: 75, total: 1_000 }), { status: 200 })
  );
  __setEmailCapacityWarningSettingsFetcherForTests(async () => ({ mode: "remainingCredits", value: 50 }));
  t.after(() => {
    __setEmailProviderHealthStorageForTests(null);
    __setEmailCreditFetcherForTests(null);
    __setEmailCapacityWarningSettingsFetcherForTests(null);
    if (previousKey === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = previousKey;
  });

  assert.equal(await checkEmailProviderCapacityOnce(), "healthy");
});

test("does not alert when SendGrid cannot provide a reliable credit reading", async (t) => {
  let writes = 0;
  let denyAccess = false;
  const previousKey = process.env.SENDGRID_API_KEY;
  process.env.SENDGRID_API_KEY = "test-key";
  __setEmailProviderHealthStorageForTests({
    async getActiveAlerts() {
      return [];
    },
    async createAlert() {
      writes++;
      throw new Error("not expected");
    },
    async updateAlert() {
      writes++;
      throw new Error("not expected");
    },
  });
  __setEmailCreditFetcherForTests(async () => denyAccess
    ? new Response(JSON.stringify({ message: "forbidden" }), { status: 403 })
    : new Response(JSON.stringify({ remain: 500, total: 1_000 }), { status: 200 })
  );
  t.after(() => {
    __setEmailProviderHealthStorageForTests(null);
    __setEmailCreditFetcherForTests(null);
    if (previousKey === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = previousKey;
  });

  assert.equal(await checkEmailProviderCapacityOnce(), "healthy");
  denyAccess = true;
  assert.equal(await checkEmailProviderCapacityOnce(), "unavailable");
  assert.equal(writes, 0);
  assert.deepEqual(
    {
      available: getEmailCapacityMonitoringStatus().available,
      state: getEmailCapacityMonitoringStatus().state,
      reason: getEmailCapacityMonitoringStatus().reason,
    },
    { available: false, state: "unavailable", reason: "permission_denied" },
  );
  assert.ok(getEmailCapacityMonitoringStatus().checkedAt);
  assert.deepEqual(getEmailCapacityMonitoringStatus().balance, {
    remaining: 500,
    total: 1_000,
    percentage: 50,
    checkedAt: getEmailCapacityMonitoringStatus().balance?.checkedAt,
    stale: true,
  });
});

test("a successful send does not clear a low-capacity warning", async (t) => {
  const alert: any = {
    id: 1,
    title: "Email provider capacity is running low",
    status: "active",
    alertSource: EMAIL_CAPACITY_ALERT_SOURCE,
  };
  __setEmailProviderHealthStorageForTests({
    async getActiveAlerts() {
      return [alert];
    },
    async createAlert() {
      throw new Error("not expected");
    },
    async updateAlert(_id, update) {
      Object.assign(alert, update);
      return alert;
    },
  });
  t.after(() => __setEmailProviderHealthStorageForTests(null));

  await resolveEmailProviderCapacityAlert();
  assert.equal(alert.status, "active");
});

test("does not classify ordinary delivery errors as account capacity failures", () => {
  const badRecipient = Object.assign(new Error("Bad Request"), {
    response: { body: { errors: [{ message: "The to address is invalid" }] } },
  });
  assert.equal(isEmailProviderCapacityError(badRecipient), false);
  assert.equal(isEmailProviderCapacityError(new Error("Network unavailable")), false);
});

test("deduplicates capacity failures and records only operational categories", async (t) => {
  const alerts: any[] = [];
  __setEmailProviderHealthStorageForTests({
    async getActiveAlerts() {
      return alerts.filter((alert) => alert.status === "active");
    },
    async createAlert(input) {
      const alert = { ...input, id: alerts.length + 1, createdAt: new Date(), resolvedAt: null };
      alerts.push(alert);
      return alert as any;
    },
    async updateAlert(id, update) {
      const alert = alerts.find((entry) => entry.id === id);
      Object.assign(alert, update);
      return alert;
    },
  });
  t.after(() => __setEmailProviderHealthStorageForTests(null));

  await recordEmailProviderCapacityFailure("invoice");
  await recordEmailProviderCapacityFailure("helpdesk");

  assert.equal(alerts.length, 1);
  assert.deepEqual(JSON.parse(alerts[0].affectedServices), ["helpdesk", "invoice"]);
  assert.doesNotMatch(alerts[0].description, /recipient|subject|body|api.?key/i);
});

test("a successful provider send resolves the active capacity incident", async (t) => {
  const alert: any = {
    id: 1,
    status: "active",
    alertSource: EMAIL_CAPACITY_ALERT_SOURCE,
  };
  __setEmailProviderHealthStorageForTests({
    async getActiveAlerts() {
      return alert.status === "active" ? [alert] : [];
    },
    async createAlert() {
      throw new Error("not expected");
    },
    async updateAlert(_id, update) {
      Object.assign(alert, update);
      return alert;
    },
  });
  t.after(() => __setEmailProviderHealthStorageForTests(null));

  await resolveEmailProviderCapacityAlert();

  assert.equal(alert.status, "resolved");
  assert.ok(alert.resolvedAt instanceof Date);
});