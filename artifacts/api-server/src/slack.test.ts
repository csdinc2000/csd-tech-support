import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  __setSlackProxyForTests,
  queueDeviceAlert,
  queueIncomingCallNotification,
  queueLeadNotification,
  queueTicketNotification,
  sendDeviceAlert,
  sendIncomingCallNotification,
  sendSlackMessage,
  sendLeadNotification,
  sendTicketNotification,
} from "./slack";
import {
  __setSlackNotificationOutboxStoreForTests,
  processSlackNotificationOutbox,
} from "./slack-outbox";
import { EmergencyAlertService } from "./emergency-alerts";
import {
  __setSlackDeliveryHealthStoreForTests,
  __setSlackQueueHealthStoreForTests,
  getSlackDeliveryHealth,
  type SlackDeliveryHealth,
} from "./slack-delivery-health";

const originalChannel = process.env.SLACK_CHANNEL_ID;
const emptyQueueHealth = {
  state: "not_checked" as const, lastAttemptAt: null, lastSuccessAt: null, activeFailure: null,
};

beforeEach(() => {
  __setSlackQueueHealthStoreForTests({
    async record() {},
    async get() { return emptyQueueHealth; },
  });
});

afterEach(() => {
  __setSlackProxyForTests();
  if (originalChannel === undefined) {
    delete process.env.SLACK_CHANNEL_ID;
  } else {
    process.env.SLACK_CHANNEL_ID = originalChannel;
  }
  __setSlackDeliveryHealthStoreForTests(null);
  __setSlackQueueHealthStoreForTests(null);
  __setSlackNotificationOutboxStoreForTests(null);
});

test("Slack failures create a sanitized warning and success resolves it", async () => {
  process.env.SLACK_CHANNEL_ID = "C_TEST";
  const outcomes: Array<{ delivered: boolean; reason?: string; at: string }> = [];
  __setSlackDeliveryHealthStoreForTests({
    async record(result) {
      outcomes.unshift({
        delivered: result.delivered,
        reason: result.delivered ? undefined : result.reason,
        at: new Date().toISOString(),
      });
    },
    async get(): Promise<SlackDeliveryHealth> {
      const latest = outcomes[0];
      if (!latest) return { state: "not_checked", lastAttemptAt: null, lastSuccessAt: null, activeFailure: null, queue: emptyQueueHealth };
      if (latest.delivered) return { state: "healthy", lastAttemptAt: latest.at, lastSuccessAt: latest.at, activeFailure: null, queue: emptyQueueHealth };
      return {
        state: "failing",
        lastAttemptAt: latest.at,
        lastSuccessAt: null,
        activeFailure: { category: latest.reason as any, startedAt: latest.at, lastFailedAt: latest.at },
        queue: emptyQueueHealth,
      };
    },
  });
  __setSlackProxyForTests(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, error: "channel_not_found" }),
  }));

  await sendLeadNotification({ name: "Sensitive lead", contact: "private@example.test" });
  assert.equal((await getSlackDeliveryHealth()).activeFailure?.category, "slack_error");
  assert.doesNotMatch(JSON.stringify(outcomes), /Sensitive|private@example|channel_not_found/);

  __setSlackProxyForTests(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, ts: "123" }),
  }));
  await sendLeadNotification({ name: "Another lead", contact: "another@example.test" });
  assert.deepEqual(await getSlackDeliveryHealth(), {
    state: "healthy",
    lastAttemptAt: outcomes[0].at,
    lastSuccessAt: outcomes[0].at,
    activeFailure: null,
    queue: emptyQueueHealth,
  });
});

test("CRM notifications remain successful when Slack has an HTTP failure", async () => {
  process.env.SLACK_CHANNEL_ID = "C_TEST";
  let attempts = 0;
  __setSlackProxyForTests(async () => {
    attempts += 1;
    return {
      ok: false,
      status: 503,
      json: async () => ({ ok: false, error: "service_unavailable" }),
    };
  });

  await assert.doesNotReject(async () => {
    await sendTicketNotification(
      { id: 42, priority: "high", subject: "Saved ticket", status: "open", description: "private details" },
      { name: "Customer" },
    );
    await sendLeadNotification({ name: "Lead", contact: "contact", issue: "private details" });
  });
  assert.equal(attempts, 2);
});

test("CRM notifications remain successful when Slack responds with ok false", async () => {
  process.env.SLACK_CHANNEL_ID = "C_TEST";
  let attempts = 0;
  __setSlackProxyForTests(async () => {
    attempts += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: "channel_not_found" }),
    };
  });

  await assert.doesNotReject(async () => {
    await sendDeviceAlert(
      { severity: "critical", title: "Saved device alert", description: "private details" },
      { name: "Device", type: "server", status: "offline" },
    );
    await sendIncomingCallNotification({ from: "caller", to: "business", missed: true });
  });
  assert.equal(attempts, 2);
});

