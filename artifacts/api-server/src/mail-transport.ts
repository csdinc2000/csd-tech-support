import nodemailer, { type Transporter } from "nodemailer";

export type OutboundMail = {
  to: string;
  bcc?: string[];
  from: { email: string; name?: string };
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
};

let smtpTransport: Transporter | undefined;
let smtpTransportKey = "";

function smtpSettings() {
  // Sending and receiving can live on different providers (for example an
  // SMTP relay for outbound while the cPanel mailbox still serves IMAP), so
  // the SMTP side reads its own vars first and falls back to the shared ones.
  const host = (process.env.CSD_SMTP_HOST || process.env.CSD_MAIL_HOST)?.trim();
  const user = (process.env.CSD_SMTP_USER || process.env.CSD_MAIL_USER)?.trim();
  const password = process.env.CSD_SMTP_PASSWORD || process.env.CSD_MAIL_PASSWORD;
  if (!host || !user || !password) return null;
  const port = Number(process.env.CSD_SMTP_PORT || process.env.CSD_MAIL_SMTP_PORT || process.env.CSD_MAIL_PORT || 465);
  return {
    host,
    user,
    password,
    port: Number.isInteger(port) && port > 0 ? port : 465,
    secure: String(process.env.CSD_MAIL_SMTP_SECURE || "").toLowerCase() === "true" || port === 465,
  };
}

export function isSmtpConfigured(): boolean {
  return smtpSettings() !== null;
}

type SmtpSender = Pick<Transporter, "sendMail">;
let smtpTransportOverride: SmtpSender | null = null;

export function __setSmtpTransportForTests(override: SmtpSender | null): void {
  smtpTransportOverride = override;
}

function getSmtpTransport(): SmtpSender {
  if (smtpTransportOverride) return smtpTransportOverride;
  const settings = smtpSettings();
  if (!settings) throw new Error("Mailbox SMTP is not configured");
  const key = `${settings.host}:${settings.port}:${settings.user}`;
  if (!smtpTransport || smtpTransportKey !== key) {
    smtpTransport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: { user: settings.user, pass: settings.password },
      tls: { servername: settings.host },
    });
    smtpTransportKey = key;
  }
  return smtpTransport;
}

const PLAIN_ADDRESS = /^[^\s<>@"]+@[^\s<>@"]+\.[^\s<>@"]+$/;

/**
 * Bare sender address for the From header. Accepts "Name <addr>" strings
 * (for example from an env var) and falls back to the SMTP login. Nodemailer
 * silently leaves out the From header when the address is empty or
 * malformed, and Gmail rejects such mail outright (550 5.7.1 "'From' header
 * is missing"), so this throws rather than send a headerless message.
 */
export function resolveSenderAddress(email: string | undefined | null): string {
  const candidates = [email, process.env.CSD_SMTP_USER, process.env.CSD_MAIL_USER];
  for (const candidate of candidates) {
    const raw = (candidate ?? "").trim();
    const address = (raw.match(/<([^<>]+)>\s*$/)?.[1] ?? raw).trim();
    if (PLAIN_ADDRESS.test(address)) return address;
  }
  throw new Error("Email not sent: no valid From address is configured");
}

export async function sendSmtpMail(message: OutboundMail): Promise<{ messageId: string | null }> {
  const address = resolveSenderAddress(message.from.email);
  const info = await getSmtpTransport().sendMail({
    to: message.to,
    bcc: message.bcc,
    // Callers use SendGrid's { email, name } shape; nodemailer needs
    // { address, name }. Passing { email } through left mail with no From
    // header and an empty envelope sender, so recipients rejected or
    // spam-filtered it.
    from: { address, name: message.from.name ?? "" },
    replyTo: message.replyTo,
    subject: message.subject,
    text: message.text,
    html: message.html,
    headers: message.headers,
  });
  return { messageId: info.messageId || null };
}