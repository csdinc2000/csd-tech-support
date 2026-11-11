import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyIntakeEmailError,
  createPostgresIntakeEmailAuditStore,
  INTAKE_EMAIL_OUTCOMES,
  IntakeEmailAuditWriteError,
  STALE_INTAKE_EMAIL_SUBMISSION_MS,
  submitIntakeEmailWithAudit,
  type AuditQuery,
  type IntakeEmailAuditStore,
} from "./intake-email-audit.ts";

test("audit persistence inserts only sender, request, provider, and fixed submitting outcome", async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const query: AuditQuery = async (text, values) => {
    calls.push({ text, values });
    return { rows: [{ id: "42" }] };
  };
  const store = createPostgresIntakeEmailAuditStore(query);

  const attempt = await store.createAttempt({
    intakeId: 71,
    senderId: "auth-user-3",
    senderName: "  Alex   Staff ",
    provider: "smtp",
  });

  assert.deepEqual(attempt, { id: "42" });
  assert.match(calls[0].text, /INSERT INTO intake_email_send_attempts/);
  assert.deepEqual(calls[0].values, [
    71,
    "auth-user-3",
    "Alex Staff",
    "smtp",
    INTAKE_EMAIL_OUTCOMES.submitting,
  ]);
  assert.doesNotMatch(calls[0].text, /recipient|subject|body|raw_error/i);
  assert.doesNotMatch(JSON.stringify(calls[0].values), /customer@example|email body|subject text/i);
});

test("final state persists accepted message IDs and updates updated_at without storing provider errors", async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const query: AuditQuery = async (text, values) => {
    calls.push({ text, values });
    return { rows: [{ id: "42" }] };
  };
  const store = createPostgresIntakeEmailAuditStore(query);

  await store.finishAttempt("42", { status: "accepted", messageId: "provider-message-9" });

  assert.match(calls[0].text, /message_id = \$3/);
  assert.match(calls[0].text, /updated_at = NOW\(\)/);
  assert.deepEqual(calls[0].values, [
    "42",
    "accepted",
    "provider-message-9",
    INTAKE_EMAIL_OUTCOMES.accepted,
  ]);
  assert.doesNotMatch(calls[0].text, /error|recipient|subject|body/i);
});

test("stale submitting rows read as unknown after two minutes, preserving the exact response shape", async () => {
  const staleUpdatedAt = new Date(Date.now() - STALE_INTAKE_EMAIL_SUBMISSION_MS - 1);
  let selectedSql = "";
  const query: AuditQuery = async (text) => {
    selectedSql = text;
    return {
      rows: [{
        id: "42",
        sender_id: "auth-user-3",
        sender_name: "Alex Staff",
        status: "submitting",
        provider: "sendgrid",
        message_id: null,
        outcome: INTAKE_EMAIL_OUTCOMES.submitting,
        created_at: new Date("2026-01-01T00:00:00.000Z"),
        updated_at: staleUpdatedAt,
      }],
    };
  };
  const store = createPostgresIntakeEmailAuditStore(query);

  const attempts = await store.listAttempts(71);

  assert.match(selectedSql, /ORDER BY created_at DESC, id DESC/);
  assert.deepEqual(attempts, [{
    id: "42",
    senderId: "auth-user-3",
    senderName: "Alex Staff",
    status: "unknown",
    provider: "sendgrid",
    messageId: null,
    outcome: INTAKE_EMAIL_OUTCOMES.unknown,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: staleUpdatedAt.toISOString(),
  }]);
  assert.equal(Object.keys(attempts[0]).sort().join(","), [
    "createdAt", "id", "messageId", "outcome", "provider", "senderId",
    "senderName", "status", "updatedAt",
  ].sort().join(","));
});

