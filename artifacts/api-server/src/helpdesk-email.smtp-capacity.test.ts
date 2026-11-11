import assert from "node:assert/strict";
import test from "node:test";
import { sendEmail } from "./helpdesk-email";
import { __setSmtpTransportForTests } from "./mail-transport";
import {
  __setEmailProviderHealthStorageForTests,
  EMAIL_CAPACITY_ALERT_SOURCE,
  isEmailProviderCapacityError,
} from "./email-provider-health";

// The SMTP path must raise and clear the shared capacity alert exactly like
// the SendGrid path does — marketplace / invoice / helpdesk email all flow
// through sendEmail, so a quota rejection here would otherwise be log-only.

function fakeAlertStore() {
  const alerts: any[] = [];
  let nextId = 1;
  __setEmailProviderHealthStorageForTests({
    async getActiveAlerts() { return alerts.filter((a) => a.status === "active"); },
    async createAlert(input) { const alert = { id: nextId++, resolvedAt: null, ...input }; alerts.push(alert); return alert as any; },
    async updateAlert(id, patch) { const alert = alerts.find((a) => a.id === id); Object.assign(alert, patch); return alert as any; },
  });
  return alerts;
}

function withSmtpEnv(t: { after: (fn: () => void) => void }) {
  const saved = { ...process.env };
  process.env.CSD_MAIL_HOST = "smtp.example.test";
  process.env.CSD_MAIL_USER = "relay@example.test";
  process.env.CSD_MAIL_PASSWORD = "secret";
  delete process.env.SENDGRID_API_KEY;
  t.after(() => {
    for (const key of ["CSD_MAIL_HOST", "CSD_MAIL_USER", "CSD_MAIL_PASSWORD", "SENDGRID_API_KEY"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    __setSmtpTransportForTests(null);
    __setEmailProviderHealthStorageForTests(null);
  });
}

test("recognizes SMTP quota and throttle replies", () => {
  const smtp = (response: string, responseCode: number) => Object.assign(new Error(`Message failed: ${response}`), { response, responseCode });
  assert.equal(isEmailProviderCapacityError(smtp("550 5.4.5 Daily user sending quota exceeded", 550)), true);
  assert.equal(isEmailProviderCapacityError(smtp("421 4.7.0 Too many messages, try again later", 421)), true);
  assert.equal(isEmailProviderCapacityError(smtp("452 4.7.1 Rate limit exceeded for this account", 452)), true);
  assert.equal(isEmailProviderCapacityError(smtp("550 5.1.1 The email account that you tried to reach does not exist", 550)), false);
  assert.equal(isEmailProviderCapacityError(new Error("ECONNREFUSED")), false);
});

test("SMTP sends selected communication recipients as BCC", async (t) => {
  withSmtpEnv(t);
  fakeAlertStore();
  let delivered: any;
  __setSmtpTransportForTests({
    async sendMail(message) {
      delivered = message;
      return { messageId: "<accepted@example.test>" } as any;
    },
  });

  await sendEmail(
    "support@computersystemsdepot.com",
    "Schedule update",
    "The meeting starts at 2 PM.",
    {
      from: "support@computersystemsdepot.com",
      replyTo: "support@computersystemsdepot.com",
      bcc: ["staff@example.test", "customer@example.test"],
      operation: "communications",
    },
  );
  assert.equal(delivered.to, "support@computersystemsdepot.com");
  assert.deepEqual(delivered.bcc, ["staff@example.test", "customer@example.test"]);
});

test("an SMTP quota rejection raises the capacity alert tagged with the operation, and a later success clears it", async (t) => {
  withSmtpEnv(t);
  const alerts = fakeAlertStore();

  let quotaExhausted = true;
  __setSmtpTransportForTests({
    async sendMail() {
      if (quotaExhausted) {
        throw Object.assign(new Error("Message failed: 550 5.4.5 Daily user sending quota exceeded"), {
          response: "550 5.4.5 Daily user sending quota exceeded",
          responseCode: 550,
        });
      }
      return { messageId: "<ok@example.test>" } as any;
    },
  });

  await assert.rejects(
    sendEmail("seller@example.test", "Your listing", "body", { operation: "marketplace" }),
    /quota exceeded/,
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].alertSource, EMAIL_CAPACITY_ALERT_SOURCE);
  assert.equal(alerts[0].status, "active");
  assert.equal(alerts[0].severity, "critical");
  assert.deepEqual(JSON.parse(alerts[0].affectedServices), ["marketplace"]);
  assert.match(alerts[0].description, /SMTP/);
  assert.doesNotMatch(alerts[0].description, /SendGrid|seller@example|Your listing|secret/);

  quotaExhausted = false;
  const result = await sendEmail("seller@example.test", "Your listing", "body", { operation: "marketplace" });
  assert.equal(result.messageId, "<ok@example.test>");
  assert.equal(alerts[0].status, "resolved");
  assert.ok(alerts[0].resolvedAt instanceof Date);
});

test("a non-capacity SMTP failure is rethrown without raising an alert", async (t) => {
  withSmtpEnv(t);
  const alerts = fakeAlertStore();
  __setSmtpTransportForTests({ async sendMail() { throw new Error("ECONNREFUSED 10.0.0.1:465"); } });
  await assert.rejects(sendEmail("x@example.test", "s", "b", { operation: "marketplace" }), /ECONNREFUSED/);
  assert.equal(alerts.length, 0);
});

test("SMTP mail carries a real From header and envelope sender", async (t) => {
  withSmtpEnv(t);
  fakeAlertStore();
  const nodemailer = (await import("nodemailer")).default;
  const renderer = nodemailer.createTransport({ streamTransport: true, buffer: true });
  let rendered: { message: Buffer; envelope: { from: string | false } } | undefined;
  __setSmtpTransportForTests({
    async sendMail(message) {
      rendered = (await renderer.sendMail(message)) as any;
      return { messageId: "<rendered@example.test>" } as any;
    },
  });

  await sendEmail("customer@example.test", "Your repair", "Ready for pickup.", {
    from: "support@computersystemsdepot.com",
    fromName: "Computer Systems Depot",
    operation: "helpdesk",
  });

  const fromHeader = rendered!.message.toString().split(/\r?\n/).find((line) => /^From:/i.test(line));
  assert.equal(fromHeader, "From: Computer Systems Depot <support@computersystemsdepot.com>");
  assert.equal(rendered!.envelope.from, "support@computersystemsdepot.com");
});
