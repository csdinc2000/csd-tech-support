import { ReplitConnectors } from "@replit/connectors-sdk";
import type { ChatPostMessageArguments } from "@slack/web-api";
import { recordSlackDeliveryOutcome } from "./slack-delivery-health";
import { enqueueSlackNotification, type SlackNotificationType } from "./slack-outbox";
import { randomUUID } from "node:crypto";
import { dispatchBestEffortSlack } from "./slack-dispatch";
import { logger } from "./lib/logger";

if (!process.env.SLACK_CHANNEL_ID) {
  console.warn("SLACK_CHANNEL_ID environment variable not set - Slack features will be disabled");
}

const connectors = new ReplitConnectors();

type SlackPostMessageResponse = {
  ok: boolean;
  ts?: string;
  error?: string;
};

export type SlackDeliveryResult =
  | { delivered: true; timestamp?: string }
  | { delivered: false; reason: "not_configured" | "http_error" | "slack_error" | "transport_error" | "timeout"; code?: string };

const SLACK_DELIVERY_TIMEOUT_MS = 5_000;

type SlackProxy = (
  service: string,
  path: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

let slackProxy: SlackProxy = (service, path, init) =>
  connectors.proxy(service, path, init) as ReturnType<SlackProxy>;

export function __setSlackProxyForTests(proxy?: SlackProxy): void {
  slackProxy = proxy ?? ((service, path, init) =>
    connectors.proxy(service, path, init) as ReturnType<SlackProxy>);
}

export function isSlackConfigured(): boolean {
  return Boolean(process.env.SLACK_CHANNEL_ID);
}

export async function queueStaffMeetingNotification(input: {
  eventId: string;
  summary: string;
  startIso: string;
  timezone: string;
  provider: "google_meet" | "zoom";
  joinUrl: string | null;
  eventUrl: string | null;
  staffInvited: number;
}): Promise<boolean> {
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!channel) return false;

  const when = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: input.timezone,
  }).format(new Date(input.startIso));
  const platform = input.provider === "zoom" ? "Zoom" : "Google Meet";
  const joinLink = input.joinUrl
    ? `<${input.joinUrl}|Join ${platform}>`
    : `${platform} link is still being prepared; open the Calendar event for updates.`;
  const eventLink = input.eventUrl ? `\n<${input.eventUrl}|Open Calendar event>` : "";
  const text = `*${input.summary.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char] || char)}*\nWhen: ${when}\nInvited: ${input.staffInvited} staff\n${joinLink}${eventLink}`;

  try {
    await enqueueSlackNotification({
      type: "meeting",
      dedupeKey: `staff-meeting-${input.eventId}`,
      payload: { channel, text, unfurl_links: false, unfurl_media: false },
    });
    return true;
  } catch {
    return false;
  }
}

async function queueSlackMessage(
  type: SlackNotificationType,
  dedupeKey: string,
  payload: ChatPostMessageArguments,
  emergencyAlertId?: number,
): Promise<void> {
  await dispatchBestEffortSlack(
    () => enqueueSlackNotification({ type, dedupeKey, payload, emergencyAlertId }),
    type,
    "await-enqueue",
  );
}

/**
 * Sends a structured message to a Slack channel using the Slack Web API
 * @param message - Structured message to send
 * Slack delivery is best-effort. Failures are logged with sanitized metadata and
 * returned to callers that maintain notification-attempt history.
 */
async function sendSlackMessage(
  message: ChatPostMessageArguments
): Promise<SlackDeliveryResult> {
  const channel = process.env.SLACK_CHANNEL_ID;
  if (!channel) {
    console.warn("Slack channel is not configured; notification was not sent");
    const result = { delivered: false, reason: "not_configured" } as const;
    await recordSlackDeliveryOutcome(result);
    return result;
  }

  try {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutResult = new Promise<SlackDeliveryResult>((resolve) => {
      timeout = setTimeout(() => {
        console.error("[slack] chat.postMessage delivery failed", {
          reason: "timeout",
        });
        resolve({ delivered: false, reason: "timeout" });
      }, SLACK_DELIVERY_TIMEOUT_MS);
      timeout.unref?.();
    });
    const delivery = (async (): Promise<SlackDeliveryResult> => {
      const response = await slackProxy("slack", "/chat.postMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          ...message,
          channel,
        }),
      });

      const body = await response.json() as SlackPostMessageResponse;
      if (!response.ok) {
        console.error("[slack] chat.postMessage delivery failed", {
          reason: "http_error",
          status: response.status,
        });
        return { delivered: false, reason: "http_error", code: String(response.status) };
      }
      if (!body.ok) {
        const code = typeof body.error === "string" ? body.error : "unknown_error";
        console.error("[slack] chat.postMessage delivery failed", {
          reason: "slack_error",
          code,
        });
        return { delivered: false, reason: "slack_error", code };
      }
      return { delivered: true, timestamp: body.ts };
    })();
    const result = await Promise.race([delivery, timeoutResult]);
    if (timeout) clearTimeout(timeout);
    await recordSlackDeliveryOutcome(result);
    return result;
  } catch {
    // Do not log the thrown connector error: it can contain request details,
    // including notification text. The failure category is enough to operate on.
    console.error("[slack] chat.postMessage delivery failed", {
      reason: "transport_error",
    });
    const result = { delivered: false, reason: "transport_error" } as const;
    await recordSlackDeliveryOutcome(result);
    return result;
  }
}

/**
 * Send a new ticket notification to Slack
 */
