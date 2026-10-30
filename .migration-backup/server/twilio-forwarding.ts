import type { Express, Request, Response } from "express";
import twilio from "twilio";
import { sendSms } from "./twilio";
import {
  getTwilioSettings,
  createVoicemail,
  updateVoicemailByCallSid,
  upsertCallLog,
  markCallVoicemail,
} from "./twilio-settings-storage";
import { getTrackingNumberByPhone, getCallFlow, createSmsMessage } from "./twilio-tracking-storage";
import { sendIncomingCallNotification } from "./slack";
import { getGreetingAudio, hasGreetingAudio } from "./greeting-store";
import { getActiveCallRecipientPhones, handleStaffInboundSms, recordSmsConsentState } from "./staff-dispatch";

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
function alertTeamOfCall(
  settings: { voicemailNotifyNumber: string },
  opts: { kind: "incoming" | "missed"; from: string; to: string; location?: string },
): void {
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

  void sendIncomingCallNotification({
    from: fromDisp,
    to: toDisp,
    location: opts.location,
    missed: opts.kind === "missed",
  }).catch((e) => console.error("[call-alert] Slack failed:", e?.message || e));
}

function buildBaseUrl(req: Request): string {
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

// Twilio signs every webhook with X-Twilio-Signature using the auth token.
// We verify it to prevent spoofed callbacks (fake voicemails, abusive auto-replies).
// The local-only bypass is deliberately unavailable in production.
async function verifyTwilioSignature(req: Request, res: Response): Promise<boolean> {
  if (process.env.NODE_ENV !== "production" && process.env.TWILIO_SKIP_SIGNATURE_VERIFY === "1") return true;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    if (process.env.NODE_ENV === "production") {
      res.status(503).type("text/plain").send("Twilio webhook verification is not configured");
      return false;
    }
    console.warn("[twilio-forwarding] TWILIO_AUTH_TOKEN not set — webhook signature NOT verified outside production");
    return true;
  }
  const signature = req.get("X-Twilio-Signature") || "";
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  const url = `${proto}://${req.get("host")}${req.originalUrl}`;
  const ok = twilio.validateRequest(authToken, signature, url, req.body || {});
  if (!ok) {
    res.status(403).type("text/plain").send("Invalid Twilio signature");
    return false;
  }
  return true;
}

