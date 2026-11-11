import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

// Deliberately separate from CSD_MAIL_*: configuring Aria must not start the
// helpdesk worker, mark incoming messages read, or trigger automatic replies.
export function ariaMailSettings() {
  const host = process.env.ARIA_MAIL_HOST?.trim();
  const user = process.env.ARIA_MAIL_USER?.trim();
  const pass = process.env.ARIA_MAIL_PASSWORD;
  return host && user && pass ? { host, user, pass } : null;
}

function client() {
  const settings = ariaMailSettings();
  if (!settings) throw new Error("Aria mailbox is not configured");
  return new ImapFlow({
    host: settings.host, port: 993, secure: true,
    auth: { user: settings.user, pass: settings.pass },
    logger: false, connectionTimeout: 15_000, greetingTimeout: 15_000,
    socketTimeout: 30_000, tls: { rejectUnauthorized: true },
  });
}

export function ariaSmtp() {
  const settings = ariaMailSettings();
  if (!settings) throw new Error("Aria mailbox is not configured");
  return nodemailer.createTransport({
    host: settings.host, port: 465, secure: true,
    auth: { user: settings.user, pass: settings.pass },
    tls: { rejectUnauthorized: true, servername: settings.host },
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    disableFileAccess: true, disableUrlAccess: true,
  });
}

async function withInbox<T>(run: (imap: ImapFlow) => Promise<T>, folder = "INBOX"): Promise<T> {
  const imap = client();
  imap.on("error", () => { /* errors propagate through pending operations; never log credentials */ });
  try {
    await imap.connect();
    const lock = await imap.getMailboxLock(folder, { readOnly: true });
    try { return await run(imap); } finally { lock.release(); }
  } finally {
    try { await imap.logout(); } catch { imap.close(); }
  }
}

export async function listAriaMailFolders() {
  return withInbox(async imap => (await imap.list()).map(folder => ({ path: folder.path, specialUse: folder.specialUse })));
}

export async function searchAriaMail(query: string, unread = false, folder = "INBOX") {
  return withInbox(async (imap) => {
    const uids = await imap.search({ ...(query ? { text: query } : { all: true }), ...(unread ? { seen: false } : {}) }, { uid: true });
    const selected = (uids || []).slice(-20).reverse();
    if (!selected.length) return [];
    const messages = [];
    for await (const message of imap.fetch(selected, { envelope: true, uid: true, flags: true, size: true }, { uid: true })) {
      messages.push({
        folder, uid: message.uid, uidValidity: String(imap.mailbox && imap.mailbox.uidValidity),
        subject: message.envelope?.subject, from: message.envelope?.from,
        to: message.envelope?.to, date: message.envelope?.date,
        unread: !message.flags?.has("\\Seen"), size: message.size,
      });
    }
    return messages.sort((a, b) => b.uid - a.uid);
  }, folder);
}

export async function readAriaMail(uid: number, uidValidity: string, folder = "INBOX") {
  return withInbox(async (imap) => {
    if (!imap.mailbox || String(imap.mailbox.uidValidity) !== uidValidity) {
      throw new Error("Mailbox changed. Search again before reading this message.");
    }
    const metadata = await imap.fetchOne(uid, { size: true }, { uid: true });
    if (!metadata) throw new Error("Message not found");
    if (!metadata.size || metadata.size > 2_000_000) throw new Error("Message exceeds the 2 MB read limit");
    const message = await imap.fetchOne(uid, { source: true }, { uid: true });
    if (!message || !message.source) throw new Error("Message not found");
    const parsed = await simpleParser(message.source, { skipImageLinks: true, skipHtmlToText: true });
    return {
      uid, subject: parsed.subject, from: parsed.from?.text, to: parsed.to,
      date: parsed.date, messageId: parsed.messageId,
      text: (parsed.text || "No plain-text body is available. Open the message in webmail.").slice(0, 24_000),
      attachments: parsed.attachments.map(a => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
    };
  }, folder);
}

export async function testAriaMail() {
  const results = await Promise.all([
    withInbox(async () => undefined),
    (async () => { const smtp = ariaSmtp(); try { await smtp.verify(); } finally { smtp.close(); } })(),
  ].map(promise => promise.then(() => ({ ok: true })).catch(() => ({
    ok: false, error: "Secure connection or authentication failed. Check the mailbox settings and password.",
  }))));
  return { imap: results[0], smtp: results[1] };
}