function ticketNotificationMessage(ticket: any, client: any): ChatPostMessageArguments {
  const priorityEmoji = ticket.priority === 'high' ? '🔴' : ticket.priority === 'medium' ? '🟠' : '🟢';
  
  return {
    channel: process.env.SLACK_CHANNEL_ID || "configured-channel",
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
  };
}

export async function sendTicketNotification(ticket: any, client: any) {
  await sendSlackMessage(ticketNotificationMessage(ticket, client));
}

export async function queueTicketNotification(ticket: any, client: any): Promise<void> {
  try {
    await queueSlackMessage("ticket", `ticket-${ticket.id}`, ticketNotificationMessage(ticket, client));
  } catch {
    console.warn("[slack] ticket notification could not be prepared");
  }
}

/**
 * Send a device alert notification to Slack
 */
function deviceAlertMessage(alert: any, device: any): ChatPostMessageArguments {
  const severityEmoji = alert.severity === 'critical' ? '🚨' : alert.severity === 'warning' ? '⚠️' : 'ℹ️';
  
  return {
    channel: process.env.SLACK_CHANNEL_ID || "configured-channel",
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
  };
}

export async function sendDeviceAlert(alert: any, device: any) {
  await sendSlackMessage(deviceAlertMessage(alert, device));
}

export async function queueDeviceAlert(alert: any, device: any): Promise<void> {
  try {
    await queueSlackMessage(
      "device_alert",
      `device-alert-${alert.id ?? randomUUID()}`,
      deviceAlertMessage(alert, device),
      Number.isInteger(alert.id) ? alert.id : undefined,
    );
  } catch {
    console.warn("[slack] device-alert notification could not be prepared");
  }
}

/**
 * Send automation script completion notification
 */
function automationNotificationMessage(script: { name: string; type: string }, result: 'success' | 'failure', details?: string): ChatPostMessageArguments {
  const emoji = result === 'success' ? '✅' : '❌';
  
  return {
    channel: process.env.SLACK_CHANNEL_ID || "configured-channel",
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
  };
}

export async function queueAutomationNotification(
  eventKey: string,
  script: { name: string; type: string },
  result: 'success' | 'failure',
  details?: string,
): Promise<void> {
  try {
    await queueSlackMessage("automation", eventKey, automationNotificationMessage(script, result, details));
  } catch {
    // Never log message details, which may include script names or device IDs.
    logger.warn("[slack] automation notification could not be prepared");
  }
}

/**
 * Send daily summary to Slack
 */
export async function sendDailySummary(metrics: any) {
  await sendSlackMessage({
    channel: process.env.SLACK_CHANNEL_ID || "configured-channel",
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
    channel: process.env.SLACK_CHANNEL_ID || "configured-channel",
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

export async function queueLeadNotification(
  lead: {
    name: string;
    contact: string;
    service?: string;
    device?: string;
    issue?: string;
  },
  dedupeKey = `intake-${randomUUID()}`,
): Promise<void> {
  try {
    const payload: ChatPostMessageArguments = {
      channel: process.env.SLACK_CHANNEL_ID || "configured-channel",
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
    };
    await queueSlackMessage("intake", dedupeKey, payload);
  } catch {
    console.warn("[slack] intake notification could not be prepared");
  }
}

/**
 * Notify the team that a phone call came in (or was missed).
 * No-ops gracefully when Slack is not configured.
 */
function incomingCallMessage(call: {
  from: string;
  to?: string;
  location?: string;
  missed?: boolean;
}): ChatPostMessageArguments {
  const title = call.missed ? 'Missed call' : 'Incoming call';
  return {
    channel: process.env.SLACK_CHANNEL_ID || "configured-channel",
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
  };
}

export async function sendIncomingCallNotification(call: {
  from: string;
  to?: string;
  location?: string;
  missed?: boolean;
}) {
  await sendSlackMessage(incomingCallMessage(call));
}

export async function queueIncomingCallNotification(call: {
  from: string;
  to?: string;
  location?: string;
  missed?: boolean;
  eventId?: string;
}): Promise<void> {
  try {
    await queueSlackMessage(
      "call",
      `call-${call.eventId || randomUUID()}-${call.missed ? "missed" : "incoming"}`,
      incomingCallMessage(call),
    );
  } catch {
    console.warn("[slack] call notification could not be prepared");
  }
}

export { sendSlackMessage };
/** Speed to Lead: a new lead has waited past the first-contact target. */
export async function queueSpeedToLeadEscalation(input: {
  leadId: number;
  name: string;
  contact: string;
  service: string;
  waitingMinutes: number;
  targetMinutes: number;
}): Promise<void> {
  try {
    const text = `Lead waiting ${input.waitingMinutes} min (target ${input.targetMinutes}): ${input.name}`;
    await queueSlackMessage("intake", `speed-to-lead-${input.leadId}`, {
      channel: process.env.SLACK_CHANNEL_ID || "configured-channel",
      text,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*:rotating_light: Speed to Lead — nobody has contacted this lead yet*` } },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Name:* ${input.name}` },
            { type: "mrkdwn", text: `*Contact:* ${input.contact}` },
            { type: "mrkdwn", text: `*Service:* ${input.service}` },
            { type: "mrkdwn", text: `*Waiting:* ${input.waitingMinutes} min (target ${input.targetMinutes})` },
          ],
        },
      ],
    });
  } catch {
    logger.warn("[slack] speed-to-lead escalation could not be prepared");
  }
}
