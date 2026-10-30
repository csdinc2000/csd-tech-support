import sgMail from '@sendgrid/mail';
import type { CsdIntakeRecord } from '@workspace/db';

// Configure SendGrid
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
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

const FROM_ADDRESS = { email: FROM_EMAIL, name: FROM_NAME };

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
  if (!process.env.SENDGRID_API_KEY) {
    console.log('SendGrid not configured - intake notification email not sent');
    return;
  }

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

View details: ${process.env.REPLIT_DEV_DOMAIN || 'https://your-replit-app.repl.co'}/admin/intakes/${intake.id}
    `.trim();

    const msg = {
      to: ADMIN_EMAIL,
      from: FROM_ADDRESS,
      replyTo: ADMIN_EMAIL,
      subject: `New Service Request: ${intake.customerName} - ${serviceTypeDisplay}`,
      text: emailContent,
      html: escapeHtml(emailContent).replace(/\n/g, '<br>')
    };

    await sgMail.send(msg);
    console.log(`Intake notification email sent for intake #${intake.id}`);
  } catch (error) {
    console.error('Failed to send intake notification email:', error);
    // Don't throw - we don't want email failures to break intake submission
  }
}

/**
 * Send confirmation email to customer (optional)
 */
export async function sendCustomerConfirmationEmail(intake: CsdIntakeRecord): Promise<void> {
  if (!process.env.SENDGRID_API_KEY) {
    console.log('SendGrid not configured - customer confirmation email not sent');
    return;
  }
  if (!intake.emailAddress) return;

  try {
    const serviceTypeDisplay = intake.serviceType === 'Other' 
      ? intake.serviceTypeOther || 'Other Service'
      : intake.serviceType;

    const emailContent = `
Hello ${intake.customerName},

Thank you for contacting Computer Systems Depot! We've received your service request and will contact you soon.

Your Request Summary:
• Service Type: ${serviceTypeDisplay}
• Device: ${intake.deviceType} - ${intake.deviceBrandModel}
• Contact Preference: ${intake.contactPreference}

What's Next:
• We'll contact you within 24 hours during business hours
• Please keep your device available for our technician
• If urgent, call us directly at your business phone number

Reference Number: CSD-${intake.id}

Thank you for choosing Computer Systems Depot for your IT needs!

Best regards,
Computer Systems Depot Team
    `.trim();

    const msg = {
      to: intake.emailAddress,
      from: FROM_ADDRESS,
      replyTo: ADMIN_EMAIL,
      subject: `Service Request Confirmation - Computer Systems Depot`,
      text: emailContent,
      html: escapeHtml(emailContent).replace(/\n/g, '<br>')
    };

    await sgMail.send(msg);
    console.log(`Customer confirmation email sent for intake #${intake.id}`);
  } catch (error) {
    console.error('Failed to send customer confirmation email:', error);
  }
}

/**
 * Send SMS notification (for future Twilio integration)
 */
export async function sendIntakeSmsNotification(intake: CsdIntakeRecord): Promise<void> {
  // Placeholder for Twilio SMS integration
  // This can be implemented when SMS notifications are needed
  console.log(`SMS notification would be sent for intake #${intake.id}`);
}