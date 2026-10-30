import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { pool } from "./db";
import {
  ensureIntakeEmailAuditSchema,
  INTAKE_EMAIL_OUTCOMES,
  listIntakeEmailAttempts,
  sendIntakeEmailWithAudit,
} from "./intake-email-audit";

const marker = `intake-email-audit-${process.pid}-${Date.now()}`;
const intakeId = 2_000_000_000 + (process.pid % 100_000);

before(async () => {
  await ensureIntakeEmailAuditSchema();
});

after(async () => {
  await pool.query("DELETE FROM intake_email_send_attempts WHERE sender_id = $1", [marker]);
});

test("outcome constraint remains complete in Publish SQL without changing permitted messages", async () => {
  const { rows } = await pool.query(
    `SELECT pg_get_constraintdef(oid, true) AS definition
     FROM pg_constraint
     WHERE conrelid = 'public.intake_email_send_attempts'::regclass
       AND conname = 'intake_email_send_attempts_outcome_check'`,
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0].definition, /chr\(59\)/);
  assert.equal(rows[0].definition.includes(";"), false);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `CREATE TEMP TABLE intake_email_outcome_constraint_test
       (LIKE public.intake_email_send_attempts INCLUDING CONSTRAINTS)`,
    );
    for (const [status, outcome] of Object.entries(INTAKE_EMAIL_OUTCOMES)) {
      await client.query(
        `INSERT INTO intake_email_outcome_constraint_test
         (id, intake_id, sender_id, sender_name, provider, status, outcome, created_at, updated_at)
         VALUES (1, 1, 'constraint-test', 'Constraint test', 'sendgrid', $1, $2, NOW(), NOW())`,
        [status, outcome],
      );
    }
    await client.query("SAVEPOINT reject_unsafe_outcome");
    await assert.rejects(
      client.query(
        `INSERT INTO intake_email_outcome_constraint_test
         (id, intake_id, sender_id, sender_name, provider, status, outcome, created_at, updated_at)
         VALUES (1, 1, 'constraint-test', 'Constraint test', 'sendgrid', 'unknown', $1, NOW(), NOW())`,
        ["Unapproved provider error details"],
      ),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );
    await client.query("ROLLBACK TO SAVEPOINT reject_unsafe_outcome");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("PostgreSQL retains safe send attempts, provider acceptance, and stale submitting history", async () => {
  let statusBeforeProviderCall: string | undefined;
  const sent = await sendIntakeEmailWithAudit(
    {
      intakeId,
      senderId: marker,
      senderName: `${marker} Staff`,
      provider: "sendgrid",
    },
    async () => {
      statusBeforeProviderCall = (await pool.query(
        "SELECT status FROM intake_email_send_attempts WHERE sender_id = $1 ORDER BY id DESC LIMIT 1",
        [marker],
      )).rows[0]?.status;
      return { messageId: `${marker}-provider-message` };
    },
  );
  assert.deepEqual(sent, { submitted: true });
  assert.equal(statusBeforeProviderCall, "submitting");

  const row = (await pool.query(
    `SELECT id, intake_id, sender_id, sender_name, provider, message_id, status, outcome,
            created_at, updated_at
     FROM intake_email_send_attempts
     WHERE sender_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [marker],
  )).rows[0];
  assert.equal(String(row.intake_id), String(intakeId));
  assert.equal(row.provider, "sendgrid");
  assert.equal(row.message_id, `${marker}-provider-message`);
  assert.equal(row.status, "accepted");
  assert.equal(row.outcome, INTAKE_EMAIL_OUTCOMES.accepted);
  assert.ok(row.created_at);
  assert.ok(row.updated_at);

  const columns = (await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'intake_email_send_attempts'`,
  )).rows.map((column) => column.column_name).sort();
  assert.deepEqual(columns, [
    "created_at", "id", "intake_id", "message_id", "outcome", "provider",
    "sender_id", "sender_name", "status", "updated_at",
  ]);

  await pool.query(
    `UPDATE intake_email_send_attempts
     SET status = 'submitting', message_id = NULL, outcome = $2,
         updated_at = NOW() - INTERVAL '3 minutes'
     WHERE id = $1`,
    [row.id, INTAKE_EMAIL_OUTCOMES.submitting],
  );
  const staleUpdatedAt = (await pool.query(
    "SELECT updated_at FROM intake_email_send_attempts WHERE id = $1",
    [row.id],
  )).rows[0].updated_at;
  const [attempt] = await listIntakeEmailAttempts(intakeId);
  assert.deepEqual(attempt, {
    id: String(row.id),
    senderId: marker,
    senderName: `${marker} Staff`,
    status: "unknown",
    provider: "sendgrid",
    messageId: null,
    outcome: INTAKE_EMAIL_OUTCOMES.unknown,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(staleUpdatedAt).toISOString(),
  });
  assert.ok(Date.parse(attempt.updatedAt) <= Date.now() - 2 * 60 * 1000);

  await pool.query(
    `UPDATE intake_email_send_attempts
     SET updated_at = NOW()
     WHERE id = $1`,
    [row.id],
  );
  const [activeAttempt] = await listIntakeEmailAttempts(intakeId);
  assert.equal(activeAttempt.status, "submitting");
  assert.equal(activeAttempt.outcome, INTAKE_EMAIL_OUTCOMES.submitting);
});