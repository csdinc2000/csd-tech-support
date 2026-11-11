import { db } from './db';
import { alerts, emergencyContacts, emergencyAlertLog, clients } from '@workspace/db';
import { eq, and } from 'drizzle-orm';
import { enqueueSlackNotification } from './slack-outbox';
import { dispatchBestEffortSlack } from './slack-dispatch';
import { sendSms, placeCall, isTwilioConfigured } from './twilio';

interface EmergencyContact {
  id: number;
  name: string;
  phone: string;
  email: string;
  role: string | null;
  priority: number | null;
  notificationMethods: string | null;
  availableHours: string | null;
}

interface EmergencyAlert {
  id: number;
  title: string;
  description: string;
  severity: string;
  category: string;
  deviceId?: number;
  clientId?: number;
  isEmergency: boolean;
  businessImpact: string;
}

export class EmergencyAlertService {
  /**
   * Process an alert and determine if emergency escalation is needed
   */
  async processAlert(alert: EmergencyAlert): Promise<void> {
    console.log(`Processing alert: ${alert.title} (Severity: ${alert.severity})`);

    // Determine if this requires emergency escalation
    const requiresEmergencyEscalation = this.shouldTriggerEmergencyAlert(alert);

    if (requiresEmergencyEscalation) {
      await this.triggerEmergencyAlert(alert);
    } else {
      await this.sendStandardAlert(alert);
    }
  }

  /**
   * Determine if alert should trigger emergency escalation
   */
  private shouldTriggerEmergencyAlert(alert: EmergencyAlert): boolean {
    // Critical severity always triggers emergency
    if (alert.severity === 'critical') {
      return true;
    }

    // High severity with high business impact
    if (alert.severity === 'high' && alert.businessImpact === 'high') {
      return true;
    }

    // Security category alerts with medium+ severity
    if (alert.category === 'security' && ['critical', 'high', 'medium'].includes(alert.severity)) {
      return true;
    }

    // Backup failure alerts
    if (alert.category === 'backup' && alert.severity !== 'low') {
      return true;
    }

    // Server down alerts
    if (alert.title.toLowerCase().includes('server') && alert.title.toLowerCase().includes('down')) {
      return true;
    }

    return alert.isEmergency || false;
  }

  /**
   * Trigger emergency alert escalation
   */
  async triggerEmergencyAlert(alert: EmergencyAlert): Promise<void> {
    console.log(`🚨 EMERGENCY ALERT: ${alert.title}`);

    try {
      // Get client information
      const client = alert.clientId ? await this.getClient(alert.clientId) : null;

      // Queue Slack immediately so later contact lookups or phone/email sends
      // cannot lose the team alert if this API process restarts.
      await this.sendSlackEmergencyNotification(alert, client);
      
      // Get emergency contacts for the client
      const contacts = alert.clientId ? await this.getEmergencyContacts(alert.clientId) : [];

      // Update alert as emergency
      await db.update(alerts)
        .set({ 
          isEmergency: true, 
          emergencyNotificationSent: true 
        })
        .where(eq(alerts.id, alert.id));

      // Send emergency notifications
      await this.sendEmergencyNotifications(alert, client, contacts);

      console.log(`Emergency alert processed for: ${alert.title}`);
    } catch (error) {
      console.error('Failed to process emergency alert:', error);
    }
  }

  /**
   * Send standard (non-emergency) alert
   */
  async sendStandardAlert(alert: EmergencyAlert): Promise<void> {
    try {
      const client = alert.clientId ? await this.getClient(alert.clientId) : null;
      
      // Persist the Slack side effect before returning. Delivery runs in the
      // background, so this does not wait for the Slack provider.
      await this.sendSlackStandardNotification(alert, client);

      console.log(`Standard alert processed for: ${alert.title}`);
    } catch (error) {
      console.error('Failed to process standard alert:', error);
    }
  }

