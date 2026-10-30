import { pool } from "./db";

export type IntakeEmailProvider = "smtp" | "sendgrid";
export type IntakeEmailAttemptStatus = "submitting" | "accepted" | "rejected" | "unknown";

export const INTAKE_EMAIL_OUTCOMES: Record<IntakeEmailAttemptStatus, string> = {
  submitting: "Submission is in progress.",
  accepted: "Provider accepted the email submission.",
  rejected: "Provider explicitly rejected the email submission.",
  unknown: "Submission outcome is uncertain; confirm delivery before retrying.",
};

// A provider call still pending after this window is assumed stale when read.
// Its persisted row is left untouched so a late provider result can still
// replace "submitting" with the final state.
export const STALE_INTAKE_EMAIL_SUBMISSION_MS = 2 * 60 * 1000;

export type IntakeEmailAttempt = {
  id: string;
  senderId: string;
  senderName: string;
  status: IntakeEmailAttemptStatus;
  provider: IntakeEmailProvider;
  messageId: string | null;
  outcome: string;
  createdAt: string;
  updatedAt: string;
};

type SqlRow = Record<string, unknown>;
type SqlResult = { rows: SqlRow[] };
export type AuditQuery = (text: string, values?: unknown[]) => Promise<SqlResult>;

export type IntakeEmailAttemptInput = {
  intakeId: number;
  senderId: string;
  senderName: string;
  provider: IntakeEmailProvider;
};

export interface IntakeEmailAuditStore {
  createAttempt(input: IntakeEmailAttemptInput): Promise<{ id: string }>;
  finishAttempt(
    id: string,
    state: { status: Exclude<IntakeEmailAttemptStatus, "submitting">; messageId: string | null },
  ): Promise<void>;
  listAttempts(intakeId: number): Promise<IntakeEmailAttempt[]>;
}

async function databaseQuery(text: string, values?: unknown[]): Promise<SqlResult> {
  const result = await pool.query(text, values as any[]);
  return { rows: result.rows as SqlRow[] };
}

export async function ensureIntakeEmailAuditSchema(): Promise<void> {
  await databaseQuery(`
    CREATE TABLE IF NOT EXISTS intake_email_send_attempts (
      id BIGSERIAL PRIMARY KEY,
      intake_id INTEGER NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('smtp', 'sendgrid')),
      message_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('submitting', 'accepted', 'rejected', 'unknown')),
      outcome TEXT NOT NULL CHECK (
        outcome IN (
          'Submission is in progress.',
          'Provider accepted the email submission.',
          'Provider explicitly rejected the email submission.',
          -- Keep the value unchanged without a literal semicolon: Publish's
          -- schema diff can truncate CHECK expressions at quoted semicolons.
          'Submission outcome is uncertain' || chr(59) || ' confirm delivery before retrying.'
        )
      ),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS intake_email_send_attempts_history_idx
      ON intake_email_send_attempts (intake_id, created_at DESC, id DESC);
  `);
}

export function createPostgresIntakeEmailAuditStore(
  query: AuditQuery = databaseQuery,
): IntakeEmailAuditStore {
  return {
    async createAttempt(input) {
      const senderName =
        input.senderName.replace(/\s+/g, " ").trim().slice(0, 120) || "Staff member";
      const result = await query(
        `INSERT INTO intake_email_send_attempts
           (intake_id, sender_id, sender_name, provider, status, outcome)
         VALUES ($1, $2, $3, $4, 'submitting', $5)
         RETURNING id`,
        [
          input.intakeId,
          input.senderId,
          senderName,
          input.provider,
          INTAKE_EMAIL_OUTCOMES.submitting,
        ],
      );
      const row = result.rows[0];
      if (!row?.id) throw new Error("Intake email audit attempt was not created");
      return { id: String(row.id) };
    },

    async finishAttempt(id, state) {
      const result = await query(
        `UPDATE intake_email_send_attempts
         SET status = $2, message_id = $3, outcome = $4, updated_at = NOW()
         WHERE id = $1
         RETURNING id`,
        [id, state.status, state.messageId, INTAKE_EMAIL_OUTCOMES[state.status]],
      );
      if (result.rows.length !== 1) throw new Error("Intake email audit attempt was not updated");
    },

    async listAttempts(intakeId) {
      const result = await query(
        `SELECT id, sender_id, sender_name, status, provider, message_id, outcome, created_at, updated_at
         FROM intake_email_send_attempts
         WHERE intake_id = $1
         ORDER BY created_at DESC, id DESC`,
        [intakeId],
      );
      return result.rows.map((row) => mapAttempt(row));
    },
  };
}

function isoTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("Intake email audit timestamp was invalid");
  return date.toISOString();
}

function mapAttempt(row: SqlRow, now = Date.now()): IntakeEmailAttempt {
  const createdAt = isoTimestamp(row.created_at);
  const updatedAt = isoTimestamp(row.updated_at);
  const status = row.status as IntakeEmailAttemptStatus;
  const staleSubmitting =
    status === "submitting" && now - new Date(updatedAt).getTime() >= STALE_INTAKE_EMAIL_SUBMISSION_MS;
  const visibleStatus: IntakeEmailAttemptStatus = staleSubmitting ? "unknown" : status;
  return {
    id: String(row.id),
    senderId: String(row.sender_id),
    senderName: String(row.sender_name),
    status: visibleStatus,
    provider: row.provider as IntakeEmailProvider,
    messageId: typeof row.message_id === "string" ? row.message_id : null,
    outcome: INTAKE_EMAIL_OUTCOMES[visibleStatus],
    createdAt,
    updatedAt,
  };
}

export function classifyIntakeEmailError(
  provider: IntakeEmailProvider,
  error: unknown,
): { status: "rejected" | "unknown"; messageId: null } {
  const detail = error as {
    code?: unknown;
    responseCode?: unknown;
    response?: { statusCode?: unknown; status?: unknown } | string;
  } | null;

  // HTTP server errors can occur after the provider has queued the message.
  // Only a client-error response proves SendGrid refused the submission.
  const isHttpRejection = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 499;
  const isSmtpRejection = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599;
  const response = detail?.response;
  const rejected =
    provider === "sendgrid"
      ? isHttpRejection(detail?.code) ||
        (typeof response === "object" &&
          response !== null &&
          (isHttpRejection(response.statusCode) || isHttpRejection(response.status)))
      : isSmtpRejection(detail?.responseCode) ||
        (typeof response === "string" && /^[45]\d\d(?:\s|$)/.test(response.trim()));

  return { status: rejected ? "rejected" : "unknown", messageId: null };
}

export class IntakeEmailAuditWriteError extends Error {
  constructor(readonly stage: "create" | "finalize") {
    super("Intake email audit could not be written");
    this.name = "IntakeEmailAuditWriteError";
  }
}

export async function submitIntakeEmailWithAudit(
  store: IntakeEmailAuditStore,
  input: IntakeEmailAttemptInput,
  send: () => Promise<{ messageId: string | null }>,
): Promise<{ submitted: true } | { submitted: false; status: "rejected" | "unknown" }> {
  let attempt: { id: string };
  try {
    attempt = await store.createAttempt(input);
  } catch {
    throw new IntakeEmailAuditWriteError("create");
  }

  let result: { messageId: string | null };
  try {
    result = await send();
  } catch (error) {
    const state = classifyIntakeEmailError(input.provider, error);
    try {
      await store.finishAttempt(attempt.id, state);
    } catch {
      throw new IntakeEmailAuditWriteError("finalize");
    }
    return { submitted: false, status: state.status };
  }

  try {
    await store.finishAttempt(attempt.id, { status: "accepted", messageId: result.messageId });
  } catch {
    // The provider may have accepted the message, but without a successful audit
    // update the API must not claim success. The original submitting row will be
    // exposed as unknown after the stale window.
    throw new IntakeEmailAuditWriteError("finalize");
  }
  return { submitted: true };
}

const intakeEmailAuditStore = createPostgresIntakeEmailAuditStore();

export function listIntakeEmailAttempts(intakeId: number): Promise<IntakeEmailAttempt[]> {
  return intakeEmailAuditStore.listAttempts(intakeId);
}

export function sendIntakeEmailWithAudit(
  input: IntakeEmailAttemptInput,
  send: () => Promise<{ messageId: string | null }>,
) {
  return submitIntakeEmailWithAudit(intakeEmailAuditStore, input, send);
}