// Unified inbound-SMS handler for BOTH the main business line and every call
// tracking number. Resolves the tracking number from the `To` field (null = main
// line), persists the inbound message, sends an auto-reply (per-number text when
// the tracking number configures one, otherwise the global auto-reply), and
// forwards the text to the owner's cell. Both /webhooks/sms/incoming and the
// legacy /webhooks/sms/tracking alias route through here so there is one code
// path and one Messages inbox.
export async function handleInboundSms(req: Request, res: Response): Promise<void> {
  if (!(await verifyTwilioSignature(req, res))) return;
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
  if (!keywordReplyText && !isStopKeyword && from && staffCommandsAreTrusted) {
    try {
      const staffResult = await handleStaffInboundSms(from, body);
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
  const isFromOwnNumber = !!from && from === settings.smsForwardToNumber;

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

  // Forward to the owner's cell — skip when the admin is texting from their own
  // cell (otherwise their outgoing texts loop back as "From you: ..."). Applies to
  // every inbound text; the line it hit is noted for tracking numbers.
  if (settings.smsForwardEnabled && !isFromOwnNumber) {
    const lineNote = tracking ? ` [to ${tracking.friendlyName || tracking.phoneNumber}]` : "";
    try {
      const result = await sendSms(
        settings.smsForwardToNumber,
        `From ${formatCallerForDisplay(from)}${lineNote}: ${body}${mediaNote}`,
      );
      console.log(`[sms-forward] forwarded sid=${result.sid}`);
    } catch (e: any) {
      console.error("[sms-forward] FAILED:", e?.message || e, e?.code ? `code=${e.code}` : "");
    }
  } else if (isFromOwnNumber) {
    console.log(`[sms-forward] skipped (text was from admin's own cell)`);
  }
}

export function registerTwilioForwarding(app: Express): void {
  const VoiceResponse = twilio.twiml.VoiceResponse;

  // ── INCOMING CALL ───────────────────────────────────────────────────────────
  app.post("/webhooks/voice/incoming", async (req: Request, res: Response) => {
    if (!(await verifyTwilioSignature(req, res))) return;
    const settings = await getTwilioSettings();
    const base = buildBaseUrl(req);
    const twiml = new VoiceResponse();

    // Resolve tracking number (CallRail-style attribution). If the To number
    // matches a configured tracking number with a callFlowId, hand off to the
    // flow executor. Otherwise fall back to the global single-number forwarding.
    const toNumber = (req.body?.To as string) || settings.twilioPhoneNumber;
    let trackingId: number | null = null;
    let trackingChannel: string | null = null;
    let trackingKeywords: string | null = null;
    let trackingFlowId: number | null = null;
    let trackingForwardTo: string | null = null;
    try {
      const tn = await getTrackingNumberByPhone(toNumber);
      if (tn && tn.active) {
        trackingId = tn.id;
        trackingChannel = tn.sourceChannel ?? null;
        trackingKeywords = tn.keywords ?? null;
        trackingFlowId = tn.callFlowId ?? null;
        trackingForwardTo = tn.forwardToNumber ?? null;
      }
    } catch (e) { console.error("[tracking lookup]", e); }

    // Log the call (insert or refresh existing row by CallSid)
    try {
      await upsertCallLog({
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
      });
    } catch (e) {
      console.error("[call-log] insert failed:", e);
    }

    // If this tracking number has a custom call flow, jump into the flow
    // executor immediately (skip the legacy single-number routing below).
    if (trackingFlowId) {
      const flow = await getCallFlow(trackingFlowId).catch(() => undefined);
      if (flow && Array.isArray(flow.steps) && (flow.steps as any[]).length > 0) {
        const fromNumber = (req.body?.From as string) || "";
        // Custom call flows handle their own routing, so alert the team here on
        // entry — otherwise tracked-number calls would get no immediate alert.
        alertTeamOfCall(settings, {
          kind: "incoming",
          from: fromNumber || "Unknown",
          to: toNumber,
          location: [req.body?.FromCity, req.body?.FromState].filter(Boolean).join(", "),
        });
        twiml.redirect({ method: "POST" },
          `${base}/webhooks/voice/flow/${flow.id}/step/0?from=${encodeURIComponent(fromNumber)}&tn=${encodeURIComponent(toNumber)}`,
        );
        return res.type("text/xml").send(twiml.toString());
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
      alertTeamOfCall(settings, { kind: "incoming", from: incomingFrom, to: toNumber, location: incomingLocation });
      // Straight to voicemail
      await sendToVoicemail(twiml, settings, base);
    } else if (action === "sms_only") {
      alertTeamOfCall(settings, { kind: "incoming", from: incomingFrom, to: toNumber, location: incomingLocation });
      twiml.say({ voice: settings.whisperVoice as any }, "Thank you for calling. Please send us a text message and we will respond shortly.");
      twiml.hangup();
    } else {
      // Forward — dial owner; if no answer, fall through to voicemail (if enabled)
      // IMPORTANT: setting callerId to the original caller's From number means the
      // forwarded phone shows who's actually calling, not your Twilio number.
      const fromNumber = (req.body?.From as string) || "";
      const callerId = settings.showCallerIdOnForward && fromNumber
        ? fromNumber
        : ((req.body?.To as string) || settings.twilioPhoneNumber);
      // Tracking-number overrides remain single-target. Only the main global
      // route fans out to currently enabled, on-duty call recipients.
      const callTargets = trackingForwardTo
        ? [trackingForwardTo]
        : await getActiveCallRecipientPhones().catch((e) => {
            console.error("[staff-dispatch] call recipient lookup failed:", e);
            return [] as string[];
          });

      const dial = twiml.dial({
        callerId,
        // Give a real chance to answer: at least 25s of ringing, even if the
        // stored setting is lower. A higher saved value still wins.
        timeout: Math.max(settings.dialTimeoutSeconds || 0, 25),
        answerOnBridge: true,
        // Always route to dial-result so missed-call alerts fire even when
        // voicemail is disabled. dial-result handles the hangup vs. voicemail.
        action: `${base}/webhooks/voice/dial-result${!trackingForwardTo && callTargets.length ? "?route=staff" : ""}`,
        method: "POST",
      });
      const numberOpts: any = {};
      if (settings.whisperEnabled) {
        // Pass From through to the whisper webhook so it can announce the caller.
        const params = new URLSearchParams();
        if (fromNumber) params.set("from", fromNumber);
        numberOpts.url = `${base}/webhooks/voice/whisper${params.toString() ? "?" + params.toString() : ""}`;
      }
      for (const target of callTargets.length ? callTargets : [settings.forwardToNumber]) {
        dial.number(numberOpts, target);
      }
      // Dial always has an action (dial-result) which handles missed-call alerts
      // and the hangup-vs-voicemail decision, so nothing more is needed here.
    }

    res.type("text/xml").send(twiml.toString());
  });

  // ── DIAL RESULT (only fires when <Dial action="..."> is set) ────────────────
  app.post("/webhooks/voice/dial-result", async (req: Request, res: Response) => {
    if (!(await verifyTwilioSignature(req, res))) return;
    const settings = await getTwilioSettings();
    const base = buildBaseUrl(req);
    const dialStatus = (req.body?.DialCallStatus as string) || "";
    const twiml = new VoiceResponse();

    if (dialStatus === "completed" || dialStatus === "answered") {
      // Owner picked up and call ended normally — hang up cleanly.
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }
    // A roster fan-out is one complete attempt. Do not leak into the legacy
    // owner/backup chain after every on-duty recipient missed the call.
    const staffRoute = req.query?.route === "staff";

    // No answer on this attempt. Try the next configured number before falling
    // through to voicemail. Empty and duplicate numbers are skipped.
    const attempt = (req.query?.attempt as string) || "primary";
    const forwardTargets = [
      { key: "primary", number: (settings.forwardToNumber || "").trim() },
      { key: "backup1", number: (settings.backupForwardNumber || "").trim() },
      { key: "backup2", number: (settings.backupForwardNumber2 || "").trim() },
    ];
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
      const callerId = settings.showCallerIdOnForward && fromNumber
        ? fromNumber
        : ((req.body?.To as string) || settings.twilioPhoneNumber);
      const dial = twiml.dial({
        callerId,
        timeout: Math.max(settings.dialTimeoutSeconds || 0, 25),
        answerOnBridge: true,
        action: `${base}/webhooks/voice/dial-result?attempt=${nextTarget.key}`,
        method: "POST",
      });
      const numberOpts: any = {};
      if (settings.whisperEnabled) {
        const params = new URLSearchParams();
        if (fromNumber) params.set("from", fromNumber);
        numberOpts.url = `${base}/webhooks/voice/whisper${params.toString() ? "?" + params.toString() : ""}`;
      }
      dial.number(numberOpts, nextTarget.number);
      console.log(`[voice] ${attempt} no-answer (${dialStatus}) — trying ${nextTarget.key}`);
    } else {
      // Nobody picked up — alert the team immediately to call the customer back.
      alertTeamOfCall(settings, {
        kind: "missed",
        from: (req.body?.From as string) || "Unknown",
        to: (req.body?.To as string) || settings.twilioPhoneNumber,
        location: [req.body?.FromCity, req.body?.FromState].filter(Boolean).join(", "),
      });
      // no-answer / busy / failed / canceled → voicemail
      if (settings.voicemailEnabled) {
        await sendToVoicemail(twiml, settings, base);
      } else {
        twiml.hangup();
      }
    }
    res.type("text/xml").send(twiml.toString());
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
    if (req.method === "POST" && !(await verifyTwilioSignature(req, res))) return;
    const settings = await getTwilioSettings();
    const twiml = new VoiceResponse();
    // Announce the configured whisper text, then optionally read the caller's number
    // digit-by-digit so it's easy to understand over the phone.
    twiml.say({ voice: settings.whisperVoice as any }, settings.whisperText);
    if (settings.whisperAnnounceCaller) {
      const fromRaw = (req.query?.from as string) || (req.body?.From as string) || "";
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

  // ── CUSTOM GREETING AUDIO (served to Twilio's <Play>) ──────────────────────
  // Public, unauthenticated GET so Twilio can fetch the uploaded greeting audio.
  app.get("/webhooks/voice/greeting-audio", async (_req: Request, res: Response) => {
    try {
      const audio = await getGreetingAudio();
      if (!audio) return res.status(404).send("No custom greeting");
      res.setHeader("Content-Type", audio.contentType);
      res.setHeader("Cache-Control", "no-cache");
      res.send(audio.buf);
    } catch {
      res.status(500).send("Failed to load greeting");
    }
  });

  // ── VOICEMAIL: recording finished ──────────────────────────────────────────
  app.post("/webhooks/voice/voicemail-recorded", async (req: Request, res: Response) => {
    if (!(await verifyTwilioSignature(req, res))) return;
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
    if (!(await verifyTwilioSignature(req, res))) return;
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
    if (!(await verifyTwilioSignature(req, res))) return;
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
    // Verify the Twilio signature before trusting any status/error code —
    // otherwise an attacker could spoof delivery receipts or fake A2P failures.
    if (!(await verifyTwilioSignature(req, res))) return;
    res.sendStatus(204);
    const sid = (req.body?.MessageSid as string) || (req.body?.SmsSid as string) || "";
    const status = (req.body?.MessageStatus as string) || (req.body?.SmsStatus as string) || "";
    const errorCode = (req.body?.ErrorCode as string) || "";
    if (!sid) return;
    console.log(`[sms-status] sid=${sid} status=${status}${errorCode ? ` err=${errorCode}` : ""}`);
    try {
      const { updateSmsMessageStatus } = await import("./twilio-tracking-storage");
      await updateSmsMessageStatus(sid, status, errorCode || null);
    } catch (e: any) {
      console.warn("[sms-status] update failed:", e?.message || e);
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
