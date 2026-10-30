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
  const host = process.env.CSD_MAIL_HOST?.trim();
  const user = process.env.CSD_MAIL_USER?.trim();
  const password = process.env.CSD_MAIL_PASSWORD;
  if (!host || !user || !password) return null;
  const port = Number(process.env.CSD_MAIL_SMTP_PORT || process.env.CSD_MAIL_PORT || 465);
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

export async function sendSmtpMail(message: OutboundMail): Promise<{ messageId: string | null }> {
  const info = await getSmtpTransport().sendMail({
    to: message.to,
    bcc: message.bcc,
    from: message.from,
    replyTo: message.replyTo,
    subject: message.subject,
    text: message.text,
    html: message.html,
    headers: message.headers,
  });
  return { messageId: info.messageId || null };
}