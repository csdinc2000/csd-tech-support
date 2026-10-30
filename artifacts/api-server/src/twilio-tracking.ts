// CallRail-style call tracking: multi-step flow executor, provisioning,
// per-tracking-number routing for voice + SMS, and outbound SMS API.
//
// Flow steps are stored as JSON arrays on the call_flows table. Each step
// runs as its own webhook (continuation URL) so digit input from <Gather>
// can dictate the next jump.
import type { Express, Request, Response } from "express";
import twilio from "twilio";
import { z } from "zod/v4";
import { getTwilioClient, sendSms, toE164, getTwilioFromPhoneNumber } from "./twilio";
import {
  getTrackingNumberByPhone,
  getCallFlow,
  createSmsMessage,
  listTrackingNumbers,
  createTrackingNumber,
  updateTrackingNumber,
  deleteTrackingNumber,
  listCallFlows,
  createCallFlow,
  updateCallFlow,
  deleteCallFlow,
  listSmsMessages,
  listSmsConversations,
  getAnalyticsByTrackingNumber,
  getAnalyticsBySourceChannel,
  getCallsByDay,
  getRecentCalls,
  createAndAssociateCallContact,
  createAndAssociateCallTicket,
  callTicketIntakeSchema,
} from "./twilio-tracking-storage";
import { upsertCallLog, createVoicemail, markCallVoicemail } from "./twilio-settings-storage";
import { handleInboundSms } from "./twilio-forwarding";
import { canonicalPublicAppBaseUrl } from "./shared/roip-config";
import {
  insertTrackingNumberSchema,
  updateTrackingNumberSchema,
  insertCallFlowSchema,
  updateCallFlowSchema,
  type CallFlow,
  insertCrmContactSchema,
  insertTicketSchema,
} from "@workspace/db";
import { routeParam } from "./lib/route-params";
import { enrichNewTicket } from "./routes/helpdesk";
import { invalidContactPhone } from "./phone-validation";
import { forwardedCallerId } from "./voice-routing";

type FlowStep =
  | { type: "say"; text: string; voice?: string }
  | { type: "menu"; prompt: string; voice?: string; timeout?: number; options: Array<{ digit: string; goto: number }> }
  | { type: "dial"; to: string; timeout?: number; whisper?: boolean; callerId?: "original" | "tracking" }
  | { type: "voicemail"; greeting: string; voice?: string; maxLength?: number; transcribe?: boolean }
  | { type: "sms"; body: string }
  | { type: "hangup" }
  | { type: "goto"; step: number };

function buildBaseUrl(req: Request): string {
  const configured = canonicalPublicAppBaseUrl(process.env.APP_BASE_URL);
  if (configured.ok) return configured.origin;
  const host = req.get("host");
  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  return `${proto}://${host}`;
}

