import type { CsdIntakeRecord } from '@workspace/db';
import { logger } from './lib/logger';

// All mail goes through sendEmail (helpdesk-email.ts): SMTP or SendGrid per
// EMAIL_PROVIDER, with provider-capacity alerts. Imported lazily so the pure
// email builders below stay testable without loading storage.
async function sendEmail(...args: Parameters<typeof import('./helpdesk-email').sendEmail>) {
  const { sendEmail: send } = await import('./helpdesk-email');
  return send(...args);
}

const ADMIN_EMAIL = process.env.CSD_ADMIN_EMAIL || 'support@computersystemsdepot.com';
const FROM_EMAIL =
  process.env.MAIL_FROM ||
  process.env.CSD_FROM_EMAIL ||
  'no-reply@csdpro.com';
const FROM_NAME =
  process.env.MAIL_FROM_NAME ||
  process.env.CSD_FROM_NAME ||
  'Computer Systems Depot';


function appBaseUrl(): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(',')[0]}`;
  return process.env.APP_BASE_URL || 'http://localhost:5000';
}

// Escape user-supplied text before embedding it in an HTML email body —
// intake fields are public-form input, so without this an attacker could send
// trusted-domain HTML email with injected markup to any address.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Send email notification when new intake is submitted
 */
export async function sendIntakeNotificationEmail(intake: CsdIntakeRecord): Promise<void> {
  try {
    const serviceTypeDisplay = intake.serviceType === 'Other' 
      ? intake.serviceTypeOther || 'Other Service'
      : intake.serviceType;

    const emailContent = `
New Computer Systems Depot Service Request

Customer Information:
• Name: ${intake.customerName}
• Phone: ${intake.phoneNumber}
• Email: ${intake.emailAddress}
• Contact Preference: ${intake.contactPreference}

Service Details:
• Service Type: ${serviceTypeDisplay}
• Device Type: ${intake.deviceType}
• Device Brand/Model: ${intake.deviceBrandModel}
• Operating System: ${intake.operatingSystem}

Problem Description:
${intake.problemDescription}

Marketing Information:
• How did they hear about us: ${intake.howDidYouHear}
• Source: ${intake.source}
${intake.campaign ? `• Campaign: ${intake.campaign}` : ''}

Call Information:
• From active call: ${intake.isFromActiveCall ? 'Yes' : 'No'}
${intake.callId ? `• Call ID: ${intake.callId}` : ''}
${intake.callNotes ? `• Call Notes: ${intake.callNotes}` : ''}

Technical Information:
• Submitted: ${intake.createdAt?.toLocaleString() || 'Unknown'}
• IP Address: ${intake.ipAddress || 'Unknown'}
${intake.referrerUrl ? `• Referrer: ${intake.referrerUrl}` : ''}

View details: ${appBaseUrl()}/admin/intakes
    `.trim();

    await sendEmail(
      ADMIN_EMAIL,
      `New Service Request: ${intake.customerName} - ${serviceTypeDisplay}`,
      emailContent,
      {
        html: escapeHtml(emailContent).replace(/\n/g, '<br>'),
        from: FROM_EMAIL,
        fromName: FROM_NAME,
        replyTo: ADMIN_EMAIL,
        operation: 'intake',
      },
    );
    logger.info({ intakeId: intake.id }, 'Intake notification email sent');
  } catch (error) {
    logger.error({ err: error, intakeId: intake.id }, 'Failed to send intake notification email');
    // Don't throw - we don't want email failures to break intake submission
  }
}

export type CustomerConfirmationDetails = {
  /** Helpdesk ticket number, e.g. CSD-2026-0001. Also lets email replies thread into the ticket. */
  ticketNumber?: string | null;
  /** Link to the ticket in the customer portal (already carries the access token). */
  portalUrl?: string | null;
  /** The shop's phone number for urgent requests; the line is left out when unknown. */
  businessPhone?: string | null;
};

/** Pure text of the customer confirmation email, so it can be tested without sending. */
export function buildCustomerConfirmationEmail(intake: CsdIntakeRecord, details: CustomerConfirmationDetails = {}) {
  const serviceTypeDisplay = intake.serviceType === 'Other'
    ? intake.serviceTypeOther || 'Other Service'
    : intake.serviceType;
  const device = [intake.deviceType, intake.deviceBrandModel].filter(Boolean).join(' - ');
  const ticketNumber = details.ticketNumber?.trim() || null;
  const phone = details.businessPhone?.trim() || null;
  const lines = [
    `Hello ${intake.customerName},`,
    '',
    "Thank you for contacting Computer Systems Depot! We've received your service request and will contact you soon.",
    '',
    ...(ticketNumber ? [`Your ticket number: ${ticketNumber}`, ''] : []),
    'Your Request Summary:',
    `• Service Type: ${serviceTypeDisplay}`,
    ...(device ? [`• Device: ${device}`] : []),
    `• Contact Preference: ${intake.contactPreference}`,
    '',
    "What's Next:",
    "• We'll contact you within 24 hours during business hours",
    '• Please keep your device available for our technician',
    ...(details.portalUrl ? [`• Check your request status any time: ${details.portalUrl}`] : []),
    ...(phone ? [`• If it's urgent, call us at ${phone}`] : []),
    ...(ticketNumber ? ['• You can reply to this email; please keep the ticket number in the subject'] : []),
    '',
    'Thank you for choosing Computer Systems Depot for your IT needs!',
    '',
    'Best regards,',
    'Computer Systems Depot Team',
  ];
  const text = lines.join('\n');
  return {
    subject: ticketNumber
      ? `Service request received - ${ticketNumber}`
      : 'Service Request Confirmation - Computer Systems Depot',
    text,
    html: escapeHtml(text).replace(/\n/g, '<br>'),
  };
}

/**
 * Confirmation email to the customer, sent through the shared mail transport
 * (SendGrid or SMTP, whichever is configured).
 */
export async function sendCustomerConfirmationEmail(
  intake: CsdIntakeRecord,
  details: CustomerConfirmationDetails = {},
): Promise<void> {
  if (!intake.emailAddress) return;
  try {
    const email = buildCustomerConfirmationEmail(intake, details);
    await sendEmail(intake.emailAddress, email.subject, email.text, {
      html: email.html,
      replyTo: ADMIN_EMAIL,
      operation: 'intake',
    });
    logger.info({ intakeId: intake.id }, 'Customer confirmation email sent');
  } catch (error) {
    logger.error({ err: error, intakeId: intake.id }, 'Failed to send customer confirmation email');
  }
}
