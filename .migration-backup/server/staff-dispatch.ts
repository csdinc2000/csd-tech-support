import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import { pool } from "./db";
import { isAdminUser } from "./security";
import { sendSms, toE164 } from "./twilio";
import { storage } from "./storage";
import {
  normalizeDispatchPhone,
  parseStaffSmsCommand,
} from "./staff-dispatch-command";

export { parseStaffSmsCommand } from "./staff-dispatch-command";

export interface StaffDispatchRecipient {
  id: number;
  name: string;
  displayName: string;
  phone: string;
  enabled: boolean;
  onDuty: boolean;
  receiveCalls: boolean;
  receiveMessages: boolean;
  canUseCommands: boolean;
  linkedUserId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const recipientInput = z.object({
  displayName: z.string().trim().min(1).max(120),
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
const parseRecipientPatch = (body: any) =>
  recipientPatch.safeParse({
    ...body,
    displayName: body?.displayName ?? body?.name,
    phone: typeof body?.phone === "string" ? normalizeDispatchPhone(body.phone) : body?.phone,
  });

let initialization: Promise<void> | null = null;

/** Runtime DDL is intentional: db:push is unavailable in this deployment. */
export function ensureStaffDispatchTables(): Promise<void> {
  if (!initialization) {
    initialization = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS staff_dispatch_recipients (
          id SERIAL PRIMARY KEY,
          display_name TEXT NOT NULL,
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
        CREATE INDEX IF NOT EXISTS staff_dispatch_audit_created_idx
          ON staff_dispatch_audit(created_at DESC);
        CREATE INDEX IF NOT EXISTS staff_dispatch_correlation_recent_idx
          ON staff_dispatch_correlations(recipient_phone, dispatched_at DESC);
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
    phone: row.phone,
    enabled: row.enabled,
    onDuty: row.on_duty,
    receiveCalls: row.receive_calls,
    receiveMessages: row.receive_messages,
    canUseCommands: row.can_use_commands,
    linkedUserId: row.linked_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function recipientSummary(r: StaffDispatchRecipient | null) {
  if (!r) return null;
  return {
    displayName: r.displayName,
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
  const user = req.user as any;
  return String(user?.claims?.email || user?.claims?.sub || user?.email || "authenticated-owner");
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
  if (!isAdminUser(req)) return res.status(403).json({ error: "Owner access required" });
  next();
};

export function registerStaffDispatchRoutes(app: Express): void {
  app.use("/api/staff-dispatch", requireOwner);

  app.get("/api/staff-dispatch/settings", async (_req, res) => {
    try {
      await ensureStaffDispatchTables();
      const result = await pool.query("SELECT * FROM staff_dispatch_recipients ORDER BY display_name, id");
      const recipients = result.rows.map(recipientFromRow);
      res.json({
        recipients,
        routing: {
          activeCallRecipients: recipients.filter((r) => r.enabled && r.onDuty && r.receiveCalls).map((r) => r.id),
          activeMessageRecipients: recipients.filter((r) => r.enabled && r.onDuty && r.receiveMessages).map((r) => r.id),
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Failed to list recipients" });
    }
  });

  // The legacy helpdesk assignment column references users.id, not Replit
  // auth_users.id. Expose only those assignable legacy users for owner mapping.
  app.get("/api/staff-dispatch/eligible-assignees", async (_req, res) => {
    try {
      const result = await pool.query(
        "SELECT id, username AS name, email, role FROM users ORDER BY username, id",
      );
      res.json(result.rows);
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Failed to list ticket assignees" });
    }
  });

  app.post("/api/staff-dispatch/settings", async (req, res) => {
    const parsed = parseRecipientInput(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid recipient", details: parsed.error.flatten() });
    try {
      await ensureStaffDispatchTables();
      if (parsed.data.canUseCommands && parsed.data.linkedUserId == null) {
        return res.status(400).json({ error: "A linked helpdesk user is required when SMS commands are enabled" });
      }
      if (parsed.data.linkedUserId != null) {
        const user = await pool.query("SELECT 1 FROM users WHERE id=$1", [parsed.data.linkedUserId]);
        if (!user.rows[0]) return res.status(400).json({ error: "Linked ticket user was not found" });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const d = parsed.data;
        const result = await client.query(
          `INSERT INTO staff_dispatch_recipients
            (display_name,phone,enabled,on_duty,receive_calls,receive_messages,can_use_commands,linked_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [d.displayName, d.phone, d.enabled, d.onDuty, d.receiveCalls, d.receiveMessages, d.canUseCommands, d.linkedUserId],
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
    if (!Number.isInteger(id) || !parsed.success) return res.status(400).json({ error: "Invalid recipient" });
    try {
      await ensureStaffDispatchTables();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const beforeResult = await client.query("SELECT * FROM staff_dispatch_recipients WHERE id=$1 FOR UPDATE", [id]);
        if (!beforeResult.rows[0]) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Recipient not found" });
        }
        const before = recipientFromRow(beforeResult.rows[0]);
        const merged = recipientInput.parse({
          ...recipientSummary(before),
          ...parsed.data,
        });
        const d = merged;
        if (d.canUseCommands && d.linkedUserId == null) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "A linked helpdesk user is required when SMS commands are enabled" });
        }
        if (d.linkedUserId != null) {
          const user = await client.query("SELECT 1 FROM users WHERE id=$1", [d.linkedUserId]);
          if (!user.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "Linked ticket user was not found" });
          }
        }
        const result = await client.query(
          `UPDATE staff_dispatch_recipients SET
             display_name=$2,phone=$3,enabled=$4,on_duty=$5,receive_calls=$6,
             receive_messages=$7,can_use_commands=$8,linked_user_id=$9,updated_at=NOW()
           WHERE id=$1 RETURNING *`,
          [id, d.displayName, d.phone, d.enabled, d.onDuty, d.receiveCalls, d.receiveMessages, d.canUseCommands, d.linkedUserId],
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
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid recipient id" });
    try {
      await ensureStaffDispatchTables();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query("DELETE FROM staff_dispatch_recipients WHERE id=$1 RETURNING *", [id]);
        if (!result.rows[0]) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Recipient not found" });
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
}

export async function findAuthorizedStaff(phone: string): Promise<StaffDispatchRecipient | null> {
  await ensureStaffDispatchTables();
  const normalized = normalizeDispatchPhone(phone);
  const result = await pool.query(
    `SELECT * FROM staff_dispatch_recipients
     WHERE phone=$1 AND enabled=TRUE AND on_duty=TRUE AND can_use_commands=TRUE`,
    [normalized],
  );
  return result.rows[0] ? recipientFromRow(result.rows[0]) : null;
}

/** Phone targets for main-line call fan-out, deliberately excluding tracking routing. */
export async function getActiveCallRecipientPhones(): Promise<string[]> {
  await ensureStaffDispatchTables();
  const result = await pool.query(
    `SELECT phone FROM staff_dispatch_recipients
     WHERE enabled=TRUE AND on_duty=TRUE AND receive_calls=TRUE ORDER BY id`,
  );
  return result.rows.map((row: any) => row.phone);
}

function usage(): string {
  return "Use CLAIM <ticket>, STATUS <ticket>, CLOSE <ticket>, or CLIENT <ticket>: <message>.";
}

async function getTicket(ticketNumber: string) {
  return storage.getTicketByNumber(ticketNumber);
}

async function hasSmsConsent(ticket: any): Promise<boolean> {
  if (!ticket.requesterPhone) return false;
  const normalized = toE164(ticket.requesterPhone);
  const state = await pool.query(
    "SELECT consented FROM staff_dispatch_sms_consent WHERE phone=$1",
    [normalized],
  );
  // Explicit STOP/START state is authoritative. Historical CRM proof is only
  // a fallback for contacts with no state row yet.
  if (state.rows[0]) return state.rows[0].consented === true;
  const contacts = await pool.query("SELECT id,mobile_phone FROM crm_contacts WHERE mobile_phone IS NOT NULL");
  const contactIds = contacts.rows
    .filter((contact: any) => toE164(contact.mobile_phone) === normalized)
    .map((contact: any) => contact.id);
  if (!contactIds.length) return false;
  const result = await pool.query(
    "SELECT 1 FROM crm_interactions WHERE contact_id=ANY($1::int[]) AND type='sms_consent' LIMIT 1",
    [contactIds],
  );
  return result.rowCount > 0;
}

/** Stores the latest carrier-visible SMS consent decision for a normalized phone. */
export async function recordSmsConsentState(phone: string, consented: boolean): Promise<void> {
  await ensureStaffDispatchTables();
  const normalized = toE164(phone);
  if (!normalized) throw new Error("A valid phone number is required for SMS consent");
  await pool.query(
    `INSERT INTO staff_dispatch_sms_consent(phone,consented,updated_at)
     VALUES($1,$2,NOW())
     ON CONFLICT(phone) DO UPDATE SET consented=EXCLUDED.consented,updated_at=NOW()`,
    [normalized, consented],
  );
}

async function recordRejected(staff: StaffDispatchRecipient, action: string, ticketId?: number) {
  await audit(pool, {
    actorType: "staff_sms", actorIdentity: `${staff.displayName} (${staff.phone})`,
    action, outcome: "rejected", recipientId: staff.id, ticketId,
  });
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
    await client.query(
      `INSERT INTO staff_dispatch_correlations(ticket_id,recipient_id,recipient_phone,claimed_at)
       VALUES($1,$2,$3,NOW()) ON CONFLICT(ticket_id,recipient_phone)
       DO UPDATE SET recipient_id=EXCLUDED.recipient_id,claimed_at=NOW()`,
      [ticket.id, staff.id, staff.phone],
    );
    await client.query(
      "UPDATE tickets SET assigned_to=$2,status='in-progress',updated_at=NOW() WHERE id=$1 AND assigned_to IS NULL",
      [ticket.id, staff.linkedUserId],
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

async function requireTicketAssignee(staff: StaffDispatchRecipient, ticket: any, action: string): Promise<string | null> {
  if (staff.linkedUserId != null && ticket.assignedTo === staff.linkedUserId) return null;
  await recordRejected(staff, action, ticket.id);
  return `Cannot ${action === "ticket.close" ? "close" : "message"} ${ticket.ticketNumber}: only its assigned staff member may do that.`;
}

export async function handleStaffInboundSms(from: string, body: string): Promise<{ handled: boolean; reply?: string }> {
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
    const denied = await requireTicketAssignee(staff, ticket, "ticket.close");
    if (denied) return { handled: true, reply: denied };
    const before = { status: ticket.status };
    await storage.updateTicket(ticket.id, { status: "closed", closedAt: new Date() });
    await storage.createTicketActivity({
      ticketId: ticket.id, actorType: "staff", actorName: staff.displayName,
      action: "status_changed", details: JSON.stringify({ from: ticket.status, to: "closed", channel: "staff_sms" }),
    });
    await audit(pool, { actorType: "staff_sms", actorIdentity: staff.phone, action: "ticket.close", outcome: "accepted", recipientId: staff.id, ticketId: ticket.id, before, after: { status: "closed" } });
    return { handled: true, reply: `${ticket.ticketNumber} closed.` };
  }

  const denied = await requireTicketAssignee(staff, ticket, "ticket.client_message");
  if (denied) return { handled: true, reply: denied };
  if (!ticket.requesterPhone || !(await hasSmsConsent(ticket))) {
    await recordRejected(staff, "ticket.client_message", ticket.id);
    return { handled: true, reply: `Cannot text ${ticket.ticketNumber}: no requester SMS consent evidence.` };
  }
  await sendSms(ticket.requesterPhone, command.message);
  await storage.createTicketMessage({
    ticketId: ticket.id, authorType: "staff", authorName: staff.displayName,
    body: command.message, isInternal: false,
  });
  await storage.createTicketActivity({
    ticketId: ticket.id, actorType: "staff", actorName: staff.displayName,
    action: "reply", details: JSON.stringify({ channel: "staff_sms", characters: command.message.length }),
  });
  await audit(pool, {
    actorType: "staff_sms", actorIdentity: staff.phone, action: "ticket.client_message",
    outcome: "accepted", recipientId: staff.id, ticketId: ticket.id,
    after: { deliveredVia: "sms", characters: command.message.length },
  });
  return { handled: true, reply: `Message sent to requester for ${ticket.ticketNumber}.` };
}

export async function dispatchNewTicketToStaff(
  ticket: any,
  details: { clientName: string; clientPhone?: string | null; device: string; issue: string },
): Promise<void> {
  await ensureStaffDispatchTables();
  const recipients = await pool.query(
    `SELECT * FROM staff_dispatch_recipients
     WHERE enabled=TRUE AND on_duty=TRUE AND receive_messages=TRUE ORDER BY id`,
  );
  if (!recipients.rows.length) return;
  const base = process.env.PUBLIC_BASE_URL;
  // Staff receive an authenticated helpdesk link only from an intentionally
  // configured public base URL. Never expose customer portal credentials in SMS.
  const staffUrl = buildStaffHelpdeskUrl(base, ticket.id);
  const text =
    `New ${ticket.ticketNumber || `#${ticket.id}`}: ${details.clientName} ${details.clientPhone || "no phone"}\n` +
    `${details.device}: ${details.issue.slice(0, 140)}\n` +
    (staffUrl ? `${staffUrl}\n` : "") +
    `Reply CLAIM ${ticket.ticketNumber}, STATUS ${ticket.ticketNumber}, CLOSE ${ticket.ticketNumber}, or CLIENT ${ticket.ticketNumber}: message`;
  await Promise.all(recipients.rows.map(async (row: any) => {
    const staff = recipientFromRow(row);
    try {
      await sendSms(staff.phone, text);
      await pool.query(
        `INSERT INTO staff_dispatch_correlations(ticket_id,recipient_id,recipient_phone)
         VALUES($1,$2,$3) ON CONFLICT(ticket_id,recipient_phone)
         DO UPDATE SET recipient_id=EXCLUDED.recipient_id,dispatched_at=NOW()`,
        [ticket.id, staff.id, staff.phone],
      );
      await audit(pool, {
        actorType: "system", actorIdentity: "intake", action: "ticket.dispatched",
        outcome: "accepted", recipientId: staff.id, ticketId: ticket.id,
        after: { ticketNumber: ticket.ticketNumber, channel: "sms" },
      });
    } catch {
      await audit(pool, {
        actorType: "system", actorIdentity: "intake", action: "ticket.dispatched",
        outcome: "rejected", recipientId: staff.id, ticketId: ticket.id,
        after: { ticketNumber: ticket.ticketNumber, channel: "sms" },
      }).catch(() => undefined);
    }
  }));
}

export function buildStaffHelpdeskUrl(publicBaseUrl: string | undefined, ticketId: number): string | null {
  const base = (publicBaseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return null;
  const origin = base.startsWith("http") ? base : `https://${base}`;
  return `${origin}/tickets?ticket=${encodeURIComponent(String(ticketId))}`;
}