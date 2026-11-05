import sgMail from "@sendgrid/mail";
import { storage } from "./storage";
import type { Ticket, EmailTemplate, TicketDepartment } from "@workspace/db";
import { logger } from "./lib/logger";
import { isSmtpConfigured, sendSmtpMail } from "./mail-transport";
import {
  isEmailProviderCapacityError,
  recordEmailProviderCapacityFailure,
  resolveEmailProviderCapacityAlert,
  type EmailOperation,
  type EmailProvider,
} from "./email-provider-health";

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const FROM_EMAIL =
  process.env.MAIL_FROM ||
  process.env.CSD_FROM_EMAIL ||
  "no-reply@csdpro.com";
const FROM_NAME =
  process.env.MAIL_FROM_NAME ||
  process.env.CSD_FROM_NAME ||
  "Computer Systems Depot";
const ADMIN_EMAIL = process.env.CSD_ADMIN_EMAIL || "support@computersystemsdepot.com";

function buildFrom(email: string = FROM_EMAIL, name: string = FROM_NAME) {
  return { email, name };
}

function appBaseUrl(): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return process.env.APP_BASE_URL || "http://localhost:5000";
}

/** Customer portal link that opens this ticket directly (the ticket page reads these query parameters). */
export function ticketPortalUrl(ticket: Pick<Ticket, "id" | "ticketNumber" | "requesterEmail" | "accessToken">): string {
  return `${appBaseUrl()}/portal/ticket?ticket=${encodeURIComponent(ticket.ticketNumber || String(ticket.id))}&email=${encodeURIComponent(ticket.requesterEmail || "")}&token=${encodeURIComponent(ticket.accessToken || "")}`;
}

export interface TicketVariables {
  ticket: Ticket;
  department?: TicketDepartment | null;
  assigneeName?: string | null;
  messageBody?: string | null;
  responseTime?: string | null;
}

export function renderTemplate(tpl: { subject: string; body: string }, vars: TicketVariables): { subject: string; body: string } {
  const { ticket, department, assigneeName, messageBody, responseTime } = vars;
  const portalUrl = ticketPortalUrl(ticket);
  const replacements: Record<string, string> = {
    ticket_number: ticket.ticketNumber || `#${ticket.id}`,
    subject: ticket.subject || "",
    description: ticket.description || "",
    priority: ticket.priority || "",
    status: ticket.status || "",
    requester_name: ticket.requesterName || "there",
    requester_email: ticket.requesterEmail || "",
    portal_url: portalUrl,
    department_name: department?.name || "Support",
    assignee_name: assigneeName || "Unassigned",
    message_body: messageBody || "",
    response_time: responseTime || "soon",
    sla_due_at: ticket.slaDueAt ? new Date(ticket.slaDueAt).toLocaleString() : "n/a",
  };
  const replace = (s: string) =>
    s.replace(/{{\s*([a-z_]+)\s*}}/gi, (_, k) => replacements[k.toLowerCase()] ?? "");
  return { subject: replace(tpl.subject), body: replace(tpl.body) };
}

export type SendEmailResult = { messageId: string | null };

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  options: {
    html?: string;
    from?: string;
    fromName?: string;
    replyTo?: string;
    customArgs?: Record<string, string>;
    operation?: EmailOperation;
    bcc?: string[];
  } = {},
): Promise<SendEmailResult> {
  if (!process.env.SENDGRID_API_KEY) {
    if (!isSmtpConfigured()) throw new Error("Email delivery is not configured");
  }
  const message = {
    to,
    from: buildFrom(options.from, options.fromName),
    replyTo: options.replyTo || ADMIN_EMAIL,
    subject,
    text: body,
    html: options.html || body.replace(/\n/g, "<br>"),
    ...(options.bcc?.length ? { bcc: options.bcc } : {}),
  };
  if (isSmtpConfigured()) {
    return withCapacityTracking("smtp", options.operation, () => sendSmtpMail(message));
  }
  return withCapacityTracking("sendgrid", options.operation, async () => {
    const [response] = await sgMail.send({ ...message, customArgs: options.customArgs });
    return { messageId: response?.headers?.["x-message-id"] || null };
  });
}