  /**
   * Send emergency notifications via multiple channels
   */
  private async sendEmergencyNotifications(
    alert: EmergencyAlert, 
    client: any, 
    contacts: EmergencyContact[]
  ): Promise<void> {
    const emergencyMessage = this.buildEmergencyMessage(alert, client);

    // Sort contacts by priority
    const sortedContacts = contacts.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

    for (const contact of sortedContacts) {
      const methods = (contact.notificationMethods ?? '').split(',');

      for (const method of methods) {
        try {
          switch (method.trim()) {
            case 'phone':
              await this.sendEmergencyPhone(contact, emergencyMessage, alert.id);
              break;
            case 'sms':
              await this.sendEmergencySMS(contact, emergencyMessage, alert.id);
              break;
            case 'email':
              await this.sendEmergencyEmail(contact, emergencyMessage, alert.id);
              break;
          }
        } catch (error) {
          console.error(`Failed to send ${method} notification to ${contact.name}:`, error);
        }
      }
    }
  }

  /**
   * Send emergency phone call
   */
  private async sendEmergencyPhone(
    contact: EmergencyContact, 
    message: string, 
    alertId: number
  ): Promise<void> {
    // Place a real call via Twilio when the connector is wired; otherwise log.
    if (await isTwilioConfigured()) {
      try {
        // Speak the alert message twice with a pause between, then hang up.
        const safe = message.replace(/[<&>]/g, ' ');
        const twiml = `<Response><Say voice="alice">${safe}</Say><Pause length="2"/><Say voice="alice">${safe}</Say></Response>`;
        const result = await placeCall(contact.phone, twiml);
        await this.logNotificationAttempt(alertId, contact.id, 'phone', 'sent', result.sid);
        console.log(`📞 EMERGENCY CALL placed to ${contact.name} (${contact.phone}) — sid=${result.sid}`);
      } catch (err: any) {
        await this.logNotificationAttempt(alertId, contact.id, 'phone', 'failed', err.message);
        console.error(`📞 EMERGENCY CALL failed for ${contact.name}:`, err.message);
      }
    } else {
      await this.logNotificationAttempt(alertId, contact.id, 'phone', 'sent');
      console.log(`📞 MOCK EMERGENCY CALL to ${contact.name} (${contact.phone}): ${message}`);
    }
  }

  /**
   * Send emergency SMS
   */
  private async sendEmergencySMS(
    contact: EmergencyContact, 
    message: string, 
    alertId: number
  ): Promise<void> {
    if (await isTwilioConfigured()) {
      try {
        const result = await sendSms(contact.phone, message);
        await this.logNotificationAttempt(alertId, contact.id, 'sms', 'sent', result.sid);
        console.log(`📱 EMERGENCY SMS sent to ${contact.name} (${contact.phone}) — sid=${result.sid}`);
      } catch (err: any) {
        await this.logNotificationAttempt(alertId, contact.id, 'sms', 'failed', err.message);
        console.error(`📱 EMERGENCY SMS failed for ${contact.name}:`, err.message);
      }
    } else {
      await this.logNotificationAttempt(alertId, contact.id, 'sms', 'sent');
      console.log(`📱 MOCK EMERGENCY SMS to ${contact.name} (${contact.phone}): ${message}`);
    }
  }

  /**
   * Send emergency email
   */
  private async sendEmergencyEmail(
    contact: EmergencyContact, 
    message: string, 
    alertId: number
  ): Promise<void> {
    // Log the attempt
    await this.logNotificationAttempt(alertId, contact.id, 'email', 'sent');

    // In production, integrate with SendGrid, SES, or similar service
    if (process.env.SENDGRID_API_KEY || process.env.AWS_SES_REGION) {
      // Email service integration would go here
      console.log(`📧 EMERGENCY EMAIL to ${contact.name} (${contact.email}): ${message}`);
    } else {
      console.log(`📧 MOCK EMERGENCY EMAIL to ${contact.name} (${contact.email}): ${message}`);
    }
  }

