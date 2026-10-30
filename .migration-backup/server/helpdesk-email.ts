import sgMail from "@sendgrid/mail";
import { storage } from "./storage";
import type { Ticket, EmailTemplate, TicketDepartment } from "@shared/schema";

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

export interface TicketVariables {
  ticket: Ticket;
  department?: TicketDepartment | null;
  assigneeName?: string | null;
  messageBody?: string | null;
  responseTime?: string | null;
}

export function renderTemplate(tpl: { subject: string; body: string }, vars: TicketVariables): { subject: string; body: string } {
  const { ticket, department, assigneeName, messageBody, responseTime } = vars;
  const portalUrl = `${appBaseUrl()}/portal?ticket=${encodeURIComponent(ticket.ticketNumber || String(ticket.id))}&email=${encodeURIComponent(ticket.requesterEmail || "")}&token=${encodeURIComponent(ticket.accessToken || "")}`;
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

async function sendEmail(to: string, subject: string, body: string, from: string = FROM_EMAIL, fromName: string = FROM_NAME, replyTo: string = ADMIN_EMAIL) {
  if (!process.env.SENDGRID_API_KEY) {
    console.log(`[helpdesk-email] SendGrid not configured — would send to ${to}: ${subject}`);
    return;
  }
  try {
    await sgMail.send({
      to,
      from: buildFrom(from, fromName),
      replyTo,
      subject,
      text: body,
      html: body.replace(/\n/g, "<br>"),
    });
  } catch (err: any) {
    console.error("[helpdesk-email] send failed:", err?.message ?? err);
  }
}

export async function sendTicketEmail(
  templateCode: string,
  to: string,
  vars: TicketVariables,
): Promise<void> {
  const tpl = await storage.getEmailTemplateByCode(templateCode);
  if (!tpl || !tpl.isActive) {
    console.log(`[helpdesk-email] template "${templateCode}" not found or inactive`);
    return;
  }
  const { subject, body } = renderTemplate(tpl, vars);
  const fromAddr = vars.department?.email || FROM_EMAIL;
  const fromName = vars.department?.email
    ? (vars.department?.name || FROM_NAME)
    : FROM_NAME;
  const replyTo = vars.department?.email || ADMIN_EMAIL;
  await sendEmail(to, subject, body, fromAddr, fromName, replyTo);
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