// Whichever provider is in use, a quota/credit rejection raises the shared
// capacity alert (tagged with the operation) and a later success clears it.
async function withCapacityTracking(
  provider: EmailProvider,
  operation: EmailOperation | undefined,
  send: () => Promise<SendEmailResult>,
): Promise<SendEmailResult> {
  let result: SendEmailResult;
  try {
    result = await send();
  } catch (error) {
    if (isEmailProviderCapacityError(error)) {
      try {
        await recordEmailProviderCapacityFailure(operation ?? "helpdesk", provider);
      } catch (alertError) {
        logger.error({ error: alertError, provider }, "Email provider capacity alert could not be recorded");
      }
    }
    throw error;
  }
  try {
    await resolveEmailProviderCapacityAlert();
  } catch (alertError) {
    logger.error({ error: alertError, provider }, "Email provider capacity alert could not be resolved");
  }
  return result;
}

export async function sendTicketEmail(
  templateCode: string,
  to: string,
  vars: TicketVariables,
): Promise<void> {
  const tpl = await storage.getEmailTemplateByCode(templateCode);
  if (!tpl || !tpl.isActive) {
    logger.warn({ templateCode }, "Helpdesk email template not found or inactive");
    return;
  }
  const { subject, body } = renderTemplate(tpl, vars);
  const fromAddr = vars.department?.email || FROM_EMAIL;
  const fromName = vars.department?.email
    ? (vars.department?.name || FROM_NAME)
    : FROM_NAME;
  const replyTo = vars.department?.email || ADMIN_EMAIL;
  try {
    await sendEmail(to, subject, body, { from: fromAddr, fromName, replyTo });
  } catch (error) {
    logger.error({ error, templateCode, ticketId: vars.ticket.id }, "Helpdesk email send failed");
  }
}

export async function sendAutoresponder(ticket: Ticket): Promise<void> {
  const settings = await storage.getTicketSettings();
  if (settings && !settings.autoresponderEnabled) return;
  if (!ticket.requesterEmail) return;
  const dept = ticket.departmentId ? await storage.getTicketDepartment(ticket.departmentId) : null;
  if (dept && !dept.autoresponderEnabled) return;
  const sla = ticket.slaPlanId ? await storage.getSlaPlan(ticket.slaPlanId) : null;
  const responseTime = sla
    ? sla.responseTimeMinutes < 60
      ? `${sla.responseTimeMinutes} minutes`
      : `${Math.round(sla.responseTimeMinutes / 60)} hours`
    : "soon";
  await sendTicketEmail("ticket.autoreply", ticket.requesterEmail, {
    ticket,
    department: dept,
    responseTime,
  });
}

export async function sendStaffNotice(ticket: Ticket, to: string = ADMIN_EMAIL): Promise<void> {
  const dept = ticket.departmentId ? await storage.getTicketDepartment(ticket.departmentId) : null;
  await sendTicketEmail("ticket.staff_new", to, { ticket, department: dept });
}

export async function sendAssignmentNotice(ticket: Ticket, assigneeEmail: string, assigneeName?: string): Promise<void> {
  const dept = ticket.departmentId ? await storage.getTicketDepartment(ticket.departmentId) : null;
  await sendTicketEmail("ticket.assigned", assigneeEmail, {
    ticket,
    department: dept,
    assigneeName: assigneeName || null,
  });
}

export async function sendReplyNotice(ticket: Ticket, body: string): Promise<void> {
  if (!ticket.requesterEmail) return;
  const dept = ticket.departmentId ? await storage.getTicketDepartment(ticket.departmentId) : null;
  await sendTicketEmail("ticket.new_reply", ticket.requesterEmail, {
    ticket,
    department: dept,
    messageBody: body,
  });
}

export async function sendOverdueAlert(ticket: Ticket, to: string = ADMIN_EMAIL): Promise<void> {
  const dept = ticket.departmentId ? await storage.getTicketDepartment(ticket.departmentId) : null;
  await sendTicketEmail("ticket.overdue", to, { ticket, department: dept });
}

export async function sendResolvedNotice(ticket: Ticket): Promise<void> {
  if (!ticket.requesterEmail) return;
  const dept = ticket.departmentId ? await storage.getTicketDepartment(ticket.departmentId) : null;
  await sendTicketEmail("ticket.resolved", ticket.requesterEmail, { ticket, department: dept });
}
