import type { Express, Request, RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { z } from "zod/v4";
import { pool } from "./db";
import { isAdminUser } from "./security";
import { sendSms, toE164 } from "./twilio";
import { storage } from "./storage";
import { db } from "./db";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { processSmsForwardDeliveries } from "./sms-forward-outbox";
import { canonicalPublicAppBaseUrl } from "./shared/roip-config";
import { toValidE164 } from "./phone-validation";
import {
  normalizeDispatchPhone,
  parseStaffSmsCommand,
} from "./staff-dispatch-command";

export { parseStaffSmsCommand } from "./staff-dispatch-command";

export interface StaffDispatchRecipient {
  id: number;
  name: string;
  displayName: string;
  role: "staff" | "technician";
  phone: string;
  enabled: boolean;
  onDuty: boolean;
  receiveCalls: boolean;
  receiveMessages: boolean;
  canUseCommands: boolean;
  linkedUserId: number | null;
  staffAccessApproved?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const recipientInput = z.object({
  displayName: z.string().trim().min(1).max(120),
  role: z.enum(["staff", "technician"]).default("staff"),
  phone: z.string().trim().regex(/^\+[1-9]\d{7,14}$/, "Phone must be E.164"),
  enabled: z.boolean().default(true),
  onDuty: z.boolean().default(true),
  receiveCalls: z.boolean().default(false),
  receiveMessages: z.boolean().default(true),
  canUseCommands: z.boolean().default(true),
  linkedUserId: z.number().int().positive().nullable().default(null),
});
const parseRecipientInput = (body: any) =>
  recipientInput.safeParse({
    ...body,
    displayName: body?.displayName ?? body?.name,
    phone: typeof body?.phone === "string" ? normalizeDispatchPhone(body.phone) : body?.phone,
  });
const recipientPatch = recipientInput.partial();
const parseRecipientPatch = (body: any) => {
  const patch = { ...body };
  if (body?.displayName !== undefined || body?.name !== undefined) {
    patch.displayName = body.displayName ?? body.name;
  } else {
    delete patch.displayName;
  }
  if (typeof body?.phone === "string") {
    patch.phone = normalizeDispatchPhone(body.phone);
  } else if (body?.phone === undefined) {
    delete patch.phone;
  }
  return recipientPatch.safeParse(patch);
};

let initialization: Promise<void> | null = null;

/** Runtime DDL is intentional: db:push is unavailable in this deployment. */
export function ensureStaffDispatchTables(): Promise<void> {
  if (!initialization) {
    initialization = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS staff_dispatch_recipients (
          id SERIAL PRIMARY KEY,
          display_name TEXT NOT NULL,
          recipient_role TEXT NOT NULL DEFAULT 'staff',
          phone TEXT NOT NULL UNIQUE,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          on_duty BOOLEAN NOT NULL DEFAULT TRUE,
          receive_calls BOOLEAN NOT NULL DEFAULT FALSE,
          receive_messages BOOLEAN NOT NULL DEFAULT TRUE,
          can_use_commands BOOLEAN NOT NULL DEFAULT TRUE,
          linked_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
        ALTER TABLE staff_dispatch_recipients
          ADD COLUMN IF NOT EXISTS linked_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
        ALTER TABLE staff_dispatch_recipients
          ADD COLUMN IF NOT EXISTS recipient_role TEXT NOT NULL DEFAULT 'staff';
        CREATE TABLE IF NOT EXISTS staff_dispatch_sms_consent (
          phone TEXT PRIMARY KEY,
          consented BOOLEAN NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS staff_dispatch_correlations (
          id SERIAL PRIMARY KEY,
          ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
          recipient_id INTEGER REFERENCES staff_dispatch_recipients(id) ON DELETE SET NULL,
          recipient_phone TEXT NOT NULL,
          dispatched_at TIMESTAMP NOT NULL DEFAULT NOW(),
          claimed_at TIMESTAMP,
          UNIQUE(ticket_id, recipient_phone)
        );
        CREATE TABLE IF NOT EXISTS staff_dispatch_audit (
          id SERIAL PRIMARY KEY,
          actor_type TEXT NOT NULL,
          actor_identity TEXT NOT NULL,
          action TEXT NOT NULL,
          outcome TEXT NOT NULL,
          recipient_id INTEGER,
          ticket_id INTEGER,
          before_summary JSONB,
          after_summary JSONB,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS staff_dispatch_client_messages (
          id BIGSERIAL PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          inbound_message_sid TEXT,
          ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
          recipient_id INTEGER REFERENCES staff_dispatch_recipients(id) ON DELETE SET NULL,
          recipient_phone TEXT NOT NULL,
          requester_phone TEXT NOT NULL,
          body TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'delivered', 'failed')),
          provider_message_sid TEXT,
          error TEXT,
          history_saved BOOLEAN NOT NULL DEFAULT FALSE,
          ticket_message_id INTEGER REFERENCES ticket_messages(id) ON DELETE SET NULL,
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
        ALTER TABLE staff_dispatch_client_messages
          ADD COLUMN IF NOT EXISTS ticket_message_id INTEGER REFERENCES ticket_messages(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS staff_dispatch_audit_created_idx
          ON staff_dispatch_audit(created_at DESC);
        CREATE INDEX IF NOT EXISTS staff_dispatch_correlation_recent_idx
          ON staff_dispatch_correlations(recipient_phone, dispatched_at DESC);
        CREATE INDEX IF NOT EXISTS staff_dispatch_client_messages_ticket_idx
          ON staff_dispatch_client_messages(ticket_id, created_at DESC);
      `);
    })().catch((error) => {
      initialization = null;
      throw error;
    });
  }
  return initialization;
}

function recipientFromRow(row: any): StaffDispatchRecipient {
  return {
    id: row.id,
    name: row.display_name,
    displayName: row.display_name,
    role: row.staff_role
      ? row.staff_role === "field_technician" ? "technician" : "staff"
      : row.recipient_role === "technician" ? "technician" : "staff",
    phone: row.phone,
    enabled: row.enabled,
    onDuty: row.on_duty,
    receiveCalls: row.receive_calls,
    receiveMessages: row.receive_messages,
    canUseCommands: row.can_use_commands,
    linkedUserId: row.linked_user_id,
    staffAccessApproved: row.staff_access_approved === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function recipientSummary(r: StaffDispatchRecipient | null) {
  if (!r) return null;
  return {
    displayName: r.displayName,
    role: r.role,
    phone: r.phone,
    enabled: r.enabled,
    onDuty: r.onDuty,
    receiveCalls: r.receiveCalls,
    receiveMessages: r.receiveMessages,
    canUseCommands: r.canUseCommands,
    linkedUserId: r.linkedUserId,
  };
}

function actorIdentity(req: Request): string {
  const auth = getAuth(req);
  return String(auth.sessionClaims?.email || req.dbUser?.id || "authenticated-owner");
}

async function audit(
  queryable: { query: (sql: string, params?: any[]) => Promise<any> },
  entry: {
    actorType: string;
    actorIdentity: string;
    action: string;
    outcome: "accepted" | "rejected";
    recipientId?: number | null;
    ticketId?: number | null;
    before?: unknown;
    after?: unknown;
  },
) {
  await queryable.query(
    `INSERT INTO staff_dispatch_audit
      (actor_type, actor_identity, action, outcome, recipient_id, ticket_id, before_summary, after_summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
    [
      entry.actorType,
      entry.actorIdentity,
      entry.action,
      entry.outcome,
      entry.recipientId ?? null,
      entry.ticketId ?? null,
      entry.before == null ? null : JSON.stringify(entry.before),
      entry.after == null ? null : JSON.stringify(entry.after),
    ],
  );
}

const requireOwner: RequestHandler = (req, res, next) => {
  if (!isAdminUser(req)) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  next();
};

export function registerStaffDispatchRoutes(app: Express): void {
  app.use("/api/staff-dispatch", requireOwner);

  app.get("/api/staff-dispatch/settings", async (_req, res) => {
    try {
      await ensureStaffDispatchTables();
      const result = await pool.query(
        `SELECT r.*, ${APPROVED_RECIPIENT} AS staff_access_approved,
           (SELECT p.role FROM staff_helpdesk_links hl
            JOIN staff_access_profiles p ON p.user_id = hl.auth_user_id
            WHERE hl.helpdesk_user_id = r.linked_user_id) AS staff_role
         FROM staff_dispatch_recipients r ORDER BY r.display_name, r.id`,
      );
      const recipients = result.rows.map(recipientFromRow);
      res.json({
        recipients,
        routing: {
          activeCallRecipients: recipients.filter((r) => r.staffAccessApproved && r.enabled && r.onDuty && r.receiveCalls).map((r) => r.id),
          activeMessageRecipients: recipients.filter((r) => r.staffAccessApproved && r.enabled && r.onDuty && r.receiveMessages).map((r) => r.id),
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Failed to list recipients" });
    }
  });

  // Ticket assignments refer to legacy users.id. Report whether each one
  // matches an approved platform staff account; never infer access from this ID.
  app.get("/api/staff-dispatch/eligible-assignees", async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT h.id, h.username AS name, h.email, h.role,
                p.role AS "staffRole", p.approval_status AS "approvalStatus"
         FROM users h
         LEFT JOIN staff_helpdesk_links hl ON hl.helpdesk_user_id = h.id
         LEFT JOIN auth_users a ON a.id = hl.auth_user_id
         LEFT JOIN staff_access_profiles p ON p.user_id = a.id
         ORDER BY h.username, h.id`,
      );
      res.json(result.rows);
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Failed to list ticket assignees" });
    }
  });

  app.post("/api/staff-dispatch/settings", async (req, res) => {
    const parsed = parseRecipientInput(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid recipient", details: parsed.error.flatten() });
      return;
    }
    try {
      await ensureStaffDispatchTables();
      if (parsed.data.linkedUserId == null) {
        res.status(400).json({ error: "Approve the staff account and link its helpdesk assignee before adding a dispatch recipient" });
        return;
      }
      if (parsed.data.linkedUserId != null) {
        const user = await pool.query(
          `SELECT p.role FROM users h
           JOIN staff_helpdesk_links hl ON hl.helpdesk_user_id = h.id
           JOIN auth_users a ON a.id = hl.auth_user_id
           JOIN staff_access_profiles p ON p.user_id = a.id AND p.approval_status = 'approved'
           WHERE h.id=$1`,
          [parsed.data.linkedUserId],
        );
        if (user.rows.length !== 1) {
          res.status(400).json({ error: "Link a unique approved Staff Access account before assigning tickets" });
          return;
        }
        parsed.data.role = user.rows[0].role === "field_technician" ? "technician" : "staff";
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const d = parsed.data;
        const result = await client.query(
          `INSERT INTO staff_dispatch_recipients
            (display_name,recipient_role,phone,enabled,on_duty,receive_calls,receive_messages,can_use_commands,linked_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [d.displayName, d.role, d.phone, d.enabled, d.onDuty, d.receiveCalls, d.receiveMessages, d.canUseCommands, d.linkedUserId],
        );
        const created = recipientFromRow(result.rows[0]);
        await audit(client, {
          actorType: "owner", actorIdentity: actorIdentity(req), action: "recipient.created",
          outcome: "accepted", recipientId: created.id, after: recipientSummary(created),
        });
        await client.query("COMMIT");
        res.status(201).json(created);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      res.status(error?.code === "23505" ? 409 : 500).json({ error: error?.code === "23505" ? "Phone already exists" : "Failed to create recipient" });
    }
  });

  app.patch("/api/staff-dispatch/settings/:id", async (req, res) => {
    const id = Number(req.params.id);
    const parsed = parseRecipientPatch(req.body);
    if (!Number.isInteger(id) || !parsed.success) {
      res.status(400).json({ error: "Invalid recipient" });
      return;
    }
    try {
      await ensureStaffDispatchTables();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const beforeResult = await client.query("SELECT * FROM staff_dispatch_recipients WHERE id=$1 FOR UPDATE", [id]);
        if (!beforeResult.rows[0]) {
          await client.query("ROLLBACK");
          res.status(404).json({ error: "Recipient not found" });
          return;
        }
        const before = recipientFromRow(beforeResult.rows[0]);
        const merged = recipientInput.parse({
          ...recipientSummary(before),
          ...parsed.data,
        });
        const d = merged;
        if (!d.linkedUserId && d.enabled && d.onDuty && (d.receiveCalls || d.receiveMessages || d.canUseCommands)) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: "A linked approved helpdesk assignee is required for active dispatch" });
          return;
        }
        if (d.linkedUserId != null) {
          const user = await client.query(
            `SELECT p.role FROM users h
             JOIN staff_helpdesk_links hl ON hl.helpdesk_user_id = h.id
             JOIN auth_users a ON a.id = hl.auth_user_id
             JOIN staff_access_profiles p ON p.user_id = a.id AND p.approval_status = 'approved'
             WHERE h.id=$1`,
            [d.linkedUserId],
          );
          if (user.rows.length === 1) {
            d.role = user.rows[0].role === "field_technician" ? "technician" : "staff";
          } else if (d.linkedUserId !== before.linkedUserId) {
            await client.query("ROLLBACK");
            res.status(400).json({ error: "Link an approved Staff Access account before assigning tickets" });
            return;
          }
        }
        const result = await client.query(
          `UPDATE staff_dispatch_recipients SET
             display_name=$2,recipient_role=$3,phone=$4,enabled=$5,on_duty=$6,receive_calls=$7,
             receive_messages=$8,can_use_commands=$9,linked_user_id=$10,updated_at=NOW()
           WHERE id=$1 RETURNING *`,
          [id, d.displayName, d.role, d.phone, d.enabled, d.onDuty, d.receiveCalls, d.receiveMessages, d.canUseCommands, d.linkedUserId],
        );
        const updated = recipientFromRow(result.rows[0]);
        await audit(client, {
          actorType: "owner", actorIdentity: actorIdentity(req), action: "recipient.updated",
          outcome: "accepted", recipientId: id, before: recipientSummary(before), after: recipientSummary(updated),
        });
        await client.query("COMMIT");
        res.json(updated);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      res.status(error?.code === "23505" ? 409 : 500).json({ error: error?.code === "23505" ? "Phone already exists" : "Failed to update recipient" });
    }
  });

  app.delete("/api/staff-dispatch/settings/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid recipient id" });
      return;
    }
    try {
      await ensureStaffDispatchTables();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query("DELETE FROM staff_dispatch_recipients WHERE id=$1 RETURNING *", [id]);
        if (!result.rows[0]) {
          await client.query("ROLLBACK");
          res.status(404).json({ error: "Recipient not found" });
          return;
        }
        const before = recipientFromRow(result.rows[0]);
        await audit(client, {
          actorType: "owner", actorIdentity: actorIdentity(req), action: "recipient.deleted",
          outcome: "accepted", recipientId: id, before: recipientSummary(before),
        });
        await client.query("COMMIT");
        res.status(204).send();
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch {
      res.status(500).json({ error: "Failed to delete recipient" });
    }
  });

  app.get("/api/staff-dispatch/audit", async (req, res) => {
    try {
      await ensureStaffDispatchTables();
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const result = await pool.query(
        `SELECT id,actor_type AS "actorType",actor_identity AS "actorIdentity",
          action,outcome,recipient_id AS "recipientId",ticket_id AS "ticketId",
          before_summary AS "beforeSummary",after_summary AS "afterSummary",created_at AS "createdAt"
         FROM staff_dispatch_audit ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      res.json(result.rows);
    } catch {
      res.status(500).json({ error: "Failed to list dispatch audit" });
    }
  });

  app.get("/api/staff-dispatch/client-messages", async (req, res) => {
    try {
      await ensureStaffDispatchTables();
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const result = await pool.query(
        `SELECT id,ticket_id AS "ticketId",recipient_id AS "recipientId",
          recipient_phone AS "recipientPhone",requester_phone AS "requesterPhone",
          body,status,provider_message_sid AS "providerMessageSid",error,
          history_saved AS "historySaved",created_at AS "createdAt",updated_at AS "updatedAt"
         FROM staff_dispatch_client_messages ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      res.json(result.rows);
    } catch {
      res.status(500).json({ error: "Failed to list client messages" });
    }
  });
}

// SMS and call routing are available only to a uniquely matched approved
// Staff Access account. A legacy helpdesk row alone is not authorization.
export const APPROVED_RECIPIENT = `EXISTS (
  SELECT 1 FROM staff_helpdesk_links hl
  JOIN auth_users a ON a.id = hl.auth_user_id
  JOIN staff_access_profiles p ON p.user_id = a.id AND p.approval_status = 'approved'
  WHERE hl.helpdesk_user_id = r.linked_user_id
)`;

export type StaffEventKind = "intake" | "call" | "missed-call" | "ticket" | "appointment";
type StaffEventExecutor = { execute: (statement: SQL) => Promise<any> };

/** Allows the existing raw-SQL intake transaction to share the same outbox. */
export function staffEventExecutor(client: Pick<typeof pool, "query">): StaffEventExecutor {
  const dialect = new PgDialect();
  return { execute: async statement => {
    const query = dialect.sqlToQuery(statement);
    return client.query(query.sql, query.params);
  } };
}

/**
 * Queue one SMS per event/approved phone. Off-duty techs receive notices, but
 * disabled accounts and explicit receive_messages opt-outs remain excluded.
 * The primary record and these rows can commit in the same transaction.
 */
export async function enqueueStaffEventNotification(
  event: { kind: StaffEventKind; id: string | number; businessNumber?: string; ticketId?: number },
  executor: StaffEventExecutor = db,
  includeOnDutyStaff = false,
): Promise<void> {
  if (!String(event.id).trim()) throw new Error("Staff notification needs an event ID");
  if (executor === db) await ensureStaffDispatchTables();
  const result = await executor.execute(sql`
    SELECT r.id, r.phone FROM staff_dispatch_recipients r
    WHERE r.enabled=TRUE AND r.receive_messages=TRUE AND ${sql.raw(APPROVED_RECIPIENT)}
      AND NOT EXISTS (
        SELECT 1 FROM staff_dispatch_sms_consent c WHERE c.phone=r.phone AND c.consented=FALSE
      )
      AND (
        r.recipient_role='technician' OR EXISTS (
          SELECT 1 FROM staff_helpdesk_links hl JOIN staff_access_profiles p ON p.user_id=hl.auth_user_id
          WHERE hl.helpdesk_user_id=r.linked_user_id AND p.role='field_technician' AND p.approval_status='approved'
        ) OR (${includeOnDutyStaff} AND r.on_duty=TRUE)
      )
    ORDER BY r.id
  `);
  const recipients = result.rows.filter((row: any) => !!toValidE164(row.phone || ""));
  if (!recipients.length) return;
  let businessNumber = toValidE164(event.businessNumber || "");
  if (!businessNumber) {
    const settings = await executor.execute(sql`SELECT twilio_phone_number FROM twilio_settings WHERE id=1`);
    businessNumber = toValidE164(settings.rows[0]?.twilio_phone_number || "");
  }
  if (!businessNumber) throw new Error("Staff notifications need the configured business number");
  const names: Record<StaffEventKind, string> = {
    intake: "New intake form received", call: "Incoming call — CSD tracking",
    "missed-call": "Missed call — please review Call Tracking",
    ticket: "New support ticket", appointment: "New appointment booked",
  };
  // Alert all techs without leaking customer details outside assignment scope.
  const base = canonicalPublicAppBaseUrl(process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL);
  const path = event.ticketId ? `/tickets?ticket=${event.ticketId}` : event.kind === "call" || event.kind === "missed-call"
    ? "/admin/call-tracking"
    : event.kind === "ticket" ? `/tickets?ticket=${encodeURIComponent(event.id)}`
    : event.kind === "appointment" ? "/calendar" : "/admin/intakes";
  const name = event.kind === "intake" && event.ticketId ? "Call Tracking intake saved — ticket" : names[event.kind];
  const text = `${name}${event.kind === "call" || event.kind === "missed-call" ? "" : ` #${event.ticketId ?? event.id}`}.${base.ok ? ` ${base.origin}${path}` : " Sign in to CSD to review."}`;
  const targets = [...new Set<string>(recipients.map((row: any) => toValidE164(row.phone)!))];
  await executor.execute(sql`
    INSERT INTO sms_forward_deliveries(inbound_message_sid,target_number,source_number,business_number,body,status,next_attempt_at)
    VALUES ${sql.join(targets.map(phone => sql`(
      ${`staff:${event.kind}:${event.id}`},${phone},${businessNumber},${businessNumber},${text},'pending',NOW()
    )`), sql`, `)}
    ON CONFLICT(inbound_message_sid,target_number) DO NOTHING
  `);
  if (event.kind === "ticket") {
    for (const recipient of recipients) {
      await executor.execute(sql`
        INSERT INTO staff_dispatch_correlations(ticket_id,recipient_id,recipient_phone)
        VALUES(${Number(event.id)},${recipient.id},${recipient.phone})
        ON CONFLICT(ticket_id,recipient_phone) DO NOTHING
      `);
    }
  }
  if (executor === db) void processSmsForwardDeliveries();
}

export async function findAuthorizedStaff(phone: string): Promise<StaffDispatchRecipient | null> {
  await ensureStaffDispatchTables();
  const normalized = normalizeDispatchPhone(phone);
  const result = await pool.query(
    `SELECT r.* FROM staff_dispatch_recipients r
     WHERE r.phone=$1 AND r.enabled=TRUE AND r.on_duty=TRUE AND r.can_use_commands=TRUE
       AND ${APPROVED_RECIPIENT}`,
    [normalized],
  );
  return result.rows[0] ? recipientFromRow(result.rows[0]) : null;
}

/** Phone targets for main-line call fan-out, deliberately excluding tracking routing. */
export async function getActiveCallRecipientPhones(): Promise<string[]> {
  await ensureStaffDispatchTables();
  const result = await pool.query(
    `SELECT r.phone FROM staff_dispatch_recipients r
     WHERE r.enabled=TRUE AND r.on_duty=TRUE AND r.receive_calls=TRUE
       AND ${APPROVED_RECIPIENT} ORDER BY r.id`,
  );
  return result.rows.map((row: any) => row.phone);
}

function usage(): string {
  return "Use CLAIM <ticket>, STATUS <ticket>, CLOSE <ticket>, or CLIENT <ticket>: <message>.";
}

async function getTicket(ticketNumber: string) {
  return storage.getTicketByNumber(ticketNumber);
}

async function hasSmsConsent(
  ticket: any,
  queryable: { query: (sql: string, params?: any[]) => Promise<any> } = pool,
): Promise<boolean> {
  if (!ticket.requesterPhone) return false;
  const normalized = toE164(ticket.requesterPhone);
  const state = await queryable.query(
    "SELECT consented FROM staff_dispatch_sms_consent WHERE phone=$1",
    [normalized],
  );
  // Explicit STOP/START state is authoritative. Historical CRM proof is only
  // a fallback for contacts with no state row yet.
  if (state.rows[0]) return state.rows[0].consented === true;
  const contacts = await queryable.query("SELECT id,mobile_phone FROM crm_contacts WHERE mobile_phone IS NOT NULL");
  const contactIds = contacts.rows
    .filter((contact: any) => toE164(contact.mobile_phone) === normalized)
    .map((contact: any) => contact.id);
  if (!contactIds.length) return false;
  const result = await queryable.query(
    "SELECT 1 FROM crm_interactions WHERE contact_id=ANY($1::int[]) AND type='sms_consent' LIMIT 1",
    [contactIds],
  );
  return (result.rowCount ?? 0) > 0;
}

export type SmsMessageClass = "service" | "marketing";

/** Resolve consent without trusting a client-supplied eligibility flag. */
export async function getSmsConsentEligibility(
  phone: string,
  contactId: number,
  messageClass: SmsMessageClass,
  queryable: { query: (sql: string, params?: any[]) => Promise<any> } = pool,
): Promise<{ eligible: boolean; reason: string | null }> {
  await ensureStaffDispatchTables();
  const normalized = toE164(phone);
  if (!normalized) return { eligible: false, reason: "Invalid mobile number" };

  const state = await queryable.query(
    "SELECT consented FROM staff_dispatch_sms_consent WHERE phone=$1",
    [normalized],
  );
  if (state.rows[0]?.consented === false) {
    return { eligible: false, reason: "Customer opted out by replying STOP" };
  }

  if (messageClass === "marketing") {
    const marketing = await queryable.query(
      "SELECT 1 FROM crm_interactions WHERE contact_id=$1 AND type='marketing_sms_consent' LIMIT 1",
      [contactId],
    );
    return (marketing.rowCount ?? 0) > 0
      ? { eligible: true, reason: null }
      : { eligible: false, reason: "No separate marketing SMS consent" };
  }

  if (state.rows[0]?.consented === true) return { eligible: true, reason: null };
  const historical = await queryable.query(
    "SELECT 1 FROM crm_interactions WHERE contact_id=$1 AND type='sms_consent' LIMIT 1",
    [contactId],
  );
  return (historical.rowCount ?? 0) > 0
    ? { eligible: true, reason: null }
    : { eligible: false, reason: "No service SMS consent" };
}

/** Stores the latest carrier-visible SMS consent decision for a normalized phone. */
export async function recordSmsConsentState(phone: string, consented: boolean): Promise<void> {
  await ensureStaffDispatchTables();
  const normalized = toE164(phone);
  if (!normalized) throw new Error("A valid phone number is required for SMS consent");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [normalized]);
    await client.query(
      `INSERT INTO staff_dispatch_sms_consent(phone,consented,updated_at)
       VALUES($1,$2,NOW())
       ON CONFLICT(phone) DO UPDATE SET consented=EXCLUDED.consented,updated_at=NOW()`,
      [normalized, consented],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function recordRejected(staff: StaffDispatchRecipient, action: string, ticketId?: number) {
  await audit(pool, {
    actorType: "staff_sms", actorIdentity: `${staff.displayName} (${staff.phone})`,
    action, outcome: "rejected", recipientId: staff.id, ticketId,
  });
}

export async function reconcileStaffClientMessageHistory(deliveryId: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT m.*,COALESCE(r.display_name,m.recipient_phone) AS staff_name
       FROM staff_dispatch_client_messages m
       LEFT JOIN staff_dispatch_recipients r ON r.id=m.recipient_id
       WHERE m.id=$1 FOR UPDATE OF m`,
      [deliveryId],
    );
    const delivery = result.rows[0];
    if (!delivery || delivery.history_saved || delivery.status === "failed") {
      await client.query("COMMIT");
      return !!delivery?.history_saved;
    }
    const message = await client.query(
      `INSERT INTO ticket_messages(ticket_id,author_type,author_name,body,is_internal)
       VALUES($1,'staff',$2,$3,FALSE) RETURNING id`,
      [delivery.ticket_id, delivery.staff_name, delivery.body],
    );
    await client.query(
      `INSERT INTO ticket_activity(ticket_id,actor_type,actor_name,action,details)
       VALUES($1,'staff',$2,'reply',$3)`,
      [
        delivery.ticket_id,
        delivery.staff_name,
        JSON.stringify({
          channel: "staff_sms",
          characters: delivery.body.length,
          providerMessageSid: delivery.provider_message_sid,
          deliveryStatus: delivery.status,
        }),
      ],
    );
    await audit(client, {
      actorType: "staff_sms",
      actorIdentity: delivery.recipient_phone,
      action: "ticket.client_message",
      outcome: "accepted",
      recipientId: delivery.recipient_id,
      ticketId: delivery.ticket_id,
      after: {
        deliveredVia: "sms",
        characters: delivery.body.length,
        providerMessageSid: delivery.provider_message_sid,
        deliveryStatus: delivery.status,
      },
    });
    await client.query(
      `UPDATE staff_dispatch_client_messages
       SET history_saved=TRUE,ticket_message_id=$2,error=NULL,updated_at=NOW()
       WHERE id=$1`,
      [deliveryId, message.rows[0].id],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateStaffClientMessageAfterSend(
  id: number,
  status: "pending" | "delivered" | "failed",
  providerMessageSid: string,
): Promise<void> {
  await pool.query(
    `UPDATE staff_dispatch_client_messages
     SET status=CASE
           WHEN status IN ('delivered','failed') THEN status
           WHEN $2 IN ('delivered','failed') THEN $2
           ELSE 'pending'
         END,
         provider_message_sid=COALESCE(provider_message_sid,$3),
         error=CASE WHEN $2='failed' THEN error ELSE NULL END,
         updated_at=NOW()
     WHERE id=$1`,
    [id, status, providerMessageSid],
  );
}

export async function processStaffClientMessageHistory(limit = 20): Promise<number> {
  const rows = await pool.query(
    `SELECT id FROM staff_dispatch_client_messages
     WHERE history_saved=FALSE AND status IN ('pending','delivered')
     ORDER BY created_at LIMIT $1`,
    [limit],
  );
  let recovered = 0;
  let firstError: unknown;
  for (const row of rows.rows) {
    try {
      if (await reconcileStaffClientMessageHistory(Number(row.id))) recovered++;
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
  return recovered;
}

let clientMessageHistoryTimer: ReturnType<typeof setInterval> | undefined;
export function startStaffClientMessageHistoryWorker(onError: (error: unknown) => void): void {
  if (clientMessageHistoryTimer) return;
  void processStaffClientMessageHistory().catch(onError);
  clientMessageHistoryTimer = setInterval(() => {
    void processStaffClientMessageHistory().catch(onError);
  }, 30_000);
  clientMessageHistoryTimer.unref();
}

async function claimTicket(staff: StaffDispatchRecipient, ticketNumber: string): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM tickets WHERE UPPER(ticket_number)=UPPER($1) FOR UPDATE", [ticketNumber]);
    const ticket = found.rows[0];
    if (!ticket) {
      await audit(client, { actorType: "staff_sms", actorIdentity: staff.phone, action: "ticket.claim", outcome: "rejected", recipientId: staff.id });
      await client.query("COMMIT");
      return `Ticket ${ticketNumber} not found.`;
    }
    const claimed = await client.query(
      "SELECT recipient_id FROM staff_dispatch_correlations WHERE ticket_id=$1 AND claimed_at IS NOT NULL LIMIT 1",
      [ticket.id],
    );
    if (ticket.assigned_to != null || claimed.rows[0]) {
      await audit(client, { actorType: "staff_sms", actorIdentity: staff.phone, action: "ticket.claim", outcome: "rejected", recipientId: staff.id, ticketId: ticket.id });
      await client.query("COMMIT");
      return `${ticket.ticket_number} is already assigned.`;
    }
    if (["closed", "resolved"].includes(String(ticket.status).toLowerCase())) {
      await audit(client, { actorType: "staff_sms", actorIdentity: staff.phone, action: "ticket.claim", outcome: "rejected", recipientId: staff.id, ticketId: ticket.id });
      await client.query("COMMIT");
      return `${ticket.ticket_number} is ${ticket.status}.`;
    }
    if (staff.linkedUserId == null) {
      await audit(client, {
        actorType: "staff_sms", actorIdentity: staff.phone, action: "ticket.claim",
        outcome: "rejected", recipientId: staff.id, ticketId: ticket.id,
        before: { status: ticket.status, assignedTo: ticket.assigned_to },
      });
      await client.query("COMMIT");
      return `Cannot claim ${ticket.ticket_number}: your dispatch recipient has no linked helpdesk user. Ask an owner to link your recipient to a ticket assignee.`;
    }
    const linkedUser = await client.query("SELECT id FROM users WHERE id=$1 FOR KEY SHARE", [staff.linkedUserId]);
    if (!linkedUser.rows[0]) {
      await audit(client, {
        actorType: "staff_sms", actorIdentity: staff.phone, action: "ticket.claim",
        outcome: "rejected", recipientId: staff.id, ticketId: ticket.id,
      });
      await client.query("COMMIT");
      return `Cannot claim ${ticket.ticket_number}: your linked helpdesk user no longer exists. Ask an owner to update the recipient mapping.`;
    }
    const assigned = await client.query(
      "UPDATE tickets SET assigned_to=$2,status='in-progress',updated_at=NOW() WHERE id=$1 AND assigned_to IS NULL",
      [ticket.id, staff.linkedUserId],
    );
    if (assigned.rowCount !== 1) {
      await audit(client, {
        actorType: "staff_sms", actorIdentity: staff.phone, action: "ticket.claim",
        outcome: "rejected", recipientId: staff.id, ticketId: ticket.id,
      });
      await client.query("COMMIT");
      return `${ticket.ticket_number} is already assigned.`;
    }
    await client.query(
      `INSERT INTO staff_dispatch_correlations(ticket_id,recipient_id,recipient_phone,claimed_at)
       VALUES($1,$2,$3,NOW()) ON CONFLICT(ticket_id,recipient_phone)
       DO UPDATE SET recipient_id=EXCLUDED.recipient_id,claimed_at=NOW()`,
      [ticket.id, staff.id, staff.phone],
    );
    await client.query(
      `INSERT INTO ticket_activity(ticket_id,actor_type,actor_name,action,details)
       VALUES($1,'staff',$2,'assigned',$3)`,
      [ticket.id, staff.displayName, JSON.stringify({ channel: "staff_sms", recipientId: staff.id, assignedTo: staff.linkedUserId })],
    );
    await audit(client, {
      actorType: "staff_sms", actorIdentity: staff.phone, action: "ticket.claim",
      outcome: "accepted", recipientId: staff.id, ticketId: ticket.id,
      before: { status: ticket.status, assigned: false }, after: { status: "in-progress", assignedTo: staff.linkedUserId, assignedToName: staff.displayName },
    });
    await client.query("COMMIT");
    return `${ticket.ticket_number} claimed by ${staff.displayName}; assigned and status in-progress.`;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function claimRecentCorrelation(staff: StaffDispatchRecipient): Promise<string> {
  const result = await pool.query(
    `SELECT t.ticket_number FROM staff_dispatch_correlations c
       JOIN tickets t ON t.id=c.ticket_id
      WHERE c.recipient_phone=$1 AND c.dispatched_at > NOW()-INTERVAL '24 hours'
        AND c.claimed_at IS NULL AND t.assigned_to IS NULL
        AND t.status NOT IN ('closed','resolved')
      ORDER BY c.dispatched_at DESC LIMIT 2`,
    [staff.phone],
  );
  if (result.rows.length !== 1) {
    await recordRejected(staff, "ticket.plain_claim");
    return `${result.rows.length ? "More than one recent ticket matches." : "No recent open dispatch matches."} ${usage()}`;
  }
  return claimTicket(staff, result.rows[0].ticket_number);
}

async function closeAssignedTicket(staff: StaffDispatchRecipient, ticket: any): Promise<boolean> {
  if (staff.linkedUserId == null) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE tickets SET status='closed',closed_at=NOW(),updated_at=NOW()
       WHERE id=$1 AND assigned_to=$2 RETURNING status`,
      [ticket.id, staff.linkedUserId],
    );
    if (updated.rowCount !== 1) {
      await audit(client, {
        actorType: "staff_sms", actorIdentity: staff.phone, action: "ticket.close",
        outcome: "rejected", recipientId: staff.id, ticketId: ticket.id,
      });
      await client.query("COMMIT");
      return false;
    }
    await client.query(
      `INSERT INTO ticket_activity(ticket_id,actor_type,actor_name,action,details)
       VALUES($1,'staff',$2,'status_changed',$3)`,
      [ticket.id, staff.displayName, JSON.stringify({ from: ticket.status, to: "closed", channel: "staff_sms" })],
    );
    await audit(client, {
      actorType: "staff_sms", actorIdentity: staff.phone, action: "ticket.close",
      outcome: "accepted", recipientId: staff.id, ticketId: ticket.id,
      before: { status: ticket.status }, after: { status: "closed" },
    });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function sendClientMessage(
  staff: StaffDispatchRecipient,
  ticket: any,
  message: string,
  inboundMessageSid?: string,
  smsSender: typeof sendSms = sendSms,
  deliveryStateWriter: (
    id: number,
    status: "pending" | "delivered" | "failed",
    providerMessageSid: string,
  ) => Promise<void> = updateStaffClientMessageAfterSend,
  historyReconciler: (id: number) => Promise<boolean> = reconcileStaffClientMessageHistory,
): Promise<"delivered" | "pending" | "failed" | "not_assignee" | "no_consent"> {
  if (staff.linkedUserId == null) return "not_assignee";
  const client = await pool.connect();
  let deliveryId: number | null = null;
  let requesterPhone = "";
  try {
    await client.query("BEGIN");
    const assigned = await client.query(
      `SELECT id,ticket_number,requester_phone,status
       FROM tickets WHERE id=$1 AND assigned_to=$2 FOR UPDATE`,
      [ticket.id, staff.linkedUserId],
    );
    if (assigned.rowCount !== 1) {
      await audit(client, {
        actorType: "staff_sms", actorIdentity: staff.phone, action: "ticket.client_message",
        outcome: "rejected", recipientId: staff.id, ticketId: ticket.id,
      });
      await client.query("COMMIT");
      return "not_assignee";
    }
    const currentTicket = {
      ...ticket,
      requesterPhone: assigned.rows[0].requester_phone,
    };
    const normalizedRequesterPhone = toE164(currentTicket.requesterPhone || "");
    if (normalizedRequesterPhone) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [normalizedRequesterPhone],
      );
    }
    if (!currentTicket.requesterPhone || !(await hasSmsConsent(currentTicket, client))) {
      await audit(client, {
        actorType: "staff_sms", actorIdentity: staff.phone, action: "ticket.client_message",
        outcome: "rejected", recipientId: staff.id, ticketId: ticket.id,
      });
      await client.query("COMMIT");
      return "no_consent";
    }
    requesterPhone = normalizedRequesterPhone;
    const idempotencyKey = inboundMessageSid
      ? `twilio:${inboundMessageSid}`
      : `direct:${crypto.randomUUID()}`;
    const inserted = await client.query(
      `INSERT INTO staff_dispatch_client_messages
        (idempotency_key,inbound_message_sid,ticket_id,recipient_id,recipient_phone,requester_phone,body)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(idempotency_key) DO NOTHING
       RETURNING id,status`,
      [idempotencyKey, inboundMessageSid || null, ticket.id, staff.id, staff.phone, requesterPhone, message],
    );
    if (!inserted.rows[0]) {
      const existing = await client.query(
        "SELECT id,status,history_saved FROM staff_dispatch_client_messages WHERE idempotency_key=$1",
        [idempotencyKey],
      );
      await client.query("COMMIT");
      if (existing.rows[0] && !existing.rows[0].history_saved && existing.rows[0].status !== "failed") {
        await reconcileStaffClientMessageHistory(Number(existing.rows[0].id)).catch(() => undefined);
      }
      return existing.rows[0]?.status || "pending";
    }
    deliveryId = inserted.rows[0].id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  let providerMessageSid: string;
  let deliveryStatus: "pending" | "delivered" | "failed";
  try {
    const sent = await smsSender(requesterPhone, message, { proxyDeliveryId: deliveryId! });
    providerMessageSid = sent.sid;
    deliveryStatus = sent.status === "delivered" ? "delivered"
      : ["failed", "undelivered"].includes(sent.status) ? "failed"
      : "pending";
  } catch (error: any) {
    const errorMessage = String(error?.message || "Twilio send failed").slice(0, 2000);
    await pool.query(
      `UPDATE staff_dispatch_client_messages
       SET status='failed',error=$2,updated_at=NOW() WHERE id=$1`,
      [deliveryId, errorMessage],
    );
    return "failed";
  }

  let statePersisted = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await deliveryStateWriter(deliveryId!, deliveryStatus, providerMessageSid);
      statePersisted = true;
      break;
    } catch {
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 25));
    }
  }
  if (!statePersisted) {
    // The committed pending row is deliberately left untouched. A webhook
    // retry will find it and will not contact Twilio a second time.
    return "pending";
  }

  try {
    await historyReconciler(deliveryId!);
  } catch (error: any) {
    await pool.query(
      "UPDATE staff_dispatch_client_messages SET error=$2,updated_at=NOW() WHERE id=$1",
      [deliveryId, `Ticket history save failed: ${String(error?.message || error).slice(0, 1900)}`],
    ).catch(() => undefined);
  }
  return deliveryStatus;
}