test("Slack transport exceptions do not expose notification content in logs", async () => {
  process.env.SLACK_CHANNEL_ID = "C_TEST";
  const logged: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  __setSlackProxyForTests(async () => {
    throw new Error("connector included private details");
  });

  try {
    await sendLeadNotification({
      name: "Sensitive name",
      contact: "sensitive@example.test",
      issue: "sensitive message content",
    });
  } finally {
    console.error = originalError;
  }

  const output = JSON.stringify(logged);
  assert.match(output, /transport_error/);
  assert.doesNotMatch(output, /Sensitive name|sensitive@example|sensitive message|private details/);
});

test("authoritative CRM saves can respond while Slack delivery is still pending", async () => {
  process.env.SLACK_CHANNEL_ID = "C_TEST";
  const queued: any[] = [];
  __setSlackNotificationOutboxStoreForTests({
    async enqueue(notification: any) {
      queued.push(notification);
    },
    async claim() {
      return [];
    },
    async delivered() {},
    async failed() {},
    async listFailures() { return []; },
    async retry() { return null; },
  });

  const cases = [
    {
      name: "ticket",
      notify: () => queueTicketNotification(
        { id: 101, priority: "high", subject: "Saved ticket", status: "open" },
        { name: "Customer" },
      ),
    },
    {
      name: "intake lead",
      notify: () => queueLeadNotification({ name: "Lead", contact: "contact", issue: "Saved intake" }, "intake-101"),
    },
    {
      name: "incoming call",
      notify: () => queueIncomingCallNotification({ from: "caller", to: "business", missed: true, eventId: "call-101" }),
    },
    {
      name: "device alert",
      notify: () => queueDeviceAlert(
        { id: 101, severity: "critical", title: "Saved device alert" },
        { name: "Device", type: "server", status: "offline" },
      ),
    },
  ];

  for (const item of cases) {
    const authoritativeRecords: string[] = [];
    const responses: number[] = [];

    authoritativeRecords.push(item.name);
    await item.notify();
    responses.push(201);

    assert.deepEqual(authoritativeRecords, [item.name]);
    assert.deepEqual(responses, [201]);
  }
  assert.equal(queued.length, cases.length);
});

for (const failure of [
  {
    name: "HTTP failure",
    response: {
      ok: false,
      status: 503,
      json: async () => ({ ok: false, error: "private-http-error" }),
    },
    expected: "Slack delivery failed (http_error)",
  },
  {
    name: "API rejection",
    response: {
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: "channel_not_found" }),
    },
    expected: "Slack delivery failed (slack_error)",
  },
]) {
  test(`emergency alerts retain a sanitized failed Slack attempt after ${failure.name}`, async () => {
    process.env.SLACK_CHANNEL_ID = "C_TEST";
    __setSlackProxyForTests(async () => failure.response);
    __setSlackDeliveryHealthStoreForTests({
      async record() {},
      async get() {
        return { state: "not_checked", lastAttemptAt: null, lastSuccessAt: null, activeFailure: null };
      },
    });
    const attempts: Array<{
      alertId: number;
      contactId: number | null;
      method: string;
      status: string;
      errorMessage?: string;
    }> = [];
    const outboxRows: any[] = [];
    __setSlackNotificationOutboxStoreForTests({
      async enqueue(notification: any) {
        outboxRows.push({
          id: 1,
          notification_type: notification.type,
          payload: notification.payload,
          emergency_alert_id: notification.emergencyAlertId,
          attempt_count: 0,
        });
      },
      async claim() {
        const row = outboxRows.shift();
        if (!row) return [];
        row.attempt_count += 1;
        return [row];
      },
      async delivered() {},
      async failed(row: any, result: any) {
        attempts.push({
          alertId: row.emergency_alert_id,
          contactId: null,
          method: "slack",
          status: "failed",
          errorMessage: `Slack delivery failed (${result.reason})`,
        });
      },
      async listFailures() { return []; },
      async retry() { return null; },
    });
    const service = new EmergencyAlertService();

    await (service as any).sendSlackEmergencyNotification({
      id: 501,
      title: "Sensitive emergency title",
      description: "Sensitive emergency description",
      severity: "critical",
      category: "security",
      isEmergency: true,
      businessImpact: "high",
    }, { name: "Sensitive customer" });
    await processSlackNotificationOutbox((payload) => sendSlackMessage(payload));

    assert.deepEqual(attempts, [{
      alertId: 501,
      contactId: null,
      method: "slack",
      status: "failed",
      errorMessage: failure.expected,
    }]);
    assert.doesNotMatch(
      JSON.stringify(attempts),
      /Sensitive emergency|Sensitive customer|private-http-error/,
    );
  });
}
