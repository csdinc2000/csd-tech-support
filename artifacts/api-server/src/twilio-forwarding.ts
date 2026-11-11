import type { Express, Request, Response } from "express";
import twilio from "twilio";
import { sendSms, toE164, toValidE164 } from "./twilio";
import {
  getTwilioSettings,
  createVoicemail,
  updateVoicemailByCallSid,
  upsertCallLog,
  markCallVoicemail,
  upsertCallForwardingOutcome,
  listCallForwardingOutcomes,
} from "./twilio-settings-storage";
import {
  getTrackingNumberByPhone,
  getCallFlow,
  createSmsMessage,
  updateSmsMessageStatus,
} from "./twilio-tracking-storage";
import { queueIncomingCallNotification } from "./slack";
import { getGreetingAudio, hasGreetingAudio } from "./greeting-store";
import { getActiveCallRecipientPhones, handleStaffInboundSms, recordSmsConsentState, enqueueStaffEventNotification } from "./staff-dispatch";
import { loadAppRingIdentities } from "./app-phone";
import {
  enqueueSmsForwardBroadcast,
  parseSmsForwardTargets,
} from "./sms-forward-outbox";
import { canonicalPublicAppBaseUrl } from "./shared/roip-config";
import { logger } from "./lib/logger";
import {
  customerLabel,
  ensureConversation,
  forwardBodyFor,
  internalThreadKeys,
  lookupContactName,
  parseRelayReply,
  relayStaffReply,
  threadKeyFor,
} from "./shared-inbox";
import { appendMainLineGreeting, emergencyVoiceResponse, forwardedCallerId, withVoiceRoutingDeadline, isMainBusinessLine, configuredForwardTargets, wasDialAnswered } from "./voice-routing";

function formatCallerForDisplay(num: string | undefined): string {
  if (!num) return "Unknown";
  const m = num.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : num;
}

// Alert the team the moment a call needs attention, so no caller slips through.
// Fire-and-forget — never blocks call routing. Used for calls that don't ring a
// person live (straight-to-voicemail / after-hours) and for forwarded calls the
// tech didn't pick up (missed). Answered calls are not alerted (their phone
// already rang). Recipient: CSD_CALL_ALERT_PHONE, else the voicemail-notify
// number. Disable entirely with CSD_CALL_ALERT_ENABLED=false.
async function alertTeamOfCall(
  settings: { voicemailNotifyNumber: string },
  opts: { kind: "incoming" | "missed"; from: string; to: string; location?: string; eventId?: string },
): Promise<void> {
  if (process.env.CSD_CALL_ALERT_ENABLED === "false") return;
  const fromDisp = formatCallerForDisplay(opts.from);
  const toDisp = formatCallerForDisplay(opts.to);
  const loc = opts.location ? ` (${opts.location})` : "";
  const recipient = process.env.CSD_CALL_ALERT_PHONE?.trim() || settings.voicemailNotifyNumber;

  if (recipient) {
    const body =
      opts.kind === "missed"
        ? `Missed call from ${fromDisp}${loc}. Please call them back.`
        : `Incoming call from ${fromDisp}${loc} on ${toDisp}.`;
    void sendSms(recipient, body)
      .then(() => console.log(`[call-alert] ${opts.kind} SMS sent to ${recipient}`))
      .catch((e) => console.error(`[call-alert] ${opts.kind} SMS failed:`, e?.message || e));
  }

  await queueIncomingCallNotification({
    from: fromDisp,
    to: toDisp,
    location: opts.location,
    missed: opts.kind === "missed",
    eventId: opts.eventId,
  });
}

function buildBaseUrl(req: Request): string {
  const configured = canonicalPublicAppBaseUrl(process.env.APP_BASE_URL);
  if (configured.ok) return configured.origin;
  const host = req.get("host");
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  return `${proto}://${host}`;
}

function isWithinBusinessHours(s: { businessHoursStart: string; businessHoursEnd: string; businessHoursTimezone: string; businessHoursDays?: string | null }): boolean {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: s.businessHoursTimezone,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date());
    const hh = parts.find((p) => p.type === "hour")?.value || "00";
    const mm = parts.find((p) => p.type === "minute")?.value || "00";
    const wk = parts.find((p) => p.type === "weekday")?.value || "Mon";
    // Map weekday short name to ISO day number (1=Mon … 7=Sun)
    const dayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    const todayIso = dayMap[wk] ?? 1;
    const allowedDays = (s.businessHoursDays || "1,2,3,4,5")
      .split(",")
      .map((d) => parseInt(d.trim(), 10))
      .filter((n) => !isNaN(n));
    if (!allowedDays.includes(todayIso)) return false;
    const now = `${hh}:${mm}`;
    return now >= s.businessHoursStart && now <= s.businessHoursEnd;
  } catch {
    return true;
  }
}

export function resolveLiveCallTargets(
  trackingForwardTo: string | null,
  rosterPhones: string[],
): string[] {
  return trackingForwardTo ? [trackingForwardTo] : rosterPhones;
}

