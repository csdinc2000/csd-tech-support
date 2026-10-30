import { createHash } from "node:crypto";
import type { Express } from "express";
import { getTwilioClient, listTwilioChildCalls } from "./twilio";
import { getTwilioSettings, listCallForwardingOutcomes } from "./twilio-settings-storage";
import { getCallForwardingReadContext } from "./twilio-tracking-storage";
import { toValidE164 } from "./phone-validation";
import { configuredForwardTargets, withVoiceRoutingDeadline } from "./voice-routing";
import { logger } from "./lib/logger";
import { getStaffAssignmentScope } from "./staff-access";

type Call = {
  sid: string; parentCallSid: string | null; status: string; direction: string; to: string;
};
export type RingingCallReader = {
  list: () => Promise<Call[]>;
  parent: (sid: string) => Promise<Call>;
};

type RingingCallSource = {
  reader: RingingCallReader;
  businessNumber: string;
};

type IncomingCallAlertOptions = {
  loadRingingCallSource?: () => Promise<RingingCallSource>;
};

type ForwardingLeg = {
  sid: string;
  to: string;
  status: string;
  duration: number | null;
  dateUpdated: string | null;
};

type SavedForwardingOutcome = {
  childCallSid: string;
  attemptKey: string;
  destinationNumber: string;
  humanAccepted: boolean;
};

export async function readForwardingCallOutcomes(
  reader: { list: () => Promise<ForwardingLeg[]> },
  targets: Array<{ key: string; number: string }>,
  saved: SavedForwardingOutcome[],
) {
  const children = await reader.list();
  return children.map((child) => {
    const normalizedTo = toValidE164(child.to);
    const stored = saved.find((outcome) => outcome.childCallSid === child.sid);
    const configured = targets.find((target) => toValidE164(target.number) === normalizedTo);
    return {
      destinationNumber: normalizedTo ?? "Unknown destination",
      attemptKey: stored?.attemptKey ?? configured?.key ?? "other",
      providerStatus: [
        "queued", "initiated", "ringing", "in-progress", "completed",
        "no-answer", "busy", "failed", "canceled",
      ].includes(child.status) ? child.status : "unknown",
      providerDurationSeconds: child.duration,
      providerUpdatedAt: child.dateUpdated,
      humanAccepted: stored?.humanAccepted ?? null,
      audibleHandsetRingingConfirmed: false,
    };
  });
}

/** Only live forwarded legs of our inbound business line count as ringing.
 * No caller identities or provider credentials are returned to staff.
 */
export async function readRingingCalls(reader: RingingCallReader, businessNumber: string) {
  const business = toValidE164(businessNumber);
  if (!business) throw new Error("Business number is not configured");
  const legs = await reader.list();
  const parentIds = [...new Set(legs
    .filter(call => call.status === "ringing" && call.direction === "outbound-dial" && call.parentCallSid)
    .map(call => call.parentCallSid!))];
  const parents = await Promise.all(parentIds.map(id => reader.parent(id)));
  return parents
    .filter(call => call.direction === "inbound"
      && ["ringing", "in-progress"].includes(call.status)
      && toValidE164(call.to) === business)
    .map(call => ({ id: createHash("sha256").update(call.sid).digest("hex").slice(0, 24) }));
}

export function registerIncomingCallAlerts(
  app: Express,
  options: IncomingCallAlertOptions = {},
) {
  // Mounted after the shared signed-in, approved Communications feature gate.
  // Share reads between tabs/staff; never serve stale ringing after a failure.
  type RingStatus = { ringing: Array<{ id: string }>; checkedAt: string };
  let cached: RingStatus | null = null;
  let expires = 0;
  let pending: Promise<RingStatus> | null = null;
  const loadRingingCallSource = options.loadRingingCallSource ?? (async () => {
    const [client, settings] = await Promise.all([getTwilioClient(), getTwilioSettings()]);
    return {
      businessNumber: settings.twilioPhoneNumber,
      reader: {
        list: () => client.calls.list({ status: "ringing", limit: 100 }),
        parent: (sid: string) => client.calls(sid).fetch(),
      },
    };
  });

  app.get("/api/twilio/ringing-calls", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (!cached || Date.now() >= expires) {
        if (!pending) {
          pending = withVoiceRoutingDeadline((async () => {
            const source = await loadRingingCallSource();
            const ringing = await readRingingCalls(source.reader, source.businessNumber);
            return { ringing, checkedAt: new Date().toISOString() };
          })(), 3000).then(result => {
            cached = result;
            expires = Date.now() + 2500;
            return result;
          }).finally(() => { pending = null; });
        }
        await pending;
      }
      res.json(cached);
    } catch {
      cached = null;
      logger.warn("Incoming-call ring status unavailable");
      res.status(503).json({ error: "Live call status is unavailable. Phone forwarding is independent of this alert." });
    }
  });

  app.get("/api/call-tracking/calls/:id/forwarding-outcomes", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const callIdText = req.params.id;
    if (!/^[1-9]\d*$/.test(callIdText)) {
      return res.status(404).json({ error: "Call not found" });
    }
    try {
      const call = await getCallForwardingReadContext(Number(callIdText));
      if (!call || call.direction !== "inbound") {
        return res.status(404).json({ error: "Call not found" });
      }
      const scope = await getStaffAssignmentScope(req);
      const explicitlyAssignedContact =
        call.contactId !== null && scope.contactIds.has(call.contactId);
      const assignedCustomer =
        call.clientId !== null && scope.clientIds.has(call.clientId);
      if (
        !scope.unrestricted &&
        ((call.contactId !== null && !explicitlyAssignedContact && !assignedCustomer) ||
          (call.contactId === null && call.clientId !== null && !assignedCustomer))
      ) {
        return res.status(404).json({ error: "Call not found" });
      }

      const [settings, saved] = await Promise.all([
        getTwilioSettings(),
        listCallForwardingOutcomes(call.callSid),
      ]);
      const outcomes = await withVoiceRoutingDeadline(readForwardingCallOutcomes({
        list: () => listTwilioChildCalls(call.callSid),
      }, configuredForwardTargets(settings), saved), 3000);
      return res.json({
        outcomes,
        interpretation:
          "Twilio ringing and connected statuses describe provider call progress, not audible handset ringing. Human acceptance is confirmed only when the destination pressed 1.",
      });
    } catch {
      logger.warn("Forwarded call outcome lookup unavailable");
      return res.status(503).json({ error: "Forwarding outcomes are unavailable right now" });
    }
  });
}
