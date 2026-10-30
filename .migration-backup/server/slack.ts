import { type ChatPostMessageArguments, WebClient } from "@slack/web-api"

// Check for required environment variables
if (!process.env.SLACK_BOT_TOKEN) {
  console.warn("SLACK_BOT_TOKEN environment variable not set - Slack features will be disabled");
}

if (!process.env.SLACK_CHANNEL_ID) {
  console.warn("SLACK_CHANNEL_ID environment variable not set - Slack features will be disabled");
}

const slack = process.env.SLACK_BOT_TOKEN ? new WebClient(process.env.SLACK_BOT_TOKEN) : null;

/**
 * Sends a structured message to a Slack channel using the Slack Web API
 * @param message - Structured message to send
 * @returns Promise resolving to the sent message's timestamp
 */
async function sendSlackMessage(
  message: ChatPostMessageArguments
): Promise<string | undefined> {
  if (!slack || !process.env.SLACK_CHANNEL_ID) {
    console.log("Slack not configured - would have sent:", (message as { text?: string }).text);
    return undefined;
  }

  try {
    const response = await slack.chat.postMessage({
      ...message,
      channel: process.env.SLACK_CHANNEL_ID,
    });
    return response.ts;
  } catch (error) {
    console.error('Error sending Slack message:', error);
    throw error;
  }
}

/**
 * Send a new ticket notification to Slack
 */
export async function sendTicketNotification(ticket: any, client: any) {
  const priorityEmoji = ticket.priority === 'high' ? '🔴' : ticket.priority === 'medium' ? '🟠' : '🟢';
  
  await sendSlackMessage({
    channel: process.env.SLACK_CHANNEL_ID!,
    text: `${priorityEmoji} New Support Ticket Created - ${ticket.subject}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${priorityEmoji} *New Support Ticket Created*`
        }
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Ticket ID:* #CSD-2024-${String(ticket.id).padStart(4, '0')}`
          },
          {
            type: 'mrkdwn',
            text: `*Priority:* ${ticket.priority.toUpperCase()}`
          },
          {
            type: 'mrkdwn',
            text: `*Client:* ${client?.name || 'Unknown'}`
          },
          {
            type: 'mrkdwn',
            text: `*Status:* ${ticket.status}`
          }
        ]
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Subject:* ${ticket.subject}\n*Description:* ${ticket.description || 'No description provided'}`
        }
      }
    ]
  });
}

/**
 * Send a device alert notification to Slack
 */
export async function sendDeviceAlert(alert: any, device: any) {
  const severityEmoji = alert.severity === 'critical' ? '🚨' : alert.severity === 'warning' ? '⚠️' : 'ℹ️';
  
  await sendSlackMessage({
    channel: process.env.SLACK_CHANNEL_ID!,
    text: `${severityEmoji} Device Alert - ${alert.title}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${severityEmoji} *Device Alert - ${alert.severity.toUpperCase()}*`
        }
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Device:* ${device?.name || 'Unknown'}`
          },
          {
            type: 'mrkdwn',
            text: `*Type:* ${device?.type || 'Unknown'}`
          },
          {
            type: 'mrkdwn',
            text: `*IP Address:* ${device?.ipAddress || 'Unknown'}`
          },
          {
            type: 'mrkdwn',
            text: `*Status:* ${device?.status || 'Unknown'}`
          }
        ]
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Alert:* ${alert.title}\n*Details:* ${alert.description || 'No additional details'}`
        }
      }
    ]
  });
}

/**
 * Send automation script completion notification
 */
export async function sendAutomationNotification(script: any, result: 'success' | 'failure', details?: string) {
  const emoji = result === 'success' ? '✅' : '❌';
  
  await sendSlackMessage({
    channel: process.env.SLACK_CHANNEL_ID!,
    text: `${emoji} Automation Script ${result === 'success' ? 'Completed' : 'Failed'} - ${script.name}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *Automation Script ${result === 'success' ? 'Completed' : 'Failed'}*`
        }
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Script:* ${script.name}`
          },
          {
            type: 'mrkdwn',
            text: `*Type:* ${script.type}`
          },
          {
            type: 'mrkdwn',
            text: `*Result:* ${result.toUpperCase()}`
          },
          {
            type: 'mrkdwn',
            text: `*Executed:* ${new Date().toLocaleString()}`
          }
        ]
      },
      ...(details ? [{
        type: 'section' as const,
        text: {
          type: 'mrkdwn' as const,
          text: `*Details:* ${details}`
        }
      }] : [])
    ]
  });
}

/**
 * Send daily summary to Slack
 */
export async function sendDailySummary(metrics: any) {
  await sendSlackMessage({
    channel: process.env.SLACK_CHANNEL_ID!,
    text: `📊 Daily RMM Summary - ${new Date().toLocaleDateString()}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `📊 *Daily RMM Summary - ${new Date().toLocaleDateString()}*`
        }
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Total Devices:* ${metrics.totalDevices}`
          },
          {
            type: 'mrkdwn',
            text: `*Active Alerts:* ${metrics.activeAlerts}`
          },
          {
            type: 'mrkdwn',
            text: `*Open Tickets:* ${metrics.openTickets}`
          },
          {
            type: 'mrkdwn',
            text: `*Resolved Today:* ${metrics.resolvedToday || 0}`
          }
        ]
      }
    ]
  });
}

/**
 * Notify the team that a new lead / intake came in.
 * No-ops gracefully when Slack is not configured.
 */
export async function sendLeadNotification(lead: {
  name: string;
  contact: string;
  service?: string;
  device?: string;
  issue?: string;
}) {
  await sendSlackMessage({
    channel: process.env.SLACK_CHANNEL_ID!,
    text: `New service request from ${lead.name}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*New service request*` } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Name:* ${lead.name}` },
          { type: 'mrkdwn', text: `*Contact:* ${lead.contact}` },
          ...(lead.service ? [{ type: 'mrkdwn' as const, text: `*Service:* ${lead.service}` }] : []),
          ...(lead.device ? [{ type: 'mrkdwn' as const, text: `*Device:* ${lead.device}` }] : []),
        ],
      },
      ...(lead.issue
        ? [{ type: 'section' as const, text: { type: 'mrkdwn' as const, text: `*Issue:* ${lead.issue}` } }]
        : []),
    ],
  });
}

/**
 * Notify the team that a phone call came in (or was missed).
 * No-ops gracefully when Slack is not configured.
 */
export async function sendIncomingCallNotification(call: {
  from: string;
  to?: string;
  location?: string;
  missed?: boolean;
}) {
  const title = call.missed ? 'Missed call' : 'Incoming call';
  await sendSlackMessage({
    channel: process.env.SLACK_CHANNEL_ID!,
    text: `${title} from ${call.from}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${title}*` } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*From:* ${call.from}` },
          ...(call.location ? [{ type: 'mrkdwn' as const, text: `*Location:* ${call.location}` }] : []),
          ...(call.to ? [{ type: 'mrkdwn' as const, text: `*Line:* ${call.to}` }] : []),
        ],
      },
    ],
  });
}

export { sendSlackMessage };