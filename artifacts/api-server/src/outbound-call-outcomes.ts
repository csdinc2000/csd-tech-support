import { pool } from "./db";

export type OutboundCallMode = "callback" | "browser";
export type OutboundCallStatus =
  | "preparing"
  | "queued"
  | "staff-ringing"
  | "staff-connected"
  | "staff-no-answer"
  | "staff-busy"
  | "customer-dialing"
  | "customer-ringing"
  | "customer-connected"
  | "completed"
  | "no-answer"
  | "busy"
  | "failed"
  | "cancelled"
  | "not-connected";

export type OutboundCallOutcome = {
  callId: string;
  userId: string;
  contactId: number | null;
  customerNumber: string;
  mode: OutboundCallMode;
  status: OutboundCallStatus;
  parentCallSid: string | null;
  childCallSid: string | null;
  durationSeconds: number;
  createdAt: string;
  updatedAt: string;
};

export type NewOutboundCallOutcome = Pick<
  OutboundCallOutcome,
  "callId" | "userId" | "contactId" | "customerNumber" | "mode" | "status"
>;

export async function createOutboundCallOutcome(input: NewOutboundCallOutcome): Promise<void> {
  await pool.query(
    `INSERT INTO outbound_call_outcomes
      (call_id, user_id, contact_id, customer_number, mode, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.callId, input.userId, input.contactId, input.customerNumber, input.mode, input.status],
  );
}

export async function updateOutboundCallOutcome(
  callId: string,
  patch: {
    status: OutboundCallStatus;
    parentCallSid?: string | null;
    childCallSid?: string | null;
    durationSeconds?: number;
  },
): Promise<void> {
  await pool.query(
    `UPDATE outbound_call_outcomes
     SET status = $2,
         parent_call_sid = COALESCE($3, parent_call_sid),
         child_call_sid = COALESCE($4, child_call_sid),
         duration_seconds = COALESCE($5, duration_seconds),
         updated_at = NOW()
     WHERE call_id = $1`,
    [
      callId,
      patch.status,
      patch.parentCallSid ?? null,
      patch.childCallSid ?? null,
      patch.durationSeconds ?? null,
    ],
  );
}

export async function getOutboundCallOutcome(callId: string): Promise<OutboundCallOutcome | null> {
  const result = await pool.query(
    `SELECT call_id, user_id, contact_id, customer_number, mode, status,
            parent_call_sid, child_call_sid, duration_seconds, created_at, updated_at
     FROM outbound_call_outcomes WHERE call_id = $1 LIMIT 1`,
    [callId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    callId: row.call_id,
    userId: row.user_id,
    contactId: row.contact_id == null ? null : Number(row.contact_id),
    customerNumber: row.customer_number,
    mode: row.mode,
    status: row.status,
    parentCallSid: row.parent_call_sid,
    childCallSid: row.child_call_sid,
    durationSeconds: Number(row.duration_seconds ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