// Unified inbound-SMS handler for BOTH the main business line and every call
// tracking number. Resolves the tracking number from the `To` field (null = main
// line), persists the inbound message, sends an auto-reply (per-number text when
// the tracking number configures one, otherwise the global auto-reply), and
// forwards the text to the owner's cell. Both /webhooks/sms/incoming and the
// legacy /webhooks/sms/tracking alias route through here so there is one code
// path and one Messages inbox.
export async function handleInboundSms(req: Request, res: Response): Promise<void> {
  const settings = await getTwilioSettings();
  const from = (req.body?.From as string) || "Unknown";
  const to = (req.body?.To as string) || "";
  const body = (req.body?.Body as string) || "";
  const numMedia = parseInt((req.body?.NumMedia as string) || "0", 10);
  const mediaNote = numMedia > 0 ? ` [${numMedia} attachment${numMedia === 1 ? "" : "s"} not forwarded]` : "";

  console.log(`[sms-inbound] From=${from} To=${to} characters=${body.length}`);

  // Resolve the tracking number this text hit (null → the main business line).
  let tracking: Awaited<ReturnType<typeof getTrackingNumberByPhone>> | null = null;
  try {
    tracking = await getTrackingNumberByPhone(to);
  } catch (e: any) {
    console.warn("[sms-inbound] tracking lookup failed:", e?.message || e);
  }

  // Persist inbound message so the Messages UI shows it (tagged with the line).
  try {
    await createSmsMessage({
      messageSid: (req.body?.MessageSid as string) || (req.body?.SmsMessageSid as string) || null,
      fromNumber: from,
      toNumber: to,
      body: body + (mediaNote || ""),
      direction: "inbound",
      status: "received",
      trackingNumberId: tracking?.id ?? null,
    } as any);
  } catch (e: any) {
    console.warn("[sms-inbound] inbound persistence failed:", e?.message || e);
  }

  // ── Compliance keywords (A2P 10DLC) ───────────────────────────────────────
  // The campaign registration promises that texting START fires an automated
  // confirmation identifying the business and restating STOP/HELP. Handle
  // START (and its aliases) and HELP explicitly here so that promise is always
  // true, regardless of whether the optional auto-reply setting is enabled.
  // STOP is intentionally not answered: Twilio enforces opt-out at the carrier
  // level and blocks replies to opted-out numbers.
  const keyword = body.trim().toUpperCase();
  const OPT_IN_KEYWORDS = ["START", "YES", "JOIN", "UNSTOP"];
  const HELP_KEYWORDS = ["HELP", "INFO"];
  const STOP_KEYWORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];
  const isOptInKeyword = OPT_IN_KEYWORDS.includes(keyword);
  const isHelpKeyword = HELP_KEYWORDS.includes(keyword);
  const isStopKeyword = STOP_KEYWORDS.includes(keyword);
  if (isOptInKeyword || isStopKeyword) {
    try {
      await recordSmsConsentState(from, isOptInKeyword);
    } catch (e: any) {
      console.error("[sms-consent] state update failed:", e?.message || e);
    }
  }
  const keywordReplyText = isOptInKeyword
    ? "Computer Systems Depot Inc.: You are opted in to recurring service update texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out."
    : isHelpKeyword
      ? "Computer Systems Depot: For help call 954-637-7300 or email support@computersystemsdepot.com. Reply STOP to unsubscribe."
      : null;

  // Compliance keywords always win. After that, authorized on-duty staff
  // commands are handled exactly once and never enter customer auto-reply or
  // owner-forwarding paths.
  const staffCommandsAreTrusted =
    !!process.env.TWILIO_AUTH_TOKEN ||
    (process.env.NODE_ENV !== "production" && process.env.TWILIO_SKIP_SIGNATURE_VERIFY === "1");

  // Reply-by-text relay: a technician answers a forwarded text from their own
  // cell with "#12 message" and it goes to that customer from the main line.
  // Checked before staff commands so the code is never read as a ticket claim.
  // Only phones that receive forwards can relay; a customer text that happens
  // to start with "#12" stays a normal customer message.
  const isForwardingPhone = parseSmsForwardTargets(settings.smsForwardNumbers, settings.smsForwardToNumber)
    .includes(toE164(from));
  const relay = !keywordReplyText && !isStopKeyword && staffCommandsAreTrusted && isForwardingPhone
    ? parseRelayReply(body)
    : null;
  if (relay && from) {
    let confirmation: string;
    try {
      confirmation = await relayStaffReply({ staffPhone: from, ...relay }, { sendSms: (to, text) => sendSms(to, text) });
    } catch (e: any) {
      console.error("[sms-relay] failed:", e?.message || e);
      confirmation = `Not sent: the reply to #${relay.conversationId} could not be processed. Use the Messages inbox.`;
    }
    const relayReply = new (twilio.twiml.MessagingResponse)();
    relayReply.message(confirmation);
    res.type("text/xml").send(relayReply.toString());
    return;
  }

  if (!keywordReplyText && !isStopKeyword && from && staffCommandsAreTrusted) {
    try {
      const inboundMessageSid =
        (req.body?.MessageSid as string) || (req.body?.SmsMessageSid as string) || undefined;
      const staffResult = await handleStaffInboundSms(from, body, inboundMessageSid);
      if (staffResult.handled) {
        const staffReply = new (twilio.twiml.MessagingResponse)();
        if (staffResult.reply) staffReply.message(staffResult.reply);
        res.type("text/xml").send(staffReply.toString());
        return;
      }
    } catch (e: any) {
      console.error("[staff-sms] command processing failed:", e?.message || e);
      // Fail open to the pre-existing customer flow. A database outage must not
      // cause an unknown/customer sender to be mistaken for staff.
    }
  }

  // Auto-reply: per-number text wins when configured, else the global auto-reply.
  const perNumberReply =
    tracking?.smsAutoReplyEnabled && tracking?.smsAutoReplyText ? tracking.smsAutoReplyText : null;
  const globalReply =
    settings.smsAutoReplyEnabled && settings.smsAutoReplyText ? settings.smsAutoReplyText : null;
  const autoReplyText = isStopKeyword ? null : (perNumberReply ?? globalReply);

  const reply = new (twilio.twiml.MessagingResponse)();
  const forwardTargets = parseSmsForwardTargets(
    settings.smsForwardNumbers,
    settings.smsForwardToNumber,
  );
  const normalizedFrom = toE164(from);
  const normalizedBusinessNumber = toE164(to);
  const isFromOwnNumber =
    forwardTargets.includes(normalizedFrom) ||
    normalizedFrom === normalizedBusinessNumber;

  // Shared inbox: a customer text (re)opens their conversation, and its id is
  // the "#code" technicians reply with. Internal phones never get one.
  let conversationId: number | null = null;
  if (!isFromOwnNumber && from) {
    try {
      const internal = await internalThreadKeys();
      if (!internal.has(threadKeyFor(from))) conversationId = (await ensureConversation(from, true)).id;
    } catch (e: any) {
      console.warn("[shared-inbox] conversation update failed:", e?.message || e);
    }
  }

  // Compliance keyword reply takes priority over the optional auto-reply so a
  // START/HELP text always gets exactly one automated response. The message is
  // still persisted and (below) forwarded to the owner like any other inbound.
  if (keywordReplyText && from) {
    reply.message(keywordReplyText);
    console.log(`[sms-keyword] ${keyword} from ${from} → automated ${isOptInKeyword ? "opt-in confirmation" : "help"} reply`);
    try {
      await createSmsMessage({
        messageSid: null,
        fromNumber: to,
        toNumber: from,
        body: keywordReplyText,
        direction: "outbound",
        status: "sent",
        trackingNumberId: tracking?.id ?? null,
      } as any);
    } catch (e: any) {
      console.warn("[sms-keyword] persist failed:", e?.message || e);
    }
  } else if (autoReplyText && from) {
    reply.message(autoReplyText);
    console.log(`[sms-autoreply] queued reply to ${from} (${perNumberReply ? "per-number" : "global"})`);
    try {
      await createSmsMessage({
        messageSid: null,
        fromNumber: to,
        toNumber: from,
        body: autoReplyText,
        direction: "outbound",
        status: "sent",
        trackingNumberId: tracking?.id ?? null,
      } as any);
    } catch (e: any) {
      console.warn("[sms-autoreply] persist failed:", e?.message || e);
    }
  } else {
    console.log(
      `[sms-autoreply] skipped (perNumber=${!!perNumberReply}, global=${!!globalReply}, from=${from})`,
    );
  }
  res.type("text/xml").send(reply.toString());

  // Queue one durable delivery per configured recipient. The outbox sends all
  // recipients concurrently, retries failures, and remains idempotent when
  // Twilio retries the inbound webhook.
  if (settings.smsForwardEnabled && !isFromOwnNumber && forwardTargets.length > 0) {
    const lineNote = tracking ? ` [to ${tracking.friendlyName || tracking.phoneNumber}]` : "";
    const contactName = await lookupContactName(from).catch(() => null);
    try {
      const inboundMessageSid =
        (req.body?.MessageSid as string) || (req.body?.SmsMessageSid as string) || "";
      await enqueueSmsForwardBroadcast({
        inboundMessageSid,
        sourceNumber: normalizedFrom,
        businessNumber: normalizedBusinessNumber,
        body: forwardBodyFor({
          conversationId,
          label: customerLabel(from, contactName),
          lineNote,
          body: `${body}${mediaNote}`,
        }),
        targets: forwardTargets,
      });
      console.log(`[sms-forward] queued ${forwardTargets.length} broadcast delivery job(s)`);
    } catch (e: any) {
      console.error("[sms-forward] queue FAILED:", e?.message || e);
    }
  } else if (isFromOwnNumber) {
    console.log(`[sms-forward] skipped (text was from admin's own cell)`);
  }
}