  /**
   * Send Slack emergency notification
   */
  private async sendSlackEmergencyNotification(alert: EmergencyAlert, client: any): Promise<void> {
    const clientName = client?.name || 'Unknown Client';
    const deviceInfo = alert.deviceId ? `Device ID: ${alert.deviceId}` : 'System-wide';

    await dispatchBestEffortSlack(
      () => enqueueSlackNotification({
        type: "emergency",
        dedupeKey: `emergency-alert-${alert.id}`,
        emergencyAlertId: alert.id,
        payload: {
        channel: process.env.SLACK_CHANNEL_ID || "configured-channel",
        text: `🚨 EMERGENCY ALERT: ${alert.title}`,
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: '🚨 EMERGENCY ALERT 🚨'
            }
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*Client:* ${clientName}`
              },
              {
                type: 'mrkdwn',
                text: `*Severity:* ${alert.severity.toUpperCase()}`
              },
              {
                type: 'mrkdwn',
                text: `*Category:* ${alert.category}`
              },
              {
                type: 'mrkdwn',
                text: `*Device:* ${deviceInfo}`
              }
            ]
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Alert:* ${alert.title}\n*Description:* ${alert.description || 'No additional details'}`
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Business Impact:* ${alert.businessImpact || 'Unknown'}\n*Time:* ${new Date().toLocaleString()}`
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Acknowledge Alert'
                },
                style: 'danger',
                value: `acknowledge_${alert.id}`
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'View Dashboard'
                },
                url: `${process.env.REPLIT_DEV_DOMAIN || 'localhost:5000'}/dashboard`
              }
            ]
          }
        ]
        },
      }),
      "emergency",
      "await-enqueue",
    );
  }

  /**
   * Send Slack standard notification
   */
  private async sendSlackStandardNotification(alert: EmergencyAlert, client: any): Promise<void> {
    const clientName = client?.name || 'Unknown Client';
    const severityEmoji = this.getSeverityEmoji(alert.severity);

    await dispatchBestEffortSlack(
      () => enqueueSlackNotification({
        type: "device_alert",
        dedupeKey: `device-alert-${alert.id}`,
        emergencyAlertId: alert.id,
        payload: {
        channel: process.env.SLACK_CHANNEL_ID || "configured-channel",
        text: `${severityEmoji} Alert: ${alert.title}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${severityEmoji} *${alert.title}*\n${alert.description || 'No additional details'}`
            }
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Client: ${clientName} | Severity: ${alert.severity} | Category: ${alert.category}`
              }
            ]
          }
        ]
        },
      }),
      "device_alert",
      "await-enqueue",
    );
  }

  /**
   * Build emergency message text
   */
  private buildEmergencyMessage(alert: EmergencyAlert, client: any): string {
    const clientName = client?.name || 'Unknown Client';
    return `EMERGENCY ALERT for ${clientName}: ${alert.title}. ${alert.description || ''}. Severity: ${alert.severity}. Please respond immediately.`;
  }

  /**
   * Get severity emoji for Slack
   */
  private getSeverityEmoji(severity: string): string {
    switch (severity) {
      case 'critical': return '🔴';
      case 'high': return '🟠';
      case 'medium': return '🟡';
      case 'low': return '🟢';
      default: return 'ℹ️';
    }
  }

  /**
   * Get client information
   */
  private async getClient(clientId: number): Promise<any> {
    try {
      const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
      return client;
    } catch (error) {
      console.error('Failed to get client:', error);
      return null;
    }
  }

  /**
   * Get emergency contacts for a client
   */
  private async getEmergencyContacts(clientId: number): Promise<EmergencyContact[]> {
    try {
      const contacts = await db.select()
        .from(emergencyContacts)
        .where(and(
          eq(emergencyContacts.clientId, clientId),
          eq(emergencyContacts.isActive, true)
        ));
      
      return contacts;
    } catch (error) {
      console.error('Failed to get emergency contacts:', error as Error);
      return [];
    }
  }

  /**
   * Log notification attempt
   */
  private async logNotificationAttempt(
    alertId: number, 
    contactId: number | null, 
    method: string, 
    status: string, 
    errorMessage?: string
  ): Promise<void> {
    try {
      await db.insert(emergencyAlertLog).values({
        alertId,
        contactId,
        notificationMethod: method,
        status,
        attemptNumber: 1, // TODO: Implement retry logic
        errorMessage
      });
    } catch (error) {
      console.error('Failed to log notification attempt:', error);
    }
  }
}

// Singleton instance
export const emergencyAlertService = new EmergencyAlertService();