export async function handleStaffInboundSms(
  from: string,
  body: string,
  inboundMessageSid?: string,
): Promise<{ handled: boolean; reply?: string }> {
  const staff = await findAuthorizedStaff(from);
  if (!staff) return { handled: false };
  const command = parseStaffSmsCommand(body);
  if (command.kind === "invalid") {
    await recordRejected(staff, "command.invalid");
    return { handled: true, reply: usage() };
  }
  if (command.kind === "plain") return { handled: true, reply: await claimRecentCorrelation(staff) };
  if (command.kind === "claim") return { handled: true, reply: await claimTicket(staff, command.ticketNumber) };

  const ticket = await getTicket(command.ticketNumber);
  if (!ticket) {
    await recordRejected(staff, `ticket.${command.kind}`);
    return { handled: true, reply: `Ticket ${command.ticketNumber} not found.` };
  }
  if (command.kind === "status") {
    await audit(pool, { actorType: "staff_sms", actorIdentity: staff.phone, action: "ticket.status", outcome: "accepted", recipientId: staff.id, ticketId: ticket.id });
    return { handled: true, reply: `${ticket.ticketNumber}: ${ticket.status}${ticket.assignedTo ? " (assigned)" : ""}.` };
  }
  if (command.kind === "close") {
    if (!(await closeAssignedTicket(staff, ticket))) {
      return {
        handled: true,
        reply: `Cannot close ${ticket.ticketNumber}: only its assigned staff member may do that.`,
      };
    }
    return { handled: true, reply: `${ticket.ticketNumber} closed.` };
  }
  if (command.kind !== "client") {
    await recordRejected(staff, "command.invalid", ticket.id);
    return { handled: true, reply: usage() };
  }

  const clientMessage = await sendClientMessage(staff, ticket, command.message, inboundMessageSid);
  if (clientMessage === "not_assignee") {
    return {
      handled: true,
      reply: `Cannot message ${ticket.ticketNumber}: only its assigned staff member may do that.`,
    };
  }
  if (clientMessage === "no_consent") {
    return { handled: true, reply: `Cannot text ${ticket.ticketNumber}: no requester SMS consent evidence.` };
  }
  if (clientMessage === "failed") {
    return { handled: true, reply: `Message failed for ${ticket.ticketNumber}. It was not sent; send a new CLIENT command to retry.` };
  }
  if (clientMessage === "pending") {
    return { handled: true, reply: `Message for ${ticket.ticketNumber} is still pending. It will not be sent twice.` };
  }
  return { handled: true, reply: `Message delivered to requester for ${ticket.ticketNumber}.` };
}

export async function dispatchNewTicketToStaff(
  ticket: any,
  details: { clientName: string; clientPhone?: string | null; device: string; issue: string },
): Promise<void> {
  // Same event key as normal ticket creation: retries never double-text techs.
  await enqueueStaffEventNotification({ kind: "ticket", id: ticket.id }, db, true);
}

export function buildStaffHelpdeskUrl(publicBaseUrl: string | undefined, ticketId: number): string | null {
  const base = (publicBaseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return null;
  const origin = base.startsWith("http") ? base : `https://${base}`;
  return `${origin}/tickets?ticket=${encodeURIComponent(String(ticketId))}`;
}