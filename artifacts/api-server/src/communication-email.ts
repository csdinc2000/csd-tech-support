import { createHash } from "node:crypto";
import type { Express, Request, RequestHandler } from "express";
import {
  SearchCommunicationRecipientsResponse,
  SendCommunicationEmailBody,
  SendCommunicationEmailResponse,
} from "@workspace/api-zod";
import { pool } from "./db";
import { storage } from "./storage";
import { getStaffAssignmentScope } from "./staff-access";
import { sendEmail } from "./helpdesk-email";
import { isSmtpConfigured } from "./mail-transport";
import { rateLimit } from "./security";
import { getMeetingStaff, displayName } from "./staff-meetings";
import type { StaffAssignmentScope } from "./staff-access";

const SUPPORT_FROM = "support@computersystemsdepot.com";
const MAX_RECIPIENTS = 20;

type Recipient = {
  id: string;
  name: string;
  email: string;
  kind: "staff" | "customer";
  company: string | null;
};

type ClaimResult =
  | { claimed: true; id: string }
  | { claimed: false; status: "accepted" | "submitting" | "unknown" };

type EmailDependencies = {
  canSeeContact?: (scope: StaffAssignmentScope, contactId: number) => boolean;
  getContacts?: (query: string) => Promise<Array<{
    id: number; fullName: string; email: string | null; company?: string | null;
  }>>;
  getStaff?: (query: string) => Promise<Array<{
    id: string; first_name: string | null; last_name: string | null; email: string;
  }>>;
  claimAttempt?: (input: {
    requestId: string; senderId: string; payloadHash: string; recipientCount: number; provider: "smtp" | "sendgrid";
  }) => Promise<ClaimResult>;
  finishAttempt?: (id: string, state: "accepted" | "rejected" | "unknown", messageId: string | null) => Promise<void>;
  send?: typeof sendEmail;
  fromAddress?: string;
  providerConfigured?: () => boolean;
  authorize?: RequestHandler;
};

const sendLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  key: (req) => req.dbUser?.id ?? req.ip ?? "unknown",
  message: "Too many emails. Please wait a minute before sending again.",
});

function safeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function validEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]!).replace(/\r?\n/g, "<br>");
}

function payloadHash(recipients: string[], subject: string, body: string): string {
  return createHash("sha256").update(JSON.stringify({ recipients, subject, body })).digest("hex");
}

async function searchRecipients(
  query: string,
  dependencies: Required<Pick<EmailDependencies, "canSeeContact" | "getContacts" | "getStaff">>,
  req: Request,
) {
  const scope = await getStaffAssignmentScope(req);
  const [contacts, staff] = await Promise.all([
    dependencies.getContacts(query),
    dependencies.getStaff(query),
  ]);
  const results = new Map<string, Recipient>();
  for (const person of staff) {
    const email = safeEmail(person.email);
    if (!email || !validEmail(email)) continue;
    results.set(email, {
      id: `staff:${person.id}`,
      name: displayName(person),
      email,
      kind: "staff",
      company: null,
    });
  }
  for (const contact of contacts) {
    const email = safeEmail(contact.email ?? "");
    if (!email || !validEmail(email) || !dependencies.canSeeContact(scope, contact.id)) continue;
    if (results.has(email)) continue;
    results.set(email, {
      id: `contact:${contact.id}`,
      name: contact.fullName.trim() || email,
      email,
      kind: "customer",
      company: contact.company?.trim() || null,
    });
  }
  return [...results.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email))
    .slice(0, 40);
}