export async function persistSmsStatusCallback(
  messageSid: string,
  status: string,
  errorCode: string | null,
  proxyDeliveryId?: number,
  updater: typeof updateSmsMessageStatus = updateSmsMessageStatus,
  proxyDeliveryKind?: "sms-forward" | "staff-client",
): Promise<void> {
  if (proxyDeliveryKind) await updater(messageSid, status, errorCode, proxyDeliveryId, proxyDeliveryKind);
  else await updater(messageSid, status, errorCode, proxyDeliveryId);
}

export function registerTwilioForwarding(
  app: Express,
  dependencies: {
    getTwilioSettings?: typeof getTwilioSettings;
    getTrackingNumberByPhone?: typeof getTrackingNumberByPhone;
    getCallFlow?: typeof getCallFlow;
    upsertCallLog?: typeof upsertCallLog;
    getActiveCallRecipientPhones?: typeof getActiveCallRecipientPhones;
    /** Staff who answer in the app (browser); see app-phone.ts. */
    getAppRingIdentities?: typeof loadAppRingIdentities;
    alertTeamOfCall?: typeof alertTeamOfCall;
    notifyStaffEvent?: typeof enqueueStaffEventNotification;
    sendToVoicemail?: (twiml: twilio.twiml.VoiceResponse, settings: any, base: string) => Promise<void>;
    saveForwardingOutcome?: typeof upsertCallForwardingOutcome;
    loadForwardingOutcomes?: typeof listCallForwardingOutcomes;
  } = {},
): void {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const loadTwilioSettings = dependencies.getTwilioSettings ?? getTwilioSettings;
  const lookupTracking = dependencies.getTrackingNumberByPhone ?? getTrackingNumberByPhone;
  const loadFlow = dependencies.getCallFlow ?? getCallFlow;
  const saveCallLog = dependencies.upsertCallLog ?? upsertCallLog;
  const loadRecipients = dependencies.getActiveCallRecipientPhones ?? getActiveCallRecipientPhones;
  const loadAppRings = dependencies.getAppRingIdentities ?? loadAppRingIdentities;
  const renderVoicemail = dependencies.sendToVoicemail ?? sendToVoicemail;
  const notifyStaffEvent = dependencies.notifyStaffEvent ?? enqueueStaffEventNotification;
  const saveForwardingOutcome = dependencies.saveForwardingOutcome ?? upsertCallForwardingOutcome;
  const loadForwardingOutcomes = dependencies.loadForwardingOutcomes ?? listCallForwardingOutcomes;
  const notifyTeam = (...args: Parameters<typeof alertTeamOfCall>) => {
    void (dependencies.alertTeamOfCall ?? alertTeamOfCall)(...args)
      .catch(() => logger.warn("Inbound call notification failed; call routing continued"));
  };

  // ── INCOMING CALL ───────────────────────────────────────────────────────────
  async function handleIncomingVoice(req: Request, res: Response): Promise<void> {
    const base = buildBaseUrl(req);
    const twiml = new VoiceResponse();

    // Settings and the tracking-number lookup do not depend on each other, so
    // they run concurrently instead of stacking two webhook deadlines back to
    // back. Twilio always sends To; only the missing-To case has to wait for
    // settings before it can look anything up.
    const rawTo = (req.body?.To as string) || "";
    const settingsPromise = withVoiceRoutingDeadline(loadTwilioSettings());
    const earlyTracking = rawTo
      ? withVoiceRoutingDeadline(lookupTracking(rawTo)).catch((e) => {
          console.error("[tracking lookup]", e);
          return null;
        })
      : null;

    const settings = await settingsPromise;

    // Resolve tracking number (CallRail-style attribution). If the To number
    // matches a configured tracking number with a callFlowId, hand off to the
    // flow executor. Otherwise fall back to the global single-number forwarding.
    const toNumber = rawTo || settings.twilioPhoneNumber;
    // Answer before forwarding or entering any custom flow, for every caller.
    // No CRM membership, caller-ID or business-hours condition controls this.
    appendMainLineGreeting(twiml, toNumber);

    // The staff notification never shapes the TwiML, so it must not sit in
    // front of the caller on an open line. Fire it and move on.
    if (req.body?.CallSid) {
      void withVoiceRoutingDeadline(notifyStaffEvent({
        kind: "call", id: req.body.CallSid, businessNumber: settings.twilioPhoneNumber,
      })).catch(() => logger.warn("Incoming-call staff SMS queue failed; call routing continued"));
    }

    const configuredTargets = isMainBusinessLine(toNumber) ? configuredForwardTargets(settings) : [];
    let trackingId: number | null = null;
    let trackingChannel: string | null = null;
    let trackingKeywords: string | null = null;
    let trackingFlowId: number | null = null;
    let trackingForwardTo: string | null = null;
    const tn = earlyTracking
      ? await earlyTracking
      : await withVoiceRoutingDeadline(lookupTracking(toNumber)).catch((e) => {
          console.error("[tracking lookup]", e);
          return null;
        });
    if (tn && tn.active) {
      trackingId = tn.id;
      trackingChannel = tn.sourceChannel ?? null;
      trackingKeywords = tn.keywords ?? null;
      trackingFlowId = tn.callFlowId ?? null;
      trackingForwardTo = tn.forwardToNumber ?? null;
    }

    // Log the call (insert or refresh existing row by CallSid). Persistence
    // only, so it must never hold the caller waiting on a database write.
    void withVoiceRoutingDeadline(saveCallLog({
      callSid: (req.body?.CallSid as string) || `unknown-${Date.now()}`,
      fromNumber: (req.body?.From as string) || "Unknown",
      toNumber,
      fromCity: (req.body?.FromCity as string) || null,
      fromState: (req.body?.FromState as string) || null,
      fromCountry: (req.body?.FromCountry as string) || null,
      status: "ringing",
      direction: "inbound",
      durationSeconds: 0,
      hadVoicemail: false,
      trackingNumberId: trackingId,
      sourceChannel: trackingChannel,
      keywords: trackingKeywords,
    })).catch((e) => console.error("[call-log] insert failed:", e));

    // If this tracking number has a custom call flow, jump into the flow
    // executor immediately (skip the legacy single-number routing below).
    if (trackingFlowId && !configuredTargets.length) {
      const flow = await withVoiceRoutingDeadline(loadFlow(trackingFlowId)).catch(() => undefined);
      if (flow && Array.isArray(flow.steps) && (flow.steps as any[]).length > 0) {
        const fromNumber = (req.body?.From as string) || "";
        // Custom call flows handle their own routing, so alert the team here on
        // entry — otherwise tracked-number calls would get no immediate alert.
        notifyTeam(settings, {
          kind: "incoming",
          from: fromNumber || "Unknown",
          to: toNumber,
          location: [req.body?.FromCity, req.body?.FromState].filter(Boolean).join(", "),
          eventId: req.body?.CallSid as string,
        });
        twiml.redirect({ method: "POST" },
          `${base}/webhooks/voice/flow/${flow.id}/step/0?from=${encodeURIComponent(fromNumber)}&tn=${encodeURIComponent(toNumber)}`,
        );
        res.type("text/xml").send(twiml.toString());
        return;
      }
    }

    // 24/7 forwarding: always dial the owner regardless of business hours.
    // Business-hours enforcement is intentionally ignored here so inbound calls
    // never go straight to voicemail — they ring the forward-to number first and
    // only fall through to voicemail on no-answer (handled by dial-result).
    const action = "forward" as "forward" | "voicemail" | "sms_only";

    const incomingFrom = (req.body?.From as string) || "Unknown";
    const incomingLocation = [req.body?.FromCity, req.body?.FromState].filter(Boolean).join(", ");

    if (action === "voicemail" || (action === "forward" && !settings.callForwardingEnabled)) {
      // No live ring — tell the team right away so the caller isn't missed.
      notifyTeam(settings, { kind: "incoming", from: incomingFrom, to: toNumber, location: incomingLocation, eventId: req.body?.CallSid as string });
      // Straight to voicemail
      await withVoiceRoutingDeadline(renderVoicemail(twiml, settings, base));
    } else if (action === "sms_only") {
      notifyTeam(settings, { kind: "incoming", from: incomingFrom, to: toNumber, location: incomingLocation, eventId: req.body?.CallSid as string });
      twiml.say({ voice: settings.whisperVoice as any }, "Thank you for calling. Please send us a text message and we will respond shortly.");
      twiml.hangup();
    } else {
      // Forward — dial owner; if no answer, fall through to voicemail (if enabled)
      // IMPORTANT: setting callerId to the original caller's From number means the
      // forwarded phone shows who's actually calling, not your Twilio number.
      const fromNumber = (req.body?.From as string) || "";
      const callerId = forwardedCallerId(fromNumber, toNumber, settings.showCallerIdOnForward);
      // Tracking-number overrides remain single-target. Only the main global
      // route fans out to currently enabled, on-duty call recipients.
      const rosterPhones = trackingForwardTo || configuredTargets.length
        ? []
        : await withVoiceRoutingDeadline(loadRecipients()).catch((e) => {
            console.error("[staff-dispatch] call recipient lookup failed:", e);
            return [] as string[];
          });
      const callTargets = configuredTargets.length
        ? [configuredTargets[0].number]
        : resolveLiveCallTargets(trackingForwardTo, rosterPhones);
      const staffFanout = !configuredTargets.length && !trackingForwardTo;
      // Staff who chose "Ring me in the app" ring alongside the phones; first
      // to answer gets the call. A lookup failure never blocks the call.
      const appIdentities = await withVoiceRoutingDeadline(loadAppRings(), 700).catch(() => {
        logger.warn("App-ring staff lookup failed; ringing phones only");
        return [] as string[];
      });

      if (!callTargets.length && !appIdentities.length) {
        notifyTeam(settings, {
          kind: "incoming",
          from: incomingFrom,
          to: toNumber,
          location: incomingLocation,
          eventId: req.body?.CallSid as string,
        });
        if (settings.voicemailEnabled) {
          await withVoiceRoutingDeadline(renderVoicemail(twiml, settings, base));
        } else {
          twiml.hangup();
        }
        res.type("text/xml").send(twiml.toString());
        return;
      }
      const dial = twiml.dial({
        callerId,
        // Ring each target for the dial timeout set in Phone Settings. That
        // setting is authoritative; 5s is only a floor against a zeroed value.
        timeout: Math.max(settings.dialTimeoutSeconds || 25, 5),
        answerOnBridge: true,
        // Always route to dial-result so missed-call alerts fire even when
        // voicemail is disabled. dial-result handles the hangup vs. voicemail.
        action: `${base}/webhooks/voice/dial-result${configuredTargets.length
          ? `?attempt=${configuredTargets[0].key}&screened=1&destination=${encodeURIComponent(callTargets[0])}`
          : !trackingForwardTo
            ? "?route=staff&screened=1"
            : `?attempt=tracking&destination=${encodeURIComponent(callTargets[0])}`}`,
        method: "POST",
      });
      const numberOpts: any = {};
      if (settings.whisperEnabled || configuredTargets.length) {
        // Pass From through to the whisper webhook so it can announce the caller.
        const params = new URLSearchParams();
        if (fromNumber) params.set("from", fromNumber);
        if (configuredTargets.length) params.set("confirm", "1");
        if (configuredTargets.length && req.body?.CallSid) {
          params.set("attempt", configuredTargets[0].key);
          params.set("parent", String(req.body.CallSid));
          params.set("destination", callTargets[0]);
        } else if (trackingForwardTo && settings.whisperEnabled && req.body?.CallSid) {
          params.set("attempt", "tracking");
          params.set("parent", String(req.body.CallSid));
          params.set("destination", trackingForwardTo);
        }
        numberOpts.url = `${base}/webhooks/voice/whisper${params.toString() ? "?" + params.toString() : ""}`;
      }
      for (const target of callTargets) {
        const targetOptions = { ...numberOpts };
        if (staffFanout && req.body?.CallSid) {
          const context = new URLSearchParams({
            parent: String(req.body.CallSid),
            destination: target,
          });
          targetOptions.url = `${base}/webhooks/voice/whisper?from=${encodeURIComponent(fromNumber)}&confirm=1&route=staff&parent=${encodeURIComponent(String(req.body.CallSid))}&destination=${encodeURIComponent(target)}`;
          targetOptions.statusCallback = `${base}/webhooks/voice/staff-destination-status?${context.toString()}`;
          targetOptions.statusCallbackMethod = "POST";
          targetOptions.statusCallbackEvent = ["initiated", "ringing", "answered", "completed"];
        }
        dial.number(targetOptions, target);
      }
      for (const identity of appIdentities) {
        const client = dial.client();
        client.identity(identity);
        // The app shows who is calling; the leg's From is the caller ID above.
        client.parameter({ name: "caller", value: fromNumber });
        client.parameter({ name: "line", value: toNumber });
      }
      // Dial always has an action (dial-result) which handles missed-call alerts
      // and the hangup-vs-voicemail decision, so nothing more is needed here.
    }

    res.type("text/xml").send(twiml.toString());
  }

  app.post("/webhooks/voice/incoming", async (req: Request, res: Response) => {
    try {
      await handleIncomingVoice(req, res);
    } catch {
      logger.warn("Inbound voice routing failed; returning a greeting and voicemail fallback");
      res.type("text/xml").send(emergencyVoiceResponse(buildBaseUrl(req), (req.body?.To as string) || ""));
    }
  });

  // ── DIAL RESULT (only fires when <Dial action="..."> is set) ────────────────
  async function handleDialResult(req: Request, res: Response): Promise<void> {
    const settings = await withVoiceRoutingDeadline(loadTwilioSettings());
    const base = buildBaseUrl(req);
    const dialStatus = (req.body?.DialCallStatus as string) || "";
    const twiml = new VoiceResponse();

    const screened = req.query?.screened === "1";
    const attemptKey = (req.query?.attempt as string) || "primary";
    const destinationNumber = toValidE164((req.query?.destination as string) || "");
    const providerStatus = [
      "completed", "no-answer", "busy", "failed", "canceled", "in-progress",
      "ringing", "queued", "initiated",
    ].includes(dialStatus) ? dialStatus : "unknown";
    const parentCallSid = String(req.body?.CallSid || "");
    const childCallSid = String(req.body?.DialCallSid || "");
    let humanAccepted = false;
    if (
      screened &&
      req.query?.route !== "staff" &&
      /^CA[0-9a-f]{32}$/i.test(parentCallSid) &&
      /^CA[0-9a-f]{32}$/i.test(childCallSid)
    ) {
      try {
        const outcomes = await withVoiceRoutingDeadline(loadForwardingOutcomes(parentCallSid), 700);
        humanAccepted = outcomes.some((outcome) =>
          outcome.childCallSid === childCallSid && outcome.humanAccepted
        );
      } catch {
        logger.warn("Forwarding acceptance status could not be loaded");
      }
    }
    const accepted = humanAccepted || (screened && wasDialAnswered(dialStatus, req.body?.DialBridged, true));
    if (
      parentCallSid &&
      childCallSid &&
      /^CA[0-9a-f]{32}$/i.test(parentCallSid) &&
      /^CA[0-9a-f]{32}$/i.test(childCallSid) &&
      destinationNumber &&
      ["primary", "backup1", "backup2", "tracking"].includes(attemptKey) &&
      req.query?.route !== "staff"
    ) {
      try {
        await saveForwardingOutcome({
          parentCallSid,
          childCallSid,
          attemptKey: attemptKey as "primary" | "backup1" | "backup2" | "tracking",
          destinationNumber,
          providerStatus: providerStatus as any,
          humanAccepted: accepted,
        });
      } catch {
        logger.warn("Forwarding call outcome could not be saved");
      }
    }
    if (wasDialAnswered(dialStatus, req.body?.DialBridged, screened) || humanAccepted) {
      // Owner picked up and call ended normally — hang up cleanly.
      twiml.hangup();
      res.type("text/xml").send(twiml.toString());
      return;
    }
    // A roster fan-out is one complete attempt. Do not leak into the legacy
    // owner/backup chain after every on-duty recipient missed the call.
    const staffRoute = req.query?.route === "staff";

    // No answer on this attempt. Try the next configured number before falling
    // through to voicemail. Empty and duplicate numbers are skipped.
    const attempt = (req.query?.attempt as string) || "primary";
    const forwardTargets = configuredForwardTargets(settings);
    const currentIndex = Math.max(
      0,
      forwardTargets.findIndex((target) => target.key === attempt),
    );
    const previousNumbers = new Set(
      forwardTargets.slice(0, currentIndex + 1).map((target) => target.number).filter(Boolean),
    );
    const nextTarget = forwardTargets
      .slice(currentIndex + 1)
      .find((target) => target.number && !previousNumbers.has(target.number));

    if (nextTarget && !staffRoute) {
      const fromNumber = (req.body?.From as string) || "";
      const callerId = forwardedCallerId(fromNumber, (req.body?.To as string) || settings.twilioPhoneNumber, settings.showCallerIdOnForward);
      const dial = twiml.dial({
        callerId,
        timeout: Math.max(settings.dialTimeoutSeconds || 25, 5),
        answerOnBridge: true,
        action: `${base}/webhooks/voice/dial-result?attempt=${nextTarget.key}${screened ? "&screened=1" : ""}&destination=${encodeURIComponent(nextTarget.number)}`,
        method: "POST",
      });
      const numberOpts: any = {};
      if (settings.whisperEnabled || screened) {
        const params = new URLSearchParams();
        if (fromNumber) params.set("from", fromNumber);
        if (screened) params.set("confirm", "1");
        if (screened && req.body?.CallSid) {
          params.set("attempt", nextTarget.key);
          params.set("parent", String(req.body.CallSid));
          params.set("destination", nextTarget.number);
        }
        numberOpts.url = `${base}/webhooks/voice/whisper${params.toString() ? "?" + params.toString() : ""}`;
      }
      dial.number(numberOpts, nextTarget.number);
      console.log(`[voice] ${attempt} no-answer (${dialStatus}) — trying ${nextTarget.key}`);
    } else {
      // Nobody picked up — alert the team immediately to call the customer back.
      notifyTeam(settings, {
        kind: "missed",
        from: (req.body?.From as string) || "Unknown",
        to: (req.body?.To as string) || settings.twilioPhoneNumber,
        location: [req.body?.FromCity, req.body?.FromState].filter(Boolean).join(", "),
        eventId: req.body?.CallSid as string,
      });
      if (req.body?.CallSid) {
        await withVoiceRoutingDeadline(notifyStaffEvent({
          kind: "missed-call", id: req.body.CallSid, businessNumber: settings.twilioPhoneNumber,
        })).catch(() => logger.warn("Missed-call staff SMS queue failed; voicemail continued"));
      }
      // no-answer / busy / failed / canceled → voicemail
      if (settings.voicemailEnabled) {
        await withVoiceRoutingDeadline(renderVoicemail(twiml, settings, base));
      } else {
        twiml.hangup();
      }
    }
    res.type("text/xml").send(twiml.toString());
  }
  app.post("/webhooks/voice/dial-result", async (req: Request, res: Response) => {
    try {
      await handleDialResult(req, res);
    } catch {
      logger.warn("Dial continuation failed; returning voicemail fallback");
      res.type("text/xml").send(emergencyVoiceResponse(buildBaseUrl(req), (req.body?.To as string) || ""));
    }
  });

  app.post("/webhooks/voice/staff-destination-status", async (req: Request, res: Response) => {
    const parentCallSid = String(req.query?.parent || "");
    const childCallSid = String(req.body?.CallSid || "");
    const destinationNumber = toValidE164(String(req.query?.destination || ""));
    const rawStatus = String(req.body?.CallStatus || "").toLowerCase();
    const providerStatus = rawStatus === "answered"
      ? "in-progress"
      : [
          "completed", "no-answer", "busy", "failed", "canceled", "in-progress",
          "ringing", "queued", "initiated",
        ].includes(rawStatus) ? rawStatus : "unknown";

    if (
      !/^CA[0-9a-f]{32}$/i.test(parentCallSid) ||
      !/^CA[0-9a-f]{32}$/i.test(childCallSid) ||
      !destinationNumber
    ) {
      res.sendStatus(400);
      return;
    }
    try {
      await saveForwardingOutcome({
        parentCallSid,
        childCallSid,
        attemptKey: "staff",
        destinationNumber,
        providerStatus: providerStatus as any,
        humanAccepted: false,
      });
      res.sendStatus(204);
    } catch {
      logger.warn("Staff forwarding status could not be saved");
      res.sendStatus(503);
    }
  });

  async function sendToVoicemail(twiml: any, settings: any, base: string) {
    // Custom uploaded greeting (if any) takes precedence over the spoken text.
    if (await hasGreetingAudio()) {
      twiml.play(`${base}/webhooks/voice/greeting-audio`);
    } else {
      twiml.say({ voice: settings.voicemailGreetingVoice as any }, settings.voicemailGreeting);
    }
    twiml.record({
      action: `${base}/webhooks/voice/voicemail-recorded`,
      method: "POST",
      maxLength: settings.voicemailMaxLengthSeconds,
      playBeep: true,
      finishOnKey: "#",
      transcribe: settings.voicemailTranscriptionEnabled,
      transcribeCallback: settings.voicemailTranscriptionEnabled
        ? `${base}/webhooks/voice/voicemail-transcription`
        : undefined,
    });
    twiml.say({ voice: settings.voicemailGreetingVoice as any }, "We did not receive a recording. Goodbye.");
    twiml.hangup();
  }

  // ── WHISPER (played to the answerer before bridge) ─────────────────────────
  const whisperHandler = async (req: Request, res: Response) => {
    const twiml = new VoiceResponse();
    // Context for the technician only — the customer still sees the main line.
    // Bounded so a slow CRM lookup can't delay the bridge.
    const callerRaw = (req.query?.from as string) || (req.body?.From as string) || "";
    const callerName = callerRaw
      ? await withVoiceRoutingDeadline(lookupContactName(callerRaw), 1000).catch(() => null)
      : null;
    const spokenName = callerName?.replace(/[<>&]/g, " ").slice(0, 60) || null;
    if (req.query?.confirm === "1") {
      const acceptContext = new URLSearchParams();
      for (const key of ["route", "parent", "destination", "attempt"] as const) {
        const value = req.query?.[key];
        if (typeof value === "string") acceptContext.set(key, value);
      }
      const acceptUrl = `${buildBaseUrl(req)}/webhooks/voice/accept${
        acceptContext.size ? `?${acceptContext.toString()}` : ""
      }`;

      // The instruction comes first and the caller name second: the gather
      // window starts when the prompt starts, so a long name must never eat
      // the technician time to react.
      const prompt = spokenName
        ? `Press any key to take this C S D call from ${spokenName}.`
        : "Press any key to take this C S D call.";

      // Two gathers in sequence give a second chance with no extra webhook
      // round trip: an expired Gather falls through to the next verb. Only
      // the final one reports an empty result, so the server still learns a
      // leg was answered by someone who never accepted.
      const first = twiml.gather({
        numDigits: 1,
        timeout: 12,
        method: "POST",
        action: acceptUrl,
      });
      first.say({ voice: "alice" }, prompt);

      const second = twiml.gather({
        numDigits: 1,
        timeout: 6,
        method: "POST",
        action: acceptUrl,
        actionOnEmptyResult: true,
      });
      second.say({ voice: "alice" }, `Still there? ${prompt}`);

      twiml.hangup();
      res.type("text/xml").send(twiml.toString());
      return;
    }
const settings = await getTwilioSettings();
    // Announce the configured whisper text, then optionally read the caller's number
    // digit-by-digit so it's easy to understand over the phone.
    twiml.say({ voice: settings.whisperVoice as any }, settings.whisperText);
    if (settings.whisperAnnounceCaller && spokenName) {
      twiml.pause({ length: 1 });
      twiml.say({ voice: settings.whisperVoice as any }, `Call from customer ${spokenName}.`);
    } else if (settings.whisperAnnounceCaller) {
      const fromRaw = callerRaw;
      if (fromRaw) {
        // Strip non-digits, drop leading "1" for US numbers, then read each digit
        // with a brief pause so it's intelligible.
        const digits = fromRaw.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
        const spoken = digits.split("").join(" ");
        twiml.pause({ length: 1 });
        twiml.say({ voice: settings.whisperVoice as any }, `Call from ${spoken}.`);
      }
    }
    res.type("text/xml").send(twiml.toString());
  };
  app.post("/webhooks/voice/whisper", whisperHandler);
  app.get("/webhooks/voice/whisper", whisperHandler);
  app.post("/webhooks/voice/accept", async (req: Request, res: Response) => {
    const twiml = new VoiceResponse();
    // Any digit accepts. Requiring exactly "1" meant a fumbled keypress ended
    // the call instead of connecting it.
    const digits = String(req.body?.Digits ?? "").trim();
    const accepted = digits.length > 0;

    const parentCallSid = String(req.query?.parent || "");
    const childCallSid = String(req.body?.CallSid || "");
    const destinationNumber = toValidE164(String(req.query?.destination || ""));

    // Record the outcome either way, so "answered but never accepted" stops
    // being invisible in the forwarding telemetry.
    if (
      (req.query?.route === "staff" || ["primary", "backup1", "backup2", "tracking"].includes(String(req.query?.attempt || ""))) &&
      /^CA[0-9a-f]{32}$/i.test(parentCallSid) &&
      /^CA[0-9a-f]{32}$/i.test(childCallSid) &&
      destinationNumber
    ) {
      const attemptKey = req.query?.route === "staff"
        ? "staff"
        : String(req.query?.attempt) as "primary" | "backup1" | "backup2" | "tracking";
      await saveForwardingOutcome({
        parentCallSid,
        childCallSid,
        attemptKey,
        destinationNumber,
        providerStatus: "unknown",
        humanAccepted: accepted,
      }).catch(() => logger.warn("Staff call acceptance could not be saved"));
    }

    if (accepted) {
      twiml.say({ voice: "alice" }, "Connecting your call.");
    } else {
      twiml.hangup();
    }
    res.type("text/xml").send(twiml.toString());
  });

  // ── CUSTOM GREETING AUDIO (served to Twilio's <Play>) ──────────────────────
  // Public, unauthenticated GET so Twilio can fetch the uploaded greeting audio.
  app.get("/webhooks/voice/greeting-audio", async (_req: Request, res: Response) => {
    try {
      const audio = await getGreetingAudio();
      if (!audio) {
        res.status(404).send("No custom greeting");
        return;
      }
      res.setHeader("Content-Type", audio.contentType);
      res.setHeader("Cache-Control", "no-cache");
      res.send(audio.buf);
    } catch {
      res.status(500).send("Failed to load greeting");
    }
  });

  // ── VOICEMAIL: recording finished ──────────────────────────────────────────
  app.post("/webhooks/voice/voicemail-recorded", async (req: Request, res: Response) => {
    const settings = await getTwilioSettings();
    const callSid = (req.body?.CallSid as string) || "";
    const recordingSid = (req.body?.RecordingSid as string) || "";
    const recordingUrl = (req.body?.RecordingUrl as string) || "";
    const recordingDuration = parseInt((req.body?.RecordingDuration as string) || "0", 10);
    const from = (req.body?.From as string) || "";
    const to = (req.body?.To as string) || settings.twilioPhoneNumber;

    try {
      await createVoicemail({
        callSid,
        recordingSid,
        recordingUrl,
        durationSeconds: recordingDuration,
        fromNumber: from,
        toNumber: to,
        transcription: null,
        transcriptionStatus: settings.voicemailTranscriptionEnabled ? "pending" : "disabled",
        listened: false,
      });
      console.log(`[voicemail] saved sid=${recordingSid} from=${from} ${recordingDuration}s`);
      if (callSid) {
        try { await markCallVoicemail(callSid); } catch (e) { console.error("[call-log] mark voicemail failed:", e); }
      }
    } catch (e) {
      console.error("[voicemail] save failed:", e);
    }

    // Notify the owner via SMS that a voicemail was left
    try {
      const note = `New voicemail from ${formatCallerForDisplay(from)} (${recordingDuration}s). Listen: ${recordingUrl}.mp3`;
      await sendSms(settings.voicemailNotifyNumber, note);
    } catch (e) {
      console.error("[voicemail] notify SMS failed:", e);
    }

    const twiml = new VoiceResponse();
    twiml.say({ voice: settings.voicemailGreetingVoice as any }, "Thank you. Your message has been recorded. Goodbye.");
    twiml.hangup();
    res.type("text/xml").send(twiml.toString());
  });

  // ── VOICEMAIL: transcription callback ──────────────────────────────────────
  app.post("/webhooks/voice/voicemail-transcription", async (req: Request, res: Response) => {
    res.sendStatus(204);
    const callSid = (req.body?.CallSid as string) || "";
    const transcriptionText = (req.body?.TranscriptionText as string) || "";
    const transcriptionStatus = (req.body?.TranscriptionStatus as string) || "completed";

    try {
      await updateVoicemailByCallSid(callSid, {
        transcription: transcriptionText || null,
        transcriptionStatus: transcriptionStatus === "completed" ? "completed" : "failed",
      });
    } catch (e) {
      console.error("[voicemail] transcription save failed:", e);
    }

    if (transcriptionText) {
      try {
        const settings = await getTwilioSettings();
        await sendSms(
          settings.voicemailNotifyNumber,
          `Voicemail transcript: "${transcriptionText.slice(0, 1000)}"`,
        );
      } catch (e) {
        console.error("[voicemail] transcript SMS failed:", e);
      }
    }
  });

  // ── CALL STATUS (overall call status callback for post-call SMS) ───────────
  app.post("/webhooks/voice/status", async (req: Request, res: Response) => {
    res.sendStatus(204);

    const settings = await getTwilioSettings();
    const callStatus = (req.body?.CallStatus as string) || "";
    const direction = (req.body?.Direction as string) || "";
    const from = (req.body?.From as string) || "";
    const to = (req.body?.To as string) || settings.twilioPhoneNumber;
    const callSid = (req.body?.CallSid as string) || "";
    const duration = parseInt((req.body?.CallDuration as string) || "0", 10);

    console.log(`[voice-status] CallSid=${callSid} status=${callStatus} dir=${direction} from=${from}`);

    // Update the call log row with final status + duration
    if (callSid) {
      try {
        await upsertCallLog({
          callSid,
          fromNumber: from || "Unknown",
          toNumber: to,
          status: callStatus || "completed",
          direction: direction || "inbound",
          durationSeconds: duration,
          hadVoicemail: false,
        });
      } catch (e) {
        console.error("[call-log] status update failed:", e);
      }
    }

    if (!settings.postCallSmsEnabled) return;
    if (callStatus !== "completed") return;
    if (!direction.startsWith("inbound")) return;
    if (!from || from === settings.forwardToNumber) return;

    try {
      const result = await sendSms(from, settings.postCallSmsText);
      console.log(`[voice-status] post-call SMS sent to ${from} sid=${result.sid}`);
    } catch (e: any) {
      console.error("[voice-status] post-call SMS FAILED:", e?.message || e, e?.code ? `code=${e.code}` : "");
    }
  });

  // ── INCOMING SMS ───────────────────────────────────────────────────────────
  // Unified across the main line and all tracking numbers (see handleInboundSms).
  app.post("/webhooks/sms/incoming", handleInboundSms);

  // Twilio delivery-status callback for outbound SMS. Updates our local row
  // so the Messages UI shows queued → sent → delivered → failed and surfaces
  // any carrier error code.
  app.post("/webhooks/sms/status", async (req: Request, res: Response) => {
    const sid = (req.body?.MessageSid as string) || (req.body?.SmsSid as string) || "";
    const status = (req.body?.MessageStatus as string) || (req.body?.SmsStatus as string) || "";
    const errorCode = (req.body?.ErrorCode as string) || "";
    const proxyDeliveryId = Number(req.query.proxyDeliveryId);
    const proxyDeliveryKind = req.query.proxyDeliveryKind === "sms-forward" || req.query.proxyDeliveryKind === "staff-client"
      ? req.query.proxyDeliveryKind : undefined;
    if (!sid) {
      res.sendStatus(204);
      return;
    }
    console.log(`[sms-status] sid=${sid} status=${status}${errorCode ? ` err=${errorCode}` : ""}`);
    try {
      await persistSmsStatusCallback(
        sid,
        status,
        errorCode || null,
        Number.isSafeInteger(proxyDeliveryId) && proxyDeliveryId > 0 ? proxyDeliveryId : undefined,
        undefined,
        proxyDeliveryKind,
      );
      res.sendStatus(204);
    } catch (e: any) {
      console.warn("[sms-status] update failed:", e?.message || e);
      res.status(500).type("text/plain").send("Status persistence failed");
    }
  });

  // Diagnostic: ask Twilio for the actual delivery status of recent messages.
  // Useful when texts aren't arriving and we need to know whether Twilio
  // accepted, queued, blocked, or rejected them.
  app.get("/api/twilio/diag/recent-sms", async (_req: Request, res: Response) => {
    try {
      const { getTwilioClient } = await import("./twilio");
      const client = await getTwilioClient();
      const msgs = await client.messages.list({ limit: 15 });
      res.json(msgs.map((m: any) => ({
        sid: m.sid,
        date: m.dateCreated,
        from: m.from,
        to: m.to,
        status: m.status,
        errorCode: m.errorCode,
        errorMessage: m.errorMessage,
        body: (m.body || "").slice(0, 80),
      })));
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "twilio diag failed" });
    }
  });

  console.log(`[twilio-forwarding] dynamic settings loaded from twilio_settings table`);
}