test("only explicit provider responses classify as rejected; transport uncertainty stays unknown", () => {
  assert.deepEqual(
    classifyIntakeEmailError("sendgrid", { code: 401, response: { body: { errors: [{ message: "secret provider text" }] } } }),
    { status: "rejected", messageId: null },
  );
  assert.deepEqual(
    classifyIntakeEmailError("smtp", { responseCode: 550, response: "550 5.1.1 mailbox unavailable" }),
    { status: "rejected", messageId: null },
  );
  assert.deepEqual(
    classifyIntakeEmailError("smtp", { code: "ETIMEDOUT", message: "secret socket error" }),
    { status: "unknown", messageId: null },
  );
  assert.deepEqual(
    classifyIntakeEmailError("sendgrid", new Error("Unauthorized")),
    { status: "unknown", messageId: null },
  );
  assert.deepEqual(
    classifyIntakeEmailError("sendgrid", { code: 503, response: { statusCode: 503 } }),
    { status: "unknown", messageId: null },
  );
});

test("provider submission starts only after insert, then accepted/rejected/unknown states are finalized", async () => {
  const events: string[] = [];
  let finalState: { status: string; messageId: string | null } | undefined;
  const store: IntakeEmailAuditStore = {
    async createAttempt() {
      events.push("insert");
      return { id: "12" };
    },
    async finishAttempt(_id, state) {
      events.push("update");
      finalState = state;
    },
    async listAttempts() {
      return [];
    },
  };

  const accepted = await submitIntakeEmailWithAudit(
    store,
    { intakeId: 71, senderId: "staff-1", senderName: "Staff", provider: "sendgrid" },
    async () => {
      events.push("send");
      return { messageId: "sg-id" };
    },
  );
  assert.deepEqual(accepted, { submitted: true });
  assert.deepEqual(events, ["insert", "send", "update"]);
  assert.deepEqual(finalState, { status: "accepted", messageId: "sg-id" });

  finalState = undefined;
  const rejected = await submitIntakeEmailWithAudit(
    store,
    { intakeId: 71, senderId: "staff-1", senderName: "Staff", provider: "sendgrid" },
    async () => { throw { code: 403, response: { body: { errors: [{ message: "private rejection details" }] } } }; },
  );
  assert.deepEqual(rejected, { submitted: false, status: "rejected" });
  assert.deepEqual(finalState, { status: "rejected", messageId: null });
  assert.equal(INTAKE_EMAIL_OUTCOMES.rejected.includes("private rejection details"), false);

  finalState = undefined;
  const uncertain = await submitIntakeEmailWithAudit(
    store,
    { intakeId: 71, senderId: "staff-1", senderName: "Staff", provider: "smtp" },
    async () => { throw Object.assign(new Error("private timeout text"), { code: "ETIMEDOUT" }); },
  );
  assert.deepEqual(uncertain, { submitted: false, status: "unknown" });
  assert.deepEqual(finalState, { status: "unknown", messageId: null });
  assert.equal(INTAKE_EMAIL_OUTCOMES.unknown.includes("private timeout text"), false);
});

test("audit insert failure prevents provider call and failed final audit update cannot report success", async () => {
  let providerCalls = 0;
  const insertFailure: IntakeEmailAuditStore = {
    async createAttempt() { throw new Error("database down"); },
    async finishAttempt() {},
    async listAttempts() { return []; },
  };
  await assert.rejects(
    submitIntakeEmailWithAudit(
      insertFailure,
      { intakeId: 71, senderId: "staff-1", senderName: "Staff", provider: "sendgrid" },
      async () => {
        providerCalls++;
        return { messageId: "should-not-send" };
      },
    ),
    (error: unknown) => error instanceof IntakeEmailAuditWriteError && error.stage === "create",
  );
  assert.equal(providerCalls, 0);

  const updateFailure: IntakeEmailAuditStore = {
    async createAttempt() { return { id: "12" }; },
    async finishAttempt() { throw new Error("sensitive provider message must not escape"); },
    async listAttempts() { return []; },
  };
  await assert.rejects(
    submitIntakeEmailWithAudit(
      updateFailure,
      { intakeId: 71, senderId: "staff-1", senderName: "Staff", provider: "sendgrid" },
      async () => ({ messageId: "provider-accepted-id" }),
    ),
    (error: unknown) =>
      error instanceof IntakeEmailAuditWriteError &&
      error.stage === "finalize" &&
      !error.message.includes("sensitive"),
  );
});