async function claimDatabaseAttempt(input: {
  requestId: string; senderId: string; payloadHash: string; recipientCount: number; provider: "smtp" | "sendgrid";
}): Promise<ClaimResult> {
  const created = await pool.query(
    `INSERT INTO communication_email_send_attempts
       (request_id, sender_id, payload_hash, recipient_count, provider, status)
     VALUES ($1, $2, $3, $4, $5, 'submitting')
     ON CONFLICT (sender_id, request_id) DO NOTHING
     RETURNING id`,
    [input.requestId, input.senderId, input.payloadHash, input.recipientCount, input.provider],
  );
  if (created.rows[0]) return { claimed: true, id: String(created.rows[0].id) };

  const existing = await pool.query(
    `SELECT id, payload_hash, status
     FROM communication_email_send_attempts
     WHERE sender_id = $1 AND request_id = $2`,
    [input.senderId, input.requestId],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("Communication email send attempt was not found");
  if (String(row.payload_hash).trim() !== input.payloadHash) {
    return { claimed: false, status: "unknown" };
  }
  if (row.status === "accepted" || row.status === "unknown" || row.status === "submitting") {
    return { claimed: false, status: row.status };
  }
  const retry = await pool.query(
    `UPDATE communication_email_send_attempts
     SET status = 'submitting', updated_at = NOW()
     WHERE id = $1 AND status = 'rejected'
     RETURNING id`,
    [row.id],
  );
  if (retry.rows[0]) return { claimed: true, id: String(row.id) };
  return { claimed: false, status: "submitting" };
}

async function finishDatabaseAttempt(
  id: string,
  status: "accepted" | "rejected" | "unknown",
  messageId: string | null,
): Promise<void> {
  const result = await pool.query(
    `UPDATE communication_email_send_attempts
     SET status = $2, message_id = $3, updated_at = NOW()
     WHERE id = $1 AND status = 'submitting'
     RETURNING id`,
    [id, status, messageId],
  );
  if (result.rows.length !== 1) throw new Error("Communication email attempt status was not saved");
}

function isProviderRejection(error: unknown): boolean {
  const row = error as { responseCode?: unknown; code?: unknown; response?: { statusCode?: unknown } };
  const status = Number(row?.responseCode ?? row?.response?.statusCode ?? row?.code);
  return Number.isInteger(status) && status >= 400 && status < 600;
}

function errorCode(error: unknown): string | null {
  const value = (error as { code?: unknown })?.code;
  return typeof value === "string" && /^[A-Z0-9_]{2,32}$/i.test(value) ? value : null;
}

export function registerCommunicationEmailRoutes(
  app: Express,
  options: EmailDependencies,
): void {
  const dependencies = {
    canSeeContact: options.canSeeContact ?? ((_scope: StaffAssignmentScope, _id: number) => false),
    getContacts: options.getContacts ?? (async (query: string) => storage.searchCrmContacts(query)),
    getStaff: options.getStaff ?? (async (query: string) =>
      (await getMeetingStaff()).filter((person) =>
        `${displayName(person)} ${person.email}`.toLowerCase().includes(query.toLowerCase()),
      )),
    claimAttempt: options.claimAttempt ?? claimDatabaseAttempt,
    finishAttempt: options.finishAttempt ?? finishDatabaseAttempt,
    send: options.send ?? sendEmail,
    fromAddress: options.fromAddress ?? process.env.MAIL_FROM?.trim().toLowerCase(),
    providerConfigured: options.providerConfigured ?? (() =>
      isSmtpConfigured() || Boolean(process.env.SENDGRID_API_KEY)),
  };

  app.get("/api/communications/recipients", options.authorize ?? ((_req, _res, next) => next()), async (req, res): Promise<void> => {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (query.length < 2 || query.length > 100) {
      res.status(400).json({ message: "Search with 2 to 100 characters." });
      return;
    }
    try {
      res.json(SearchCommunicationRecipientsResponse.parse({
        recipients: await searchRecipients(query, dependencies, req),
      }));
    } catch {
      req.log.error("Communication recipient search failed");
      res.status(500).json({ message: "Could not search staff and contacts." });
    }
  });

  app.post("/api/communications/email", sendLimiter, options.authorize ?? ((_req, _res, next) => next()), async (req, res): Promise<void> => {
    const parsed = SendCommunicationEmailBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ status: "rejected", recipientCount: 0, message: "Enter a valid subject, message, and up to 20 recipient addresses." });
      return;
    }
    const senderId = req.dbUser?.id == null ? "" : String(req.dbUser.id);
    if (!senderId) {
      res.status(401).json({ status: "rejected", recipientCount: parsed.data.recipients.length, message: "Sign in again before sending." });
      return;
    }
    const recipients = [...new Set(parsed.data.recipients.map(safeEmail))];
    if (!recipients.length || recipients.length > MAX_RECIPIENTS || recipients.some((email) => !validEmail(email))) {
      res.status(400).json({ status: "rejected", recipientCount: recipients.length, message: "Check the recipient list. Up to 20 valid addresses are allowed." });
      return;
    }
    if (dependencies.fromAddress !== SUPPORT_FROM || !dependencies.providerConfigured()) {
      res.status(409).json({
        status: "rejected",
        recipientCount: recipients.length,
        message: `The support sender ${SUPPORT_FROM} is not ready. Check the configured sender address and email provider.`,
      });
      return;
    }

    const provider = isSmtpConfigured() ? "smtp" : "sendgrid";
    let attempt: ClaimResult;
    try {
      attempt = await dependencies.claimAttempt({
        requestId: parsed.data.requestId,
        senderId,
        payloadHash: payloadHash(recipients, parsed.data.subject.trim(), parsed.data.body),
        recipientCount: recipients.length,
        provider,
      });
    } catch {
      req.log.error("Could not reserve a communication email attempt");
      res.status(503).json({ status: "unknown", recipientCount: recipients.length, message: "The email could not be safely started. Refresh and check sent mail before retrying." });
      return;
    }
    if (!attempt.claimed) {
      if (attempt.status === "accepted") {
        res.json(SendCommunicationEmailResponse.parse({
          status: "accepted", recipientCount: recipients.length, message: "This email was already accepted; it was not sent again.",
        }));
        return;
      }
      res.status(409).json({
        status: "unknown",
        recipientCount: recipients.length,
        message: "This send attempt was already started or has an uncertain outcome. Check the support mailbox before trying again.",
      });
      return;
    }

    const subject = parsed.data.subject.trim();
    try {
      const result = await dependencies.send(
        SUPPORT_FROM,
        subject,
        parsed.data.body,
        {
          from: SUPPORT_FROM,
          fromName: "CSD Support",
          replyTo: SUPPORT_FROM,
          html: escapeHtml(parsed.data.body),
          bcc: recipients,
          operation: "communications",
        },
      );
      try {
        await dependencies.finishAttempt(attempt.id, "accepted", result.messageId);
      } catch {
        req.log.error({ attemptId: attempt.id }, "Accepted communication email could not be recorded");
        res.status(502).json({
          status: "unknown", recipientCount: recipients.length,
          message: "The provider may have accepted this email, but the result could not be recorded. Check the support mailbox before retrying.",
        });
        return;
      }
      res.status(201).json(SendCommunicationEmailResponse.parse({
        status: "accepted",
        recipientCount: recipients.length,
        message: "Accepted by the configured email provider. This does not confirm delivery to each inbox.",
      }));
    } catch (error) {
      const status = isProviderRejection(error) ? "rejected" : "unknown";
      try {
        await dependencies.finishAttempt(attempt.id, status, null);
      } catch {
        req.log.error({ attemptId: attempt.id }, "Communication email failure could not be recorded");
      }
      req.log.warn({ errorCode: errorCode(error), outcome: status }, "Support email submission failed");
      res.status(502).json({
        status,
        recipientCount: recipients.length,
        message: status === "unknown"
          ? "The email may have been accepted. Check the support mailbox before retrying."
          : "The email provider rejected this message. Fix the reported issue and try again.",
      });
    }
  });
}
