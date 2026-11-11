export type InvoiceEmailKind = "invoice" | "resend" | "reminder";

export type InvoiceEmailPayload = {
  publicUrl: string;
  invoiceNumber: string;
  clientName: string;
  totalCents: number;
  dueDate: string | null;
};

const usd = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[char]!);
}

export function renderInvoiceEmail(kind: InvoiceEmailKind, payload: InvoiceEmailPayload) {
  const reminder = kind === "reminder";
  const subject = reminder
    ? `Payment reminder: invoice ${payload.invoiceNumber}`
    : `Invoice ${payload.invoiceNumber} from Computer Systems Depot`;
  const intro = reminder
    ? `This is a friendly reminder that invoice ${payload.invoiceNumber} is overdue.`
    : `Your invoice ${payload.invoiceNumber} is ready.`;
  const due = payload.dueDate ? `Due date: ${payload.dueDate}` : "Payment is due upon receipt.";
  const text = [
    `Hello ${payload.clientName},`,
    "",
    intro,
    `Amount due: ${usd(payload.totalCents)}`,
    due,
    "",
    `View and pay securely: ${payload.publicUrl}`,
    "",
    "Thank you,",
    "Computer Systems Depot",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f5f2ed;font-family:Arial,sans-serif;color:#172436">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fffdfa;border:1px solid #ded6c9;border-radius:16px;overflow:hidden">
    <tr><td style="background:#172436;padding:24px 28px;color:#fffaf1"><strong style="font-size:20px">Computer Systems Depot</strong></td></tr>
    <tr><td style="padding:30px 28px"><p>Hello ${escapeHtml(payload.clientName)},</p><p>${escapeHtml(intro)}</p>
    <p style="font-size:28px;font-weight:700;margin:24px 0 4px">${escapeHtml(usd(payload.totalCents))}</p>
    <p style="color:#64748b;margin-top:0">${escapeHtml(due)}</p>
    <p style="margin:28px 0"><a href="${escapeHtml(payload.publicUrl)}" style="display:inline-block;background:#b21f32;color:white;text-decoration:none;padding:13px 20px;border-radius:8px;font-weight:700">View and pay invoice</a></p>
    <p style="font-size:13px;color:#64748b">For your security, use the private payment link above rather than forwarding this email.</p>
    </td></tr></table></td></tr></table></body></html>`;
  return { subject, text, html };
}

export function retryDelayMs(attempt: number): number {
  return Math.min(24 * 60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}

export function invoiceEmailDeliveryError(error: unknown): string {
  const providerErrors = (error as any)?.response?.body?.errors;
  if (Array.isArray(providerErrors)) {
    const messages = providerErrors
      .map((entry) => typeof entry?.message === "string" ? entry.message.trim() : "")
      .filter(Boolean);
    if (messages.length) return messages.join("; ").slice(0, 2000);
  }
  const message = (error as any)?.message;
  return String(message || "Email delivery failed").slice(0, 2000);
}

export function reminderScheduledAt(dueDate: string, daysAfterDue: number): Date {
  // PostgreSQL DATE values can arrive as either YYYY-MM-DD or an ISO timestamp
  // depending on the driver/type parser. Always schedule from the calendar date.
  const calendarDate = String(dueDate).slice(0, 10);
  const scheduledAt = new Date(`${calendarDate}T13:00:00Z`);
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new Error("Invoice due date is invalid");
  }
  scheduledAt.setUTCDate(scheduledAt.getUTCDate() + daysAfterDue);
  return scheduledAt;
}