// Render a single flow step into TwiML, then chain to the next step via a
// continuation URL. Returns the TwiML string.
export function renderStep(step: FlowStep, ctx: {
  base: string;
  flowId: number;
  idx: number;
  totalSteps: number;
  fromNumber: string;
  trackingPhone: string;
}): string {
  const VR = twilio.twiml.VoiceResponse;
  const twiml = new VR();
  const next = ctx.idx + 1;
  const hasNext = next < ctx.totalSteps;
  const continueUrl = hasNext
    ? `${ctx.base}/webhooks/voice/flow/${ctx.flowId}/step/${next}?from=${encodeURIComponent(ctx.fromNumber)}&tn=${encodeURIComponent(ctx.trackingPhone)}`
    : null;

  switch (step.type) {
    case "say": {
      twiml.say({ voice: (step.voice || "Polly.Joanna") as any }, step.text);
      if (continueUrl) twiml.redirect({ method: "POST" }, continueUrl);
      else twiml.hangup();
      break;
    }
    case "menu": {
      // <Gather> waits for a single digit. Each option says "press X for Y".
      const gather = twiml.gather({
        numDigits: 1,
        timeout: step.timeout || 8,
        action: `${ctx.base}/webhooks/voice/flow/${ctx.flowId}/step/${ctx.idx}/menu?from=${encodeURIComponent(ctx.fromNumber)}&tn=${encodeURIComponent(ctx.trackingPhone)}`,
        method: "POST",
      });
      gather.say({ voice: (step.voice || "Polly.Joanna") as any }, step.prompt);
      // If no input, fall through to the next step (or hang up)
      if (continueUrl) twiml.redirect({ method: "POST" }, continueUrl);
      else twiml.hangup();
      break;
    }
    case "dial": {
      const callerId = forwardedCallerId(ctx.fromNumber, ctx.trackingPhone, step.callerId === "original");
      const dial = twiml.dial({
        callerId,
        timeout: step.timeout || 25,
        answerOnBridge: true,
        action: continueUrl || undefined,
        method: "POST",
      });
      const numberOpts: any = {};
      if (step.whisper) {
        const params = new URLSearchParams({ from: ctx.fromNumber });
        numberOpts.url = `${ctx.base}/webhooks/voice/whisper?${params.toString()}`;
      }
      dial.number(numberOpts, step.to);
      if (!hasNext) twiml.hangup();
      break;
    }
    case "voicemail": {
      twiml.say({ voice: (step.voice || "Polly.Joanna") as any }, step.greeting);
      twiml.record({
        action: `${ctx.base}/webhooks/voice/flow/${ctx.flowId}/voicemail-saved?tn=${encodeURIComponent(ctx.trackingPhone)}`,
        method: "POST",
        maxLength: step.maxLength || 120,
        playBeep: true,
        finishOnKey: "#",
        transcribe: !!step.transcribe,
      });
      twiml.say("We did not receive a recording. Goodbye.");
      twiml.hangup();
      break;
    }
    case "sms": {
      // Fire SMS in the background — TwiML can't reliably wait for sendSms here.
      // Best-effort: schedule and continue.
      sendSms(ctx.fromNumber, step.body).catch((e) => console.error("[flow:sms]", e?.message || e));
      if (continueUrl) twiml.redirect({ method: "POST" }, continueUrl);
      else twiml.hangup();
      break;
    }
    case "goto": {
      twiml.redirect({ method: "POST" },
        `${ctx.base}/webhooks/voice/flow/${ctx.flowId}/step/${step.step}?from=${encodeURIComponent(ctx.fromNumber)}&tn=${encodeURIComponent(ctx.trackingPhone)}`,
      );
      break;
    }
    case "hangup":
    default: {
      twiml.hangup();
      break;
    }
  }

  return twiml.toString();
}

export function registerTwilioTracking(app: Express): void {
  // ── Flow continuation: /webhooks/voice/flow/:flowId/step/:idx ────────────
  app.post("/webhooks/voice/flow/:flowId/step/:idx", async (req: Request, res: Response) => {
    const flowId = parseInt(routeParam(req.params.flowId, "flowId"), 10);
    const idx = parseInt(routeParam(req.params.idx, "idx"), 10);
    const flow = await getCallFlow(flowId);
    if (!flow) {
      const t = new twilio.twiml.VoiceResponse();
      t.say("Call flow not found.").hangup();
      return res.type("text/xml").send(t.toString());
    }
    const steps = (flow.steps as unknown as FlowStep[]) || [];
    const step = steps[idx];
    if (!step) {
      const t = new twilio.twiml.VoiceResponse();
      t.hangup();
      return res.type("text/xml").send(t.toString());
    }
    const fromNumber = (req.query.from as string) || (req.body?.From as string) || "";
    const trackingPhone = (req.query.tn as string) || (req.body?.To as string) || "";
    const xml = renderStep(step, {
      base: buildBaseUrl(req),
      flowId,
      idx,
      totalSteps: steps.length,
      fromNumber,
      trackingPhone,
    });
    res.type("text/xml").send(xml);
  });

  // Menu input handler — receives Digits and jumps to the goto step.
  app.post("/webhooks/voice/flow/:flowId/step/:idx/menu", async (req: Request, res: Response) => {
    const flowId = parseInt(routeParam(req.params.flowId, "flowId"), 10);
    const idx = parseInt(routeParam(req.params.idx, "idx"), 10);
    const digits = (req.body?.Digits as string) || "";
    const flow = await getCallFlow(flowId);
    const steps = (flow?.steps as unknown as FlowStep[]) || [];
    const current = steps[idx] as Extract<FlowStep, { type: "menu" }> | undefined;
    const fromNumber = (req.query.from as string) || (req.body?.From as string) || "";
    const trackingPhone = (req.query.tn as string) || (req.body?.To as string) || "";
    const base = buildBaseUrl(req);

    let target = idx + 1;
    if (current && current.type === "menu") {
      const match = current.options.find((o) => o.digit === digits);
      if (match) target = match.goto;
    }
    const t = new twilio.twiml.VoiceResponse();
    if (target >= steps.length) {
      t.hangup();
    } else {
      t.redirect({ method: "POST" },
        `${base}/webhooks/voice/flow/${flowId}/step/${target}?from=${encodeURIComponent(fromNumber)}&tn=${encodeURIComponent(trackingPhone)}`,
      );
    }
    res.type("text/xml").send(t.toString());
  });

  // Voicemail recording saved as part of a flow.
  app.post("/webhooks/voice/flow/:flowId/voicemail-saved", async (req: Request, res: Response) => {
    const callSid = (req.body?.CallSid as string) || "";
    const recordingSid = (req.body?.RecordingSid as string) || "";
    const recordingUrl = (req.body?.RecordingUrl as string) || "";
    const duration = parseInt((req.body?.RecordingDuration as string) || "0", 10);
    const from = (req.body?.From as string) || "";
    const to = (req.query.tn as string) || (req.body?.To as string) || "";

    try {
      // Twilio fires this callback even when the caller hangs up without
      // speaking — that produces a recording with status "absent" and no media
      // (RecordingDuration 0), which would later 404 when streamed. Only save a
      // voicemail when there is actual audio.
      if (recordingSid && recordingUrl && duration > 0) {
        await createVoicemail({
          callSid, recordingSid, recordingUrl,
          durationSeconds: duration,
          fromNumber: from, toNumber: to,
          transcription: null, transcriptionStatus: "disabled", listened: false,
        });
        if (callSid) await markCallVoicemail(callSid).catch(() => {});
      } else {
        console.log("[flow:voicemail-saved] no audio captured, skipping", { callSid, recordingSid, duration });
      }
    } catch (e) {
      console.error("[flow:voicemail-saved]", e);
    }

    const t = new twilio.twiml.VoiceResponse();
    t.say("Thank you. Your message has been recorded. Goodbye.").hangup();
    res.type("text/xml").send(t.toString());
  });

  // ── Tracking-number-aware SMS inbound ────────────────────────────────────
  // Deprecated alias. Inbound SMS is now handled uniformly by handleInboundSms
  // (server/twilio-forwarding.ts) for both the main line and tracking numbers —
  // per-number auto-reply, single Messages inbox, forward-to-owner. Kept so any
  // Twilio number still pointed at this URL keeps working; new/synced numbers use
  // /webhooks/sms/incoming.
  app.post("/webhooks/sms/tracking", (req: Request, res: Response) => handleInboundSms(req, res));

  // ════════════════════════════════════════════════════════════════════════
  // ADMIN API
  // ════════════════════════════════════════════════════════════════════════

  // Tracking numbers CRUD ---------------------------------------------------
  app.get("/api/call-tracking/numbers", async (_req, res) => {
    try { res.json(await listTrackingNumbers()); }
    catch (e: any) { res.status(500).json({ error: e?.message || "failed" }); }
  });

  app.post("/api/call-tracking/numbers", async (req, res) => {
    try {
      const data = insertTrackingNumberSchema.parse(req.body);
      res.status(201).json(await createTrackingNumber(data));
    } catch (e: any) {
      res.status(400).json({ error: e?.message || "invalid", issues: e?.issues });
    }
  });

  app.patch("/api/call-tracking/numbers/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const data = updateTrackingNumberSchema.parse(req.body);
      const row = await updateTrackingNumber(id, data);
      if (!row) return res.status(404).json({ error: "not found" });
      res.json(row);
    } catch (e: any) {
      res.status(400).json({ error: e?.message || "invalid" });
    }
  });

  app.delete("/api/call-tracking/numbers/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const ok = await deleteTrackingNumber(id);
      res.json({ deleted: ok });
    } catch (e: any) { res.status(500).json({ error: e?.message || "failed" }); }
  });

  // Provisioning: search available numbers ---------------------------------
  // Body: { type: "local"|"tollfree", areaCode?: string, contains?: string, limit?: number }
  app.post("/api/call-tracking/numbers/search", async (req, res) => {
    try {
      const { type = "local", areaCode, contains, limit = 10 } = req.body || {};
      const client = await getTwilioClient();
      const params: any = { limit: Math.min(limit, 30) };
      if (areaCode) params.areaCode = areaCode;
      if (contains) params.contains = contains;
      const country = client.availablePhoneNumbers("US");
      const list = type === "tollfree"
        ? await country.tollFree.list(params)
        : await country.local.list(params);
      res.json(list.map((n: any) => ({
        phoneNumber: n.phoneNumber,
        friendlyName: n.friendlyName,
        locality: n.locality,
        region: n.region,
        capabilities: n.capabilities,
      })));
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "search failed" });
    }
  });

  // Provisioning: purchase a number and auto-configure webhooks ------------
  app.post("/api/call-tracking/numbers/purchase", async (req, res) => {
    try {
      const schema = z.object({
        phoneNumber: z.string().min(8),
        friendlyName: z.string().optional(),
        numberType: z.enum(["local", "tollfree"]).default("local"),
        campaignName: z.string().optional(),
        sourceChannel: z.string().optional(),
        sourceMedium: z.string().optional(),
        keywords: z.string().optional(),
        callFlowId: z.number().int().optional(),
        forwardToNumber: z.string().optional(),
      });
      const data = schema.parse(req.body);
      const client = await getTwilioClient();
      const base = buildBaseUrl(req);
      const purchased = await client.incomingPhoneNumbers.create({
        phoneNumber: data.phoneNumber,
        friendlyName: data.friendlyName || data.campaignName || data.phoneNumber,
        voiceUrl: `${base}/webhooks/voice/incoming`,
        voiceMethod: "POST",
        smsUrl: `${base}/webhooks/sms/incoming`,
        smsMethod: "POST",
        statusCallback: `${base}/webhooks/voice/status`,
        statusCallbackMethod: "POST",
      });

      const row = await createTrackingNumber({
        phoneNumber: purchased.phoneNumber,
        friendlyName: purchased.friendlyName,
        twilioSid: purchased.sid,
        numberType: data.numberType,
        campaignName: data.campaignName ?? null,
        sourceChannel: data.sourceChannel ?? null,
        sourceMedium: data.sourceMedium ?? null,
        keywords: data.keywords ?? null,
        callFlowId: data.callFlowId ?? null,
        forwardToNumber: data.forwardToNumber ?? null,
        smsAutoReplyEnabled: false,
        smsAutoReplyText: null,
        voicemailGreeting: null,
        active: true,
      });

      res.status(201).json(row);
    } catch (e: any) {
      console.error("[tracking:purchase]", e);
      res.status(400).json({ error: e?.message || "purchase failed" });
    }
  });

  // Sync webhook config to all tracking numbers (handy after URL changes)
  app.post("/api/call-tracking/numbers/sync-webhooks", async (req, res) => {
    try {
      const base = buildBaseUrl(req);
      const client = await getTwilioClient();
      const rows = await listTrackingNumbers();
      const results: any[] = [];
      for (const tn of rows) {
        if (!tn.twilioSid) { results.push({ id: tn.id, skipped: "no twilio sid" }); continue; }
        try {
          await client.incomingPhoneNumbers(tn.twilioSid).update({
            voiceUrl: `${base}/webhooks/voice/incoming`,
            voiceMethod: "POST",
            smsUrl: `${base}/webhooks/sms/tracking`,
            smsMethod: "POST",
            statusCallback: `${base}/webhooks/voice/status`,
            statusCallbackMethod: "POST",
          });
          results.push({ id: tn.id, updated: true });
        } catch (e: any) {
          results.push({ id: tn.id, error: e?.message || "update failed" });
        }
      }
      res.json({ results });
    } catch (e: any) { res.status(500).json({ error: e?.message || "failed" }); }
  });

  // Call flows CRUD --------------------------------------------------------
  app.get("/api/call-tracking/flows", async (_req, res) => {
    try { res.json(await listCallFlows()); }
    catch (e: any) { res.status(500).json({ error: e?.message || "failed" }); }
  });

  app.post("/api/call-tracking/flows", async (req, res) => {
    try {
      const data = insertCallFlowSchema.parse(req.body);
      res.status(201).json(await createCallFlow(data));
    } catch (e: any) { res.status(400).json({ error: e?.message || "invalid" }); }
  });

  app.patch("/api/call-tracking/flows/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const data = updateCallFlowSchema.parse(req.body);
      const row = await updateCallFlow(id, data);
      if (!row) return res.status(404).json({ error: "not found" });
      res.json(row);
    } catch (e: any) { res.status(400).json({ error: e?.message || "invalid" }); }
  });

  app.delete("/api/call-tracking/flows/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      res.json({ deleted: await deleteCallFlow(id) });
    } catch (e: any) { res.status(500).json({ error: e?.message || "failed" }); }
  });

  // SMS API ---------------------------------------------------------------
  // @deprecated These read the same sms_messages table as the canonical
  // /api/sms/* routes (server/routes.ts), which power the single Messages inbox
  // and are richer (CRM enrichment, delete, reply-from-tracking-number). Kept for
  // backward compatibility; the UI no longer calls these.
  app.get("/api/call-tracking/sms", async (req, res) => {
    try {
      const counterparty = (req.query.counterparty as string) || undefined;
      res.json(await listSmsMessages({ counterparty, limit: 200 }));
    } catch (e: any) { res.status(500).json({ error: e?.message || "failed" }); }
  });

  app.get("/api/call-tracking/sms/conversations", async (_req, res) => {
    try { res.json(await listSmsConversations()); }
    catch (e: any) { res.status(500).json({ error: e?.message || "failed" }); }
  });

  app.post("/api/call-tracking/sms/send", async (req, res) => {
    try {
      const schema = z.object({
        to: z.string().min(8),
        body: z.string().min(1).max(1600),
        from: z.string().optional(), // accepted for compatibility; always sent from the business line
      });
      const { to, body } = schema.parse(req.body);
      const client = await getTwilioClient();
      // One central number: customers only ever see the business line, so a
      // requested tracking-number `from` is ignored.
      const fromNumber = await getTwilioFromPhoneNumber();
      if (!fromNumber) return res.status(400).json({ error: "no from number configured" });
      const msg = await client.messages.create({ to: toE164(to), from: fromNumber, body });

      let trackingId: number | null = null;
      try {
        const tn = await getTrackingNumberByPhone(fromNumber);
        if (tn) trackingId = tn.id;
      } catch {}
      await createSmsMessage({
        messageSid: msg.sid, fromNumber, toNumber: toE164(to), body,
        direction: "outbound", status: msg.status || "sent", trackingNumberId: trackingId,
      }).catch(() => {});

      res.status(201).json({ sid: msg.sid, to: msg.to, from: msg.from, status: msg.status });
    } catch (e: any) {
      console.error("[sms:send]", e);
      res.status(400).json({ error: e?.message || "send failed" });
    }
  });

  // Analytics -------------------------------------------------------------
  app.get("/api/call-tracking/calls", async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "100", 10) || 100, 1), 500);
      res.json(await getRecentCalls(limit));
    } catch (e: any) {
      req.log.error({ err: e }, "List tracked calls failed");
      res.status(500).json({ error: "Unable to load call activity" });
    }
  });

  app.post("/api/call-tracking/calls/:id/contact", async (req, res) => {
    try {
      const id = Number.parseInt(routeParam(req.params.id, "id"), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid call ID" });
      const phoneError = invalidContactPhone(req.body);
      if (phoneError) return res.status(400).json({ error: phoneError });
      const contactInput = insertCrmContactSchema.parse(req.body);
      const contact = await createAndAssociateCallContact(id, contactInput);
      res.status(201).json(contact);
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid contact information", details: e.issues });
      }
      if (e?.message === "CALL_NOT_FOUND") return res.status(404).json({ error: "Call not found" });
      if (e?.message === "CALL_ALREADY_ASSOCIATED") return res.status(409).json({ error: "This call already has a contact" });
      if (e?.message === "CLIENT_NOT_FOUND") return res.status(400).json({ error: "Customer account not found" });
      req.log.error({ err: e }, "Create contact from tracked call failed");
      res.status(500).json({ error: "Unable to create contact from this call" });
    }
  });

  app.post("/api/call-tracking/calls/:id/ticket", async (req, res) => {
    try {
      const id = Number.parseInt(routeParam(req.params.id, "id"), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid call ID" });
      const ticketInput = insertTicketSchema.parse(req.body);
      const intake = req.body.intake === undefined ? undefined : callTicketIntakeSchema.parse(req.body.intake);
      const result = await createAndAssociateCallTicket(id, ticketInput, intake);
      const ticket = result.created ? await enrichNewTicket(result.ticket, { preserveAssignment: !!intake }) : result.ticket;
      return res.status(result.created ? 201 : 200).json({
        ...ticket, alreadyLinked: !result.created,
        assignedTechName: result.assignedTechName, effectiveSmsConsent: result.effectiveSmsConsent,
      });
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid ticket information", details: e.issues });
      }
      if (e?.message === "CALL_NOT_FOUND") return res.status(404).json({ error: "Call not found" });
      req.log.error({ err: e }, "Create ticket from tracked call failed");
      return res.status(500).json({ error: "Unable to create a ticket from this call" });
    }
  });

  app.get("/api/call-tracking/analytics/by-number", async (_req, res) => {
    try { res.json(await getAnalyticsByTrackingNumber()); }
    catch (e: any) { res.status(500).json({ error: e?.message || "failed" }); }
  });

  app.get("/api/call-tracking/analytics/by-channel", async (_req, res) => {
    try { res.json(await getAnalyticsBySourceChannel()); }
    catch (e: any) { res.status(500).json({ error: e?.message || "failed" }); }
  });

  app.get("/api/call-tracking/analytics/by-day", async (req, res) => {
    try {
      const days = Math.min(parseInt((req.query.days as string) || "30", 10) || 30, 365);
      res.json(await getCallsByDay(days));
    } catch (e: any) { res.status(500).json({ error: e?.message || "failed" }); }
  });

  console.log("[twilio-tracking] CallRail-style routes registered");
}
