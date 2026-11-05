import type { Express } from "express";
import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "http";
import { ContactDeletionConflictError, storage } from "../storage";
import { setGreetingAudio, clearGreetingAudio, getGreetingAudioInfo } from "../greeting-store";
import networkRoutes from "../routes/network";
import crmPipelineRoutes from "../routes/crm";
import { 
  insertDeviceSchema, insertAlertSchema, insertTicketSchema, 
  insertClientSchema, insertNetworkScanSchema, insertAutomationScriptSchema,
  insertCsdIntakeSchema,
  insertCrmContactSchema, insertCrmLeadSchema, insertCrmJobSchema, insertCrmInteractionSchema,
  insertServiceLogSchema
} from "@workspace/db";
import { z } from "zod/v4";
import {
  ExportEmailProviderWarningSettingsHistoryQueryParams,
  GetEmailProviderHealthResponse,
  GetSlackDeliveryHealthResponse,
  ListSlackTerminalFailuresResponse,
  RetrySlackTerminalFailureParams,
  RetrySlackTerminalFailureResponse,
  GetEmailProviderWarningSettingsHistoryQueryParams,
  GetEmailProviderWarningSettingsHistoryResponse,
  RecheckEmailProviderHealthResponse,
  SendIntakeEmailBody,
  UpdateEmailProviderWarningSettingsBody,
  UpdateEmailProviderWarningSettingsResponse,
} from "@workspace/api-zod";
import { getSlackDeliveryHealth } from "../slack-delivery-health";
import { listSlackTerminalFailures, retrySlackTerminalFailure } from "../slack-outbox";
import { getAuth } from "@clerk/express";
import { queueTicketNotification, queueAutomationNotification, queueLeadNotification } from "../slack";
import { getMeshCentralClient } from "../meshcentral";
import { meshCentralService } from "../meshcentral-service";
import { buildTeamviewerLaunchUrl, normalizeTeamviewerId } from "../teamviewer";
import { createSupportCode, redeemSupportCode } from "../support-codes";
import { REMOTE_SUPPORT_WIDGET_HTML } from "../remote-support-widget";
import { emergencyAlertService } from "../emergency-alerts";
import { sendIntakeNotificationEmail, sendCustomerConfirmationEmail } from "../csd-notifications";
import { sendEmail, ticketPortalUrl } from "../helpdesk-email";
import { getInvoiceSettings } from "../invoice-settings";
import { isSmtpConfigured } from "../mail-transport";
import {
  ensureIntakeEmailAuditSchema,
  IntakeEmailAuditWriteError,
  listIntakeEmailAttempts,
  sendIntakeEmailWithAudit,
} from "../intake-email-audit";
import { googleContactsService as defaultGoogleContactsService } from "../google-contacts";
import { requireAuth } from "../middlewares/clerkAuth";
import { isAdminEmail, isAdminUser, rateLimit, sharedRateLimit } from "../security";
import {
  checkEmailProviderCapacityOnce,
  getEmailCapacityMonitoringStatus,
  startEmailProviderCapacityMonitor,
} from "../email-provider-health";
import {
  formatEmailCapacityWarningSettingsAuditCsv,
  getEmailCapacityWarningSettingsAudit,
  getEmailCapacityWarningSettings,
  parseEmailCapacityWarningSettingsAuditCursor,
  updateEmailCapacityWarningSettings,
} from "../email-capacity-settings";

// Rate limiter for public, unauthenticated write endpoints (intake form,
// support-code redemption). Generous enough for real customers, tight enough to
// blunt abuse.
const publicWriteLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: "Too many requests. Please wait a minute and try again.",
});

// Public, unauthenticated GET endpoints (e.g. the agent download) — looser than
// the write limiter but still capped so a burst can't be used to hammer the
// upstream MeshCentral server.
const publicReadLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: "Too many requests. Please wait a minute and try again.",
});

const staffIntakeEmailLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  key: (req) => req.dbUser?.id ?? req.ip ?? "unknown",
  message: "Too many emails. Please wait a minute and try again.",
});

// Zod schemas for the public endpoints.
const intakeSchema = z
  .object({
    full_name: z.string().trim().min(1),
    service_type: z.string().trim().min(1),
    device_type: z.string().trim().min(1),
    problem_description: z.string().trim().min(1),
    mobile_phone: z.string().trim().optional(),
    email: z.string().trim().email().optional().or(z.literal("")),
    company_name: z.string().trim().optional(),
    intake_submission_id: z.string().uuid().optional(),
    // Booking catalog service the customer picked. The price is looked up
    // server-side from this id; a client-supplied price is never trusted.
    service_id: z.coerce.number().int().positive().optional(),
    // Optional photo of the front of the customer's device.
    device_photo: customerPhotoInputSchema.optional().nullable(),
    // How the customer filled in the form. "voice" marks requests completed
    // through the spoken intake assistant so staff can tell them apart.
    intake_channel: z.enum(["web", "voice"]).optional(),
    // Marketing link the visitor landed on (see lib/utm-capture.ts in the
    // client). Cleaned by normalizeUtmCampaign rather than validated, so a
    // malformed tag never rejects a request.
    utm_campaign: z.unknown().optional(),
    // Referral code from a customer's share link (lib/utm-capture.ts). Unknown
    // or invalid codes are ignored by recordIntakeReferral, never rejected.
    referral_code: z.unknown().optional(),
  })
  .refine((d) => !!(d.mobile_phone && d.mobile_phone.length) || !!(d.email && d.email.length), {
    message: "Either mobile_phone or email is required",
  });

const redeemCodeSchema = z.object({
  code: z.string().trim().min(1),
});
import { ariaService } from "../aria-service";
import { ensureAriaActionSchema, registerAriaConnectionRoutes, ownsAriaConversation, ariaScopeFingerprint } from "../aria-tools";
import { registerAriaMultiCamRoutes } from "../aria-multicam";
import { crmJobUpdateFromBody } from "../crm-job-update";
import { v4 as uuidv4 } from "uuid";
import { registerBookingRoutes, startSlotLockSweeper } from "../booking/booking-routes";
import { seedBookingDefaults } from "../booking/seed";
import { sendSms as defaultSendSms, getTwilioClient, getTwilioFromPhoneNumber, isTwilioConfigured as defaultIsTwilioConfigured, toE164, toValidE164 } from "../twilio";
import { getTwilioSettings, updateTwilioSettings, upsertCallLog } from "../twilio-settings-storage";
import {
  enqueueSmsForwardBroadcast,
  parseSmsForwardTargets,
} from "../sms-forward-outbox";
import { googleCalendarService } from "../google-calendar";
import { registerBillingRoutes } from "../billing-routes";
import { registerHelpdeskRoutes, enrichNewTicket } from "../routes/helpdesk";
import { registerPttRoutes } from "../ptt";
import {
  dispatchNewTicketToStaff,
  enqueueStaffEventNotification,
  staffEventExecutor,
  getSmsConsentEligibility,
  recordSmsConsentState,
  registerStaffDispatchRoutes,
  type SmsMessageClass,
} from "../staff-dispatch";
import { ensureInvoiceSchema, registerInvoiceRoutes } from "../invoice-routes";
import { ensureInvoiceTemplatesSchema, registerInvoiceTemplateRoutes } from "../invoice-templates";
import { ensurePayPalImportSchema, registerPayPalImportRoutes } from "../paypal-import";
import { ensureContactImportIndexes, registerContactImportRoutes } from "../contact-import";
import { startInvoiceEmailOutboxWorker } from "../invoice-email-outbox";
import { ensureMailboxSchema, startMailboxWorker } from "../mailbox-service";
import { pool } from "../db";
import { canonicalPublicAppBaseUrl } from "../shared/roip-config";
import {
  canAccessAssignedDevice,
  canCreateAlertForSource,
  canViewStaffRecoveryAlert,
  canViewVoicemails,
  getStaffAccess,
  getStaffAssignmentScope,
  canSeeTicket,
  isAdministratorScope,
  requireStaffAdministrator,
  type StaffAssignmentScope,
} from "../staff-access";
import { overviewAppointment, overviewContact, overviewInvoice, overviewJob } from "../client-overview";
import { logger } from "../lib/logger";
import { normalizeOptionalClientId, normalizeOptionalRefId } from "../customer-link-core";
import { publishPipelineEvent } from "../crm-events";
import { reviewDeletedContactPlaceholdersWithRecords } from "../contact-placeholder-cleanup";
import { registerServiceContractRoutes } from "../service-contracts";
import { registerMarketplaceRoutes, type MarketplaceMailer } from "../marketplace";
import { registerVoiceIntakeRoutes } from "../voice-intake";
import type { TextReader as MarketplaceLookupReader, VisionReader as MarketplaceScanReader } from "../marketplace-scan";
import { registerCatalogRoutes } from "../catalog";
import { applyCatalogInvoiceLinkMigration } from "../migrations/2026-09-28-catalog";
import { registerContactCrmRoutes } from "./contact-crm-routes";
import { registerContactOverviewRoute } from "./contact-overview-route";
import { customerPhotoInputSchema, decodeCustomerPhoto, registerCustomerPhotoRoutes, saveIntakeDevicePhoto } from "../customer-photos";
import { registerGoogleContactRoutes } from "./google-contact-routes";
import { registerContactSmsRoutes } from "./contact-sms-routes";
import { registerSharedInboxRoutes } from "../shared-inbox";
import { recordIntakeReferral, registerReferralRoutes, type ReferralMailer } from "../referrals";
import { defaultAgentPhones, registerOutboundCallRoutes } from "./outbound-call-routes";
import { registerBrowserVoiceRoutes } from "./browser-voice-routes";
import { registerStaffMeetingRoutes } from "../staff-meetings";
import { registerCommunicationEmailRoutes } from "../communication-email";
import { registerStaffCalendarRoutes } from "../staff-calendar";

async function mirrorStaffSmsToForwardingPhones(input: {
  messageSid: string;
  customerNumber: string;
  businessNumber: string;
  body: string;
}): Promise<void> {
  const settings = await getTwilioSettings();
  if (!settings.smsForwardEnabled) return;

  const customerNumber = toE164(input.customerNumber);
  const businessNumber = toE164(input.businessNumber || settings.twilioPhoneNumber);
  const targets = parseSmsForwardTargets(
    settings.smsForwardNumbers,
    settings.smsForwardToNumber,
  ).filter((target) => target !== customerNumber && target !== businessNumber);

  if (!input.messageSid || targets.length === 0) return;

  await enqueueSmsForwardBroadcast({
    inboundMessageSid: input.messageSid,
    sourceNumber: customerNumber,
    businessNumber,
    body: `CSD reply to ${customerNumber}: ${input.body}`,
    targets,
  });
}
import {
  buildIntakeAttribution,
  normalizeUtmCampaign,
  buildIntakeDeal,
  intakePayloadFingerprint,
  mapIntakeClient,
  mapIntakeRecord,
  planIntakeDispatch,
  normalizeIntakeEmail,
  normalizeIntakePhone,
  normalizedPhoneDigits,
  publicIntakeResponse,
  resolveIntakeAccount,
  resolveIntakeIdentity,
} from "../intake-core";

type RouteRegistrationOptions = {
  disableBackgroundServices?: boolean;
  contactImportAuthMiddleware?: express.RequestHandler;
  providerHealthAuthMiddleware?: express.RequestHandler;
  recheckProviderHealthEmailCapacity?: () => Promise<ReturnType<typeof getEmailCapacityMonitoringStatus>>;
  getProviderHealthEmailCapacityStatus?: () => unknown;
  getProviderHealthWarningSettings?: typeof getEmailCapacityWarningSettings;
  getProviderHealthWarningSettingsAudit?: typeof getEmailCapacityWarningSettingsAudit;
  updateProviderHealthWarningSettings?: typeof updateEmailCapacityWarningSettings;
  googleContactsService?: typeof defaultGoogleContactsService;
  isTwilioConfigured?: typeof defaultIsTwilioConfigured;
  sendSms?: typeof defaultSendSms;
  marketplaceMailer?: MarketplaceMailer;
  referralMailer?: ReferralMailer;
  marketplaceScanReader?: MarketplaceScanReader;
  marketplaceLookupReader?: MarketplaceLookupReader | null;
};

function validWarningHistoryDates(fromDate?: string, toDate?: string): boolean {
  if (Boolean(fromDate) !== Boolean(toDate)) return false;
  const validInstant = (value?: string) => {
    if (!value) return true;
    const [year, month, day] = value.slice(0, 10).split("-").map(Number);
    const calendarDate = new Date(Date.UTC(year, month - 1, day));
    return !Number.isNaN(Date.parse(value))
      && calendarDate.getUTCFullYear() === year
      && calendarDate.getUTCMonth() === month - 1
      && calendarDate.getUTCDate() === day;
  };
  return validInstant(fromDate) && validInstant(toDate)
    && (!fromDate || !toDate || Date.parse(fromDate) < Date.parse(toDate));
}

export async function registerRoutes(app: Express, options: RouteRegistrationOptions = {}): Promise<Server> {
  const googleContactsService = options.googleContactsService ?? defaultGoogleContactsService;
  const isTwilioConfigured = options.isTwilioConfigured ?? defaultIsTwilioConfigured;
  const sendSms = options.sendSms ?? defaultSendSms;
  const providerHealthAuthMiddleware = options.providerHealthAuthMiddleware ?? requireAuth;
  const recheckProviderHealthEmailCapacity =
    options.recheckProviderHealthEmailCapacity ?? (async () => {
      await checkEmailProviderCapacityOnce();
      return getEmailCapacityMonitoringStatus();
    });
  const getProviderHealthEmailCapacityStatus =
    options.getProviderHealthEmailCapacityStatus ?? getEmailCapacityMonitoringStatus;
  const getProviderHealthWarningSettings =
    options.getProviderHealthWarningSettings ?? getEmailCapacityWarningSettings;
  const getProviderHealthWarningSettingsAudit =
    options.getProviderHealthWarningSettingsAudit ?? getEmailCapacityWarningSettingsAudit;
  const updateProviderHealthWarningSettings =
    options.updateProviderHealthWarningSettings ?? updateEmailCapacityWarningSettings;
  const jobClientId = async (job: any): Promise<number | null> => {
    if (job?.contactId == null) return null;
    const contact = await storage.getCrmContact(job.contactId);
    return contact?.clientId ?? null;
  };
  const canSeeClient = (scope: StaffAssignmentScope, clientId: number | null | undefined) =>
    scope.unrestricted || (clientId != null && scope.clientIds.has(clientId));
  const canSeeContact = (scope: StaffAssignmentScope, contactId: number | null | undefined) =>
    scope.unrestricted || (contactId != null && scope.contactIds.has(contactId));
  const canEditContact = (scope: StaffAssignmentScope, contactId: number | null | undefined) =>
    scope.unrestricted || (contactId != null && scope.editableContactIds.has(contactId));
  const canSeeJob = async (scope: StaffAssignmentScope, job: any) =>
    scope.unrestricted || scope.jobIds.has(job.id) || canSeeClient(scope, await jobClientId(job));
  const canSeeServiceLog = async (scope: StaffAssignmentScope, log: any) => {
    if (scope.unrestricted) return true;
    const job = log?.jobId == null ? null : await storage.getCrmJob(Number(log.jobId));
    const contact = log?.contactId == null ? null : await storage.getCrmContact(Number(log.contactId));
    if (log?.jobId != null && !job) return false;
    if (log?.contactId != null && !contact) return false;
    if (job && contact && job.contactId !== contact.id) return false;
    if (job) return canSeeJob(scope, job);
    if (contact) return canSeeClient(scope, contact.clientId);
    return false;
  };
  const canSeeAlert = async (scope: StaffAssignmentScope, alert: any) => {
    if (!canViewStaffRecoveryAlert(scope.staffAdministrator, alert?.alertSource)) {
      return false;
    }
    if (scope.unrestricted) return true;
    const device = alert?.deviceId == null ? null : await storage.getDevice(Number(alert.deviceId));
    if (alert?.deviceId != null && !device) return false;
    if (device && alert?.clientId != null && device.clientId !== Number(alert.clientId)) return false;
    if (device) return canSeeClient(scope, device.clientId);
    if (alert?.clientId != null) return canSeeClient(scope, Number(alert.clientId));
    return false;
  };
  const canWriteServiceLog = async (scope: StaffAssignmentScope, log: any) => {
    if (scope.unrestricted) return true;
    const job = log?.jobId == null ? null : await storage.getCrmJob(Number(log.jobId));
    if (log?.jobId != null && (!job || !(await canSeeJob(scope, job)))) return false;
    if (log?.contactId != null) {
      const contact = await storage.getCrmContact(Number(log.contactId));
      if (!contact) return false;
      if (job) return job.contactId === contact.id;
      return canSeeClient(scope, contact.clientId);
    }
    return Boolean(job);
  };
  const scopedJobs = async (req: Request, jobs: any[]) => {
    const scope = await getStaffAssignmentScope(req);
    return scope.unrestricted ? jobs : (await Promise.all(jobs.map(async (job) => (await canSeeJob(scope, job)) ? job : null))).filter(Boolean);
  };
  // Auth/session and the global /api auth gate are configured in index.ts before
  // this runs, so every /api route registered here is protected by default
  // unless its path is on the public allowlist.
  registerBillingRoutes(app);
  registerHelpdeskRoutes(app);
  registerPttRoutes(app);
  registerStaffDispatchRoutes(app);
  registerServiceContractRoutes(app);
  registerMarketplaceRoutes(app, { mailer: options.marketplaceMailer, scanReader: options.marketplaceScanReader, lookupReader: options.marketplaceLookupReader });
  registerReferralRoutes(app, { mailer: options.referralMailer });
  registerVoiceIntakeRoutes(app);
  await ensureInvoiceSchema();
  await applyCatalogInvoiceLinkMigration();
  registerCatalogRoutes(app);
  await ensureInvoiceTemplatesSchema();
  await ensureMailboxSchema();
  await ensureAriaActionSchema();
  await ensureIntakeEmailAuditSchema();
  registerInvoiceTemplateRoutes(app);
  registerInvoiceRoutes(app);
  await ensurePayPalImportSchema();
  registerPayPalImportRoutes(app);
  await ensureContactImportIndexes();
  registerContactImportRoutes(app, { authMiddleware: options.contactImportAuthMiddleware });
  if (!options.disableBackgroundServices) {
    startInvoiceEmailOutboxWorker();
    startMailboxWorker();
    startEmailProviderCapacityMonitor();
  }

  // Health check for Fly.io (and any other uptime monitor). Must be cheap
  // and dependency-free — no DB query, no external API call.
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime(), ts: Date.now() });
  });
  app.get("/api/healthz", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime(), ts: Date.now() });
  });

  // ---- Technician toolbox: network checker (DNS / HTTP / TCP port) ----
  // Browsers can't resolve DNS, open raw TCP sockets, or ICMP-ping, so the
  // technician network tool calls this endpoint. Read-only, no DB.
  app.post("/api/tech-tools/network-check", async (req, res) => {
    const { default: dns } = await import("node:dns");
    const net = await import("node:net");
    const dnsp = dns.promises;

    // ---- SSRF guard: reject any non-public destination -------------------
    // This endpoint connects to a user-supplied host, so it must never be
    // usable to probe internal/private/cloud-metadata addresses. We resolve
    // the host ONCE, verify every resolved IP is publicly routable, then
    // connect only to that validated IP (closing the DNS-rebinding window).
    const isPublicIpv4 = (ip: string): boolean => {
      const o = ip.split(".").map(Number);
      if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
      const [a, b] = o;
      if (a === 0 || a === 10 || a === 127) return false; // this-network, private, loopback
      if (a === 169 && b === 254) return false; // link-local (incl. 169.254.169.254 metadata)
      if (a === 172 && b >= 16 && b <= 31) return false; // private
      if (a === 192 && b === 168) return false; // private
      if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
      if (a === 192 && b === 0) return false; // 192.0.0.0/24, 192.0.2.0/24 reserved/TEST-NET
      if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
      if (a === 198 && b === 51) return false; // TEST-NET-2
      if (a === 203 && b === 0) return false; // TEST-NET-3
      if (a >= 224) return false; // multicast + reserved (224.0.0.0+)
      return true;
    };
    const isPublicIp = (raw: string): boolean => {
      const fam = net.isIP(raw);
      if (fam === 4) return isPublicIpv4(raw);
      if (fam === 6) {
        const ip = raw.toLowerCase();
        if (ip === "::1" || ip === "::") return false; // loopback / unspecified
        if (ip.startsWith("fe80") || ip.startsWith("fc") || ip.startsWith("fd")) return false; // link-local / ULA
        if (ip.startsWith("ff")) return false; // multicast
        const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
        if (mapped) return isPublicIpv4(mapped[1]);
        if (mapped === null && /::ffff:[0-9a-f:]+$/.test(ip)) return false;
        return true;
      }
      return false;
    };

    const rawHost = String(req.body?.host ?? "").trim();
    const portRaw = req.body?.port;
    if (!rawHost) {
      res.status(400).json({ error: "Host is required" });
      return;
    }

    // Normalize: strip scheme + path so users can paste a full URL.
    let host = rawHost;
    try {
      if (/^https?:\/\//i.test(rawHost)) host = new URL(rawHost).hostname;
      else host = rawHost.replace(/^[a-z]+:\/\//i, "").split("/")[0].split(":")[0];
    } catch {
      host = rawHost;
    }
    host = host.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
    if (!/^[a-zA-Z0-9.\-:_]+$/.test(host)) {
      res.status(400).json({ error: "That doesn't look like a valid hostname or IP." });
      return;
    }
    if (/^localhost$/i.test(host)) {
      res.status(400).json({ error: "Refusing to scan localhost or internal addresses." });
      return;
    }

    const result: any = { host, checkedAt: Date.now() };

    // DNS resolution (or accept an IP literal), with timing.
    const dnsStart = Date.now();
    let resolved: { address: string; family: number }[] = [];
    if (net.isIP(host)) {
      resolved = [{ address: host, family: net.isIP(host) }];
      result.dns = { ok: true, ms: 0, addresses: resolved.map((a) => ({ address: a.address, family: `IPv${a.family}` })) };
    } else {
      try {
        resolved = await dnsp.lookup(host, { all: true });
        result.dns = {
          ok: true,
          ms: Date.now() - dnsStart,
          addresses: resolved.map((a) => ({ address: a.address, family: `IPv${a.family}` })),
        };
      } catch (e: any) {
        result.dns = { ok: false, ms: Date.now() - dnsStart, error: e?.code || e?.message || "DNS lookup failed" };
      }
    }

    // SSRF gate: refuse if anything resolves to a non-public address.
    if (resolved.length > 0 && !resolved.every((a) => isPublicIp(a.address))) {
      res.status(400).json({
        error: "Refusing to scan a private, loopback, or internal address. Only public hosts are allowed.",
      });
      return;
    }

    // All connections go to this validated public IP (no re-resolution).
    const targetIp = resolved.find((a) => isPublicIp(a.address))?.address;

    // Raw TCP reachability probe against the already-validated IP.
    const tcpProbe = (ip: string, port: number, timeoutMs = 6000) =>
      new Promise<{ open: boolean; ms: number; error?: string }>((resolve) => {
        const start = Date.now();
        const socket = new net.Socket();
        let done = false;
        const finish = (open: boolean, error?: string) => {
          if (done) return;
          done = true;
          try { socket.destroy(); } catch {}
          resolve({ open, ms: Date.now() - start, ...(error ? { error } : {}) });
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false, "Connection timed out (port closed or filtered)"));
        socket.once("error", (err: any) => finish(false, err?.code || "Connection refused"));
        try { socket.connect(port, ip); } catch (e: any) { finish(false, e?.message || "Could not connect"); }
      });

    // Web-server reachability: test HTTPS (443) then HTTP (80) on the IP.
    if (targetIp) {
      const httpsProbe = await tcpProbe(targetIp, 443);
      if (httpsProbe.open) {
        result.http = { ok: true, ms: httpsProbe.ms, scheme: "https" };
      } else {
        const httpProbe = await tcpProbe(targetIp, 80);
        result.http = httpProbe.open
          ? { ok: true, ms: httpProbe.ms, scheme: "http" }
          : { ok: false, ms: httpProbe.ms, error: "No web server responded on port 443 or 80" };
      }
    }

    // Optional explicit TCP port check.
    const port = Number(portRaw);
    if (portRaw !== undefined && portRaw !== null && String(portRaw).trim() !== "") {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        result.port = { ok: false, error: "Port must be a whole number between 1 and 65535." };
      } else if (!targetIp) {
        result.port = { ok: false, port, error: "Could not resolve host to a public address." };
      } else {
        const probe = await tcpProbe(targetIp, port);
        result.port = { ok: probe.open, port, ms: probe.ms, ...(probe.error ? { error: probe.error } : {}) };
      }
    }

    res.json(result);
  });

  app.get("/api/tech-tools/windows-optimization-script", (_req, res) => {
    const scriptPath = path.resolve(process.cwd(), "scripts", "Optimize-WindowsEndpoint.ps1");
    res.download(scriptPath, "Optimize-WindowsEndpoint.ps1", (error) => {
      if (error && !res.headersSent) {
        console.error("[tech-tools] Windows optimization script download failed:", error);
        res.status(500).json({ error: "Windows optimization script is unavailable" });
      }
    });
  });

  // Users list (for helpdesk assignment dropdowns)
  app.get("/api/users", async (_req, res) => {
    try {
      const list = await storage.getUsers();
      res.json(list.map(({ password, ...u }) => u));
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  // Dashboard metrics
  app.get("/api/dashboard/metrics", async (req, res) => {
    try {
      const scope = await getStaffAssignmentScope(req);
      const devices = (await storage.getDevices()).filter((item) => canSeeClient(scope, item.clientId));
      const alerts = (await Promise.all((await storage.getActiveAlerts()).map(async (alert) =>
        await canSeeAlert(scope, alert) ? alert : null
      ))).filter(Boolean) as any[];
      const tickets = (await storage.getOpenTickets()).filter((item) => canSeeTicket(scope, item));

      // The RMM dashboard represents endpoints connected to an actual remote
      // management provider. Old manually seeded/demo rows have no provider
      // identity and must not be presented as live monitored machines.
      const monitoredDevices = devices.filter((device) =>
        Boolean(device.meshNodeId?.trim() || device.teamviewerId?.trim()),
      );
      const onlineDevices = monitoredDevices.filter((device) => device.status === "online").length;
      const totalDevices = monitoredDevices.length;
      const onlineRate =
        totalDevices > 0 ? Math.round((onlineDevices / totalDevices) * 100 * 10) / 10 : 0;
      const criticalAlerts = alerts.filter(
        (alert) => alert.severity.toLowerCase() === "critical",
      ).length;
      const attentionAlerts = alerts.filter((alert) =>
        ["warning", "high", "medium"].includes(alert.severity.toLowerCase()),
      ).length;
      const now = Date.now();
      const overdueTickets = tickets.filter((ticket) => {
        const dueAt = ticket.slaDueAt ?? ticket.dueAt;
        return dueAt ? new Date(dueAt).getTime() < now : false;
      }).length;
      
      res.json({
        totalDevices,
        activeAlerts: alerts.length,
        criticalAlerts,
        attentionAlerts,
        openTickets: tickets.length,
        unassignedTickets: tickets.filter((ticket) => !ticket.assignedTo).length,
        overdueTickets,
        onlineRate,
        onlineDevices,
        lastUpdatedAt: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch dashboard metrics" });
    }
  });

  // Device endpoints
  app.get("/api/devices", async (req, res) => {
    try {
      const scope = await getStaffAssignmentScope(req);
      const devices = (await storage.getDevices()).filter((item) => canSeeClient(scope, item.clientId));
      res.json(devices);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch devices" });
    }
  });

  app.get("/api/devices/:id", async (req, res) => {
    try {
      const device = await storage.getDevice(parseInt(req.params.id));
      const scope = await getStaffAssignmentScope(req);
      if (!device || !canSeeClient(scope, device.clientId)) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      res.json(device);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch device" });
    }
  });

  app.post("/api/devices", async (req, res) => {
    try {
      const deviceData = insertDeviceSchema.parse(req.body);
      const scope = await getStaffAssignmentScope(req);
      if (!canSeeClient(scope, deviceData.clientId)) {
        res.status(403).json({ error: "Customer assignment required" });
        return;
      }
      if (!isAdministratorScope(scope) && (deviceData.meshNodeId || deviceData.meshId || deviceData.teamviewerId)) {
        res.status(403).json({ error: "Administrator access required to bind a remote-management provider" });
        return;
      }
      const device = await storage.createDevice(deviceData);
      res.status(201).json(device);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid device data", details: error.issues });
        return;
      }
      res.status(500).json({ error: "Failed to create device" });
    }
  });

  app.put("/api/devices/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await storage.getDevice(id);
      const scope = await getStaffAssignmentScope(req);
      if (!existing || !canSeeClient(scope, existing.clientId)) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      if (req.body?.clientId !== undefined && !canSeeClient(scope, req.body.clientId)) {
        res.status(403).json({ error: "Customer assignment required" });
        return;
      }
      const providerFields = ["meshNodeId", "meshId", "teamviewerId"] as const;
      const changesProviderIdentity = providerFields.some((field) =>
        Object.prototype.hasOwnProperty.call(req.body ?? {}, field) && req.body[field] !== existing[field]
      );
      if (!isAdministratorScope(scope) && changesProviderIdentity) {
        res.status(403).json({ error: "Administrator access required to change a remote-management provider binding" });
        return;
      }
      const device = await storage.updateDevice(id, req.body);
      if (!device) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      res.json(device);
    } catch (error) {
      res.status(500).json({ error: "Failed to update device" });
    }
  });

  app.delete("/api/devices/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await storage.getDevice(id);
      const scope = await getStaffAssignmentScope(req);
      if (!existing || !canSeeClient(scope, existing.clientId)) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      const deleted = await storage.deleteDevice(id);
      if (!deleted) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete device" });
    }
  });

  // Alert endpoints
  app.get("/api/alerts", async (req, res) => {
    try {
      const scope = await getStaffAssignmentScope(req);
      const alerts = (await Promise.all((await storage.getAlerts()).map(async (alert) =>
        await canSeeAlert(scope, alert) ? alert : null
      ))).filter(Boolean);
      res.json(alerts);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch alerts" });
    }
  });

  app.get("/api/alerts/active", async (req, res) => {
    try {
      const scope = await getStaffAssignmentScope(req);
      const alerts = (await Promise.all((await storage.getActiveAlerts()).map(async (alert) =>
        await canSeeAlert(scope, alert) ? alert : null
      ))).filter(Boolean);
      res.json(alerts);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch active alerts" });
    }
  });

  app.post("/api/alerts", async (req, res) => {
    try {
      const alertData = insertAlertSchema.parse(req.body);
      const scope = await getStaffAssignmentScope(req);
      if (!canCreateAlertForSource(scope.staffAdministrator, alertData.alertSource)) {
        res.status(403).json({ error: "Administrator access required" });
        return;
      }
      if (!(await canSeeAlert(scope, alertData))) {
        res.status(403).json({ error: "Customer or device assignment required" });
        return;
      }
      const alert = await storage.createAlert(alertData);

      // Emergency-alert dispatch (SMS/email/Slack cascade) — record any
      // failure on the response so callers know the alert was stored but
      // notifications didn't go out.
      const warnings: string[] = [];
      try {
        await emergencyAlertService.processAlert({
          id: alert.id,
          title: alert.title,
          description: alert.description || '',
          severity: alert.severity,
          category: alert.category || 'general',
          deviceId: alert.deviceId ?? undefined,
          clientId: alert.clientId ?? undefined,
          isEmergency: alert.isEmergency || false,
          businessImpact: alert.businessImpact || 'unknown'
        });
      } catch (emergencyError: any) {
        const msg = emergencyError?.message ?? String(emergencyError);
        console.error("Emergency alert dispatch failed:", msg);
        warnings.push(`Emergency notification dispatch failed: ${msg}`);
      }

      res.status(201).json(warnings.length ? { ...alert, warnings } : alert);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid alert data", details: error.issues });
        return;
      }
      res.status(500).json({ error: "Failed to create alert" });
    }
  });

  app.put("/api/alerts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await storage.getAlert(id);
      const scope = await getStaffAssignmentScope(req);
      if (!existing || !(await canSeeAlert(scope, existing))) {
        res.status(404).json({ error: "Alert not found" });
        return;
      }
      if (!(await canSeeAlert(scope, { ...existing, ...req.body }))) {
        res.status(403).json({ error: "Customer or device assignment required" });
        return;
      }
      const alert = await storage.updateAlert(id, req.body);
      if (!alert) {
        res.status(404).json({ error: "Alert not found" });
        return;
      }
      res.json(alert);
    } catch (error) {
      res.status(500).json({ error: "Failed to update alert" });
    }
  });

  // Ticket endpoints
  app.get("/api/tickets", async (req, res) => {
    try {
      const scope = await getStaffAssignmentScope(req);
      const tickets = (await storage.getTickets()).filter((item) => canSeeTicket(scope, item));
      res.json(tickets);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch tickets" });
    }
  });

  app.get("/api/tickets/open", async (req, res) => {
    try {
      const scope = await getStaffAssignmentScope(req);
      const tickets = (await storage.getOpenTickets()).filter((item) => canSeeTicket(scope, item));
      res.json(tickets);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch open tickets" });
    }
  });

  app.get("/api/tickets/:id", async (req, res) => {
    try {
      const ticket = await storage.getTicket(parseInt(req.params.id));
      const scope = await getStaffAssignmentScope(req);
      if (!ticket || !canSeeTicket(scope, ticket)) {
        res.status(404).json({ error: "Ticket not found" });
        return;
      }
      res.json(ticket);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch ticket" });
    }
  });

  app.post("/api/tickets", async (req, res) => {
    try {
      const ticketData = insertTicketSchema.parse(req.body);
      const scope = await getStaffAssignmentScope(req);
      if (!canSeeClient(scope, ticketData.clientId)) {
        res.status(403).json({ error: "Customer assignment required" });
        return;
      }
      const ticket = await storage.createTicket(ticketData);

      // Persist the best-effort notification immediately after the ticket save;
      // delivery runs asynchronously in the outbox worker.
      let client = null;
      try {
        client = ticketData.clientId ? await storage.getClient(ticketData.clientId) : null;
      } catch {
        console.warn("Could not load ticket customer for Slack notification");
      }
      await queueTicketNotification(ticket, client);

      // Helpdesk pipeline: assign ticket #, access token, defaults,
      // filter routing, SLA due date, autoresponder, staff notice, activity log.
      const enriched = await enrichNewTicket(ticket);

      res.status(201).json(enriched);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid ticket data", details: error.issues });
        return;
      }
      res.status(500).json({ error: "Failed to create ticket" });
    }
  });

  app.put("/api/tickets/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await storage.getTicket(id);
      const scope = await getStaffAssignmentScope(req);
      if (!existing || !canSeeTicket(scope, existing)) {
        res.status(404).json({ error: "Ticket not found" });
        return;
      }
      // Moving a ticket to another account needs access to that account; an
      // assignee resaving the ticket with its current account does not.
      if (req.body?.clientId !== undefined && req.body.clientId !== existing.clientId && !canSeeClient(scope, req.body.clientId)) {
        res.status(403).json({ error: "Customer assignment required" });
        return;
      }
      const ticket = await storage.updateTicket(id, req.body);
      if (!ticket) {
        res.status(404).json({ error: "Ticket not found" });
        return;
      }
      res.json(ticket);
    } catch (error) {
      res.status(500).json({ error: "Failed to update ticket" });
    }
  });

  // Client endpoints
  app.get("/api/clients", async (req, res) => {
    try {
      const scope = await getStaffAssignmentScope(req);
      const clients = (await storage.getClients()).filter((item) => canSeeClient(scope, item.id));
      res.json(clients);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch clients" });
    }
  });

  // Account-level CRM view. Contacts remain people; all indirect records are
  // resolved through their contact's clientId rather than conflating IDs.
  registerContactOverviewRoute(app, { canSeeClient, canSeeContact });
  registerCustomerPhotoRoutes(app, { canSeeClient });
  if (false) {
  app.get("/api/clients/:id/overview", async (req, res) => {
    try {
      const clientId = Number(req.params.id);
      if (!Number.isSafeInteger(clientId) || clientId < 1) {
        res.status(400).json({ error: "Invalid client id" });
        return;
      }
      const client = await storage.getClient(clientId);
      const scope = await getStaffAssignmentScope(req);
      if (!client || !canSeeClient(scope, clientId)) {
        res.status(404).json({ error: "Client not found" });
        return;
      }
      const [contacts, devices, alerts, tickets, jobs, appointments] = await Promise.all([
        storage.getCrmContacts(), storage.getDevices(), storage.getActiveAlerts(), storage.getTickets(),
        storage.getCrmJobs(), storage.getAppointments(),
      ]);
      const relatedContacts = contacts.filter((contact) =>
        contact.clientId === clientId && canSeeContact(scope, contact.id)
      );
      const contactIds = new Set(relatedContacts.map((contact) => contact.id));
      const canonicalPhone = (value: string | null | undefined) => {
        const raw = String(value ?? "").trim();
        const digits = raw.replace(/\D/g, "");
        if (digits.length === 10) return `1${digits}`;
        if (digits.length >= 8 && digits.length <= 15 && (raw.startsWith("+") || (digits.length === 11 && digits.startsWith("1")))) return digits;
        return null;
      };
      // Phone/email fallbacks are used only when an identifier uniquely belongs
      // to one CRM contact across the whole system. Ambiguous identities stay
      // unlinked rather than leaking another customer's history.
      const globalPhoneOwners = new Map<string, Set<number>>();
      const globalEmailOwners = new Map<string, Set<number>>();
      for (const contact of contacts) {
        for (const phone of [contact.mobilePhone, contact.officePhone]) {
          const normalized = canonicalPhone(phone);
          if (!normalized) continue;
          const owners = globalPhoneOwners.get(normalized) ?? new Set<number>();
          owners.add(contact.id);
          globalPhoneOwners.set(normalized, owners);
        }
        const email = contact.email?.trim().toLowerCase();
        if (email) {
          const owners = globalEmailOwners.get(email) ?? new Set<number>();
          owners.add(contact.id);
          globalEmailOwners.set(email, owners);
        }
      }
      const phoneToContactId = new Map<string, number>();
      const intakeEmails: string[] = [];
      for (const [phone, owners] of globalPhoneOwners) {
        if (owners.size !== 1) continue;
        const [ownerId] = owners;
        if (contactIds.has(ownerId)) phoneToContactId.set(phone, ownerId);
      }
      for (const [email, owners] of globalEmailOwners) {
        if (owners.size !== 1) continue;
        const [ownerId] = owners;
        if (contactIds.has(ownerId)) intakeEmails.push(email);
      }
      const phoneDigits = [...phoneToContactId.keys()];
      const relatedJobs = jobs.filter((job) => job.contactId != null && contactIds.has(job.contactId));
      const [invoiceResult] = await Promise.all([
        pool.query("SELECT id, invoice_number, contact_id, client_id, job_id, status, currency, total_cents, due_date, sent_at, paid_at, created_at FROM invoices WHERE client_id=$1 OR (client_id IS NULL AND contact_id = ANY($2::int[])) ORDER BY created_at DESC", [clientId, [...contactIds]]),
      ]);
      const relatedAppointments = appointments.filter((appointment) => appointment.contactId != null && contactIds.has(appointment.contactId));
      // Sales context for the account: the leads, deals and original service
      // requests that intake created for this customer's people.
      const contactIdList = [...contactIds];
      const [leadResult, dealResult, intakeResult] = contactIdList.length
        ? await Promise.all([
            pool.query(
              `SELECT id, contact_id, service_type, device_type, brand_model, operating_system,
                      status, source, campaign, estimated_value, intake_record_id, created_at
               FROM crm_leads WHERE contact_id = ANY($1::int[]) ORDER BY created_at DESC`,
              [contactIdList],
            ),
            pool.query(
              `SELECT id, title, stage, estimated_mrr, one_time_fee, primary_contact_id, lead_id, created_at
               FROM crm_deals WHERE primary_contact_id = ANY($1::int[]) ORDER BY created_at DESC`,
              [contactIdList],
            ),
            pool.query(
              `SELECT r.id, r.service_type, r.device_type, r.device_brand_model, r.status,
                      r.source, r.how_did_you_hear, r.created_at
               FROM csd_intake_records r
               WHERE EXISTS (
                       SELECT 1 FROM intake_submissions s
                       WHERE s.intake_record_id = r.id AND s.contact_id = ANY($1::int[])
                     )
                  OR LOWER(TRIM(r.email_address)) = ANY($2::text[])
                  OR CASE
                       WHEN LENGTH(regexp_replace(r.phone_number, '[^0-9]', '', 'g')) = 10
                         THEN '1' || regexp_replace(r.phone_number, '[^0-9]', '', 'g')
                       ELSE regexp_replace(r.phone_number, '[^0-9]', '', 'g')
                     END = ANY($3::text[])
               ORDER BY r.created_at DESC`,
              [contactIdList, intakeEmails, phoneDigits],
            ),
          ])
        : [{ rows: [] as any[] }, { rows: [] as any[] }, { rows: [] as any[] }];
      const relatedLeads = leadResult.rows.map((row) => ({
        id: Number(row.id), contactId: row.contact_id == null ? null : Number(row.contact_id),
        serviceType: row.service_type, deviceType: row.device_type, brandModel: row.brand_model,
        operatingSystem: row.operating_system, status: row.status, source: row.source, campaign: row.campaign,
        estimatedValue: row.estimated_value == null ? null : Number(row.estimated_value),
        intakeRecordId: row.intake_record_id == null ? null : Number(row.intake_record_id),
        createdAt: row.created_at,
      }));
      const relatedDeals = dealResult.rows.map((row) => ({
        id: Number(row.id), title: row.title, stage: row.stage,
        estimatedMrr: row.estimated_mrr, oneTimeFee: row.one_time_fee,
        primaryContactId: row.primary_contact_id == null ? null : Number(row.primary_contact_id),
        leadId: row.lead_id == null ? null : Number(row.lead_id), createdAt: row.created_at,
      }));
      const relatedIntakes = intakeResult.rows.map((row) => ({
        id: Number(row.id), serviceType: row.service_type, deviceType: row.device_type,
        deviceBrandModel: row.device_brand_model, status: row.status, source: row.source,
        howDidYouHear: row.how_did_you_hear, createdAt: row.created_at,
      }));
      const compactDevices = devices.filter((device) => device.clientId === clientId).map((device) => ({ id: device.id, name: device.name, type: device.type, status: device.status, lastSeen: device.lastSeen }));
      const compactAlerts = alerts.filter((alert) => alert.clientId === clientId || (alert.deviceId != null && compactDevices.some((device) => device.id === alert.deviceId))).map((alert) => ({ id: alert.id, title: alert.title, severity: alert.severity, status: alert.status, deviceId: alert.deviceId, createdAt: alert.createdAt }));
      const compactTickets = tickets.filter((ticket) => ticket.clientId === clientId).map((ticket) => ({ id: ticket.id, ticketNumber: ticket.ticketNumber, subject: ticket.subject, priority: ticket.priority, status: ticket.status, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt }));
      const jobIds = relatedJobs.map((job) => job.id);
      const canViewCommunications = isAdminUser(req);
      const noRows = { rows: [] as any[] };
      const [callResult, smsResult, interactionResult, serviceLogResult] = await Promise.all([
        canViewCommunications ? pool.query(
          `SELECT id, call_sid, from_number, to_number, status, direction, duration_seconds,
                  had_voicemail, contact_id, created_at
             FROM call_log
            WHERE contact_id = ANY($1::int[])
               OR CASE
                    WHEN LENGTH(regexp_replace(from_number, '[^0-9]', '', 'g')) = 10
                      THEN '1' || regexp_replace(from_number, '[^0-9]', '', 'g')
                    ELSE regexp_replace(from_number, '[^0-9]', '', 'g')
                  END = ANY($2::text[])
               OR CASE
                    WHEN LENGTH(regexp_replace(to_number, '[^0-9]', '', 'g')) = 10
                      THEN '1' || regexp_replace(to_number, '[^0-9]', '', 'g')
                    ELSE regexp_replace(to_number, '[^0-9]', '', 'g')
                  END = ANY($2::text[])
            ORDER BY created_at DESC LIMIT 200`,
          [[...contactIds], phoneDigits],
        ) : noRows,
        canViewCommunications ? pool.query(
          `SELECT id, message_sid, from_number, to_number, body, direction, status, created_at
             FROM sms_messages
            WHERE CASE
                    WHEN LENGTH(regexp_replace(from_number, '[^0-9]', '', 'g')) = 10
                      THEN '1' || regexp_replace(from_number, '[^0-9]', '', 'g')
                    ELSE regexp_replace(from_number, '[^0-9]', '', 'g')
                  END = ANY($1::text[])
               OR CASE
                    WHEN LENGTH(regexp_replace(to_number, '[^0-9]', '', 'g')) = 10
                      THEN '1' || regexp_replace(to_number, '[^0-9]', '', 'g')
                    ELSE regexp_replace(to_number, '[^0-9]', '', 'g')
                  END = ANY($1::text[])
            ORDER BY created_at DESC LIMIT 200`,
          [phoneDigits],
        ) : noRows,
        pool.query(
          `SELECT id, contact_id, job_id, type, summary, details, performed_by, created_at
             FROM crm_interactions
            WHERE contact_id = ANY($1::int[]) OR job_id = ANY($2::int[])
            ORDER BY created_at DESC LIMIT 200`,
          [[...contactIds], jobIds],
        ),
        pool.query(
          `SELECT id, contact_id, job_id, client_name, device_model, hardware_action,
                  hardware_result, security_action, security_result, optimization_action,
                  optimization_result, technician_notes, performed_by, created_at, updated_at
             FROM service_logs
            WHERE contact_id = ANY($1::int[]) OR job_id = ANY($2::int[])
            ORDER BY created_at DESC LIMIT 200`,
          [[...contactIds], jobIds],
        ),
      ]);
      const matchedContactId = (row: any) => {
        if (row.contact_id != null && contactIds.has(Number(row.contact_id))) return Number(row.contact_id);
        for (const phone of [row.from_number, row.to_number]) {
          const normalized = canonicalPhone(phone);
          const id = normalized ? phoneToContactId.get(normalized) : null;
          if (id != null) return id;
        }
        return null;
      };
      const calls = callResult.rows.map((row) => ({
        id: Number(row.id), callSid: row.call_sid, fromNumber: row.from_number, toNumber: row.to_number,
        direction: row.direction, status: row.status, durationSeconds: row.duration_seconds,
        hadVoicemail: row.had_voicemail, contactId: matchedContactId(row), createdAt: row.created_at,
      }));
      const messages = smsResult.rows.map((row) => ({
        id: Number(row.id), messageSid: row.message_sid, fromNumber: row.from_number, toNumber: row.to_number,
        body: row.body, direction: row.direction, status: row.status,
        contactId: matchedContactId(row), createdAt: row.created_at,
      }));
      const interactions = interactionResult.rows.map((row) => ({
        id: Number(row.id), contactId: row.contact_id == null ? null : Number(row.contact_id),
        jobId: row.job_id == null ? null : Number(row.job_id), type: row.type, summary: row.summary,
        details: row.details, performedBy: row.performed_by, createdAt: row.created_at,
      }));
      const serviceLogs = serviceLogResult.rows.map((row) => ({
        id: Number(row.id), contactId: row.contact_id == null ? null : Number(row.contact_id),
        jobId: row.job_id == null ? null : Number(row.job_id), clientName: row.client_name,
        deviceModel: row.device_model, hardwareAction: row.hardware_action, hardwareResult: row.hardware_result,
        securityAction: row.security_action, securityResult: row.security_result,
        optimizationAction: row.optimization_action, optimizationResult: row.optimization_result,
        technicianNotes: row.technician_notes, performedBy: row.performed_by,
        createdAt: row.created_at, updatedAt: row.updated_at,
      }));
      type TimelineEvent = { id: string; kind: string; occurredAt: any; contactId: number | null; title: string; summary: string | null; status: string | null; sourceId: number | string; href: string };
      const timeline: TimelineEvent[] = [
        ...calls.map((call) => ({ id: `call-${call.id}`, kind: "call", occurredAt: call.createdAt, contactId: call.contactId, title: `${call.direction === "outbound" ? "Outbound" : "Inbound"} call`, summary: call.durationSeconds ? `${call.durationSeconds} seconds` : (call.hadVoicemail ? "Voicemail received" : null), status: call.status, sourceId: call.id, href: "/admin/call-tracking" })),
        ...messages.map((message) => ({ id: `sms-${message.id}`, kind: "sms", occurredAt: message.createdAt, contactId: message.contactId, title: `${message.direction === "outbound" ? "Outbound" : "Inbound"} SMS`, summary: message.body, status: message.status, sourceId: message.id, href: "/messages" })),
        ...interactions.map((item) => ({ id: `interaction-${item.id}`, kind: "interaction", occurredAt: item.createdAt, contactId: item.contactId, title: item.type.replace(/_/g, " "), summary: item.summary || item.details, status: null, sourceId: item.id, href: "/crm/contacts" })),
        ...serviceLogs.map((log) => ({ id: `service-log-${log.id}`, kind: "service_log", occurredAt: log.createdAt, contactId: log.contactId, title: `Service log: ${log.deviceModel}`, summary: log.technicianNotes || log.hardwareAction || log.securityAction || log.optimizationAction, status: null, sourceId: log.id, href: "/service-logs" })),
        ...relatedJobs.map((job) => ({ id: `job-${job.id}`, kind: "job", occurredAt: job.createdAt, contactId: job.contactId, title: job.jobNumber || job.serviceType, summary: job.description ?? null, status: job.status, sourceId: job.id, href: "/crm/jobs" })),
        ...compactTickets.map((ticket) => ({ id: `ticket-${ticket.id}`, kind: "ticket", occurredAt: ticket.createdAt, contactId: null, title: ticket.subject, summary: ticket.ticketNumber ?? null, status: ticket.status, sourceId: ticket.id, href: "/tickets" })),
        ...relatedAppointments.map((appointment) => ({ id: `appointment-${appointment.id}`, kind: "appointment", occurredAt: appointment.startsAt || appointment.createdAt, contactId: appointment.contactId, title: `Appointment ${appointment.reference}`, summary: appointment.customerNotes ?? null, status: appointment.status, sourceId: appointment.id, href: "/scheduling" })),
        ...invoiceResult.rows.map((invoice) => ({ id: `invoice-${invoice.id}`, kind: "invoice", occurredAt: invoice.created_at, contactId: invoice.contact_id == null ? null : Number(invoice.contact_id), title: `Invoice ${invoice.invoice_number}`, summary: `${invoice.currency} ${(Number(invoice.total_cents) / 100).toFixed(2)}`, status: invoice.status, sourceId: Number(invoice.id), href: `/invoices/${invoice.id}` })),
        ...relatedIntakes.map((intake) => ({ id: `intake-${intake.id}`, kind: "intake", occurredAt: intake.createdAt, contactId: null, title: `Intake: ${intake.serviceType}`, summary: intake.deviceBrandModel || intake.deviceType, status: intake.status, sourceId: intake.id, href: "/crm/leads" })),
      ].filter((event) => event.occurredAt != null)
        .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
        .slice(0, 100);
      const now = Date.now();
      const outstandingActions = [
        ...compactAlerts.map((alert) => ({ id: `alert-${alert.id}`, kind: "alert", title: alert.title, summary: null, priority: alert.severity, dueAt: null, status: alert.status, href: "/dashboard" })),
        ...tickets.filter((ticket) => ticket.clientId === clientId && !["closed", "resolved"].includes(ticket.status.toLowerCase())).map((ticket) => ({ id: `ticket-${ticket.id}`, kind: "ticket", title: ticket.subject, summary: ticket.description ?? ticket.ticketNumber ?? null, priority: ticket.priority, dueAt: ticket.dueAt ?? ticket.slaDueAt ?? null, status: ticket.status, href: "/tickets" })),
        ...relatedJobs.filter((job) => !["completed", "cancelled"].includes(job.status.toLowerCase())).map((job) => ({ id: `job-${job.id}`, kind: "job", title: job.jobNumber, summary: job.serviceType, priority: job.priority ?? "normal", dueAt: job.scheduledDateTime ?? null, status: job.status, href: "/crm/jobs" })),
        ...relatedAppointments.filter((appointment) => ["pending", "confirmed", "in_progress"].includes(appointment.status) && new Date(appointment.startsAt).getTime() >= now).map((appointment) => ({ id: `appointment-${appointment.id}`, kind: "appointment", title: `Appointment ${appointment.reference}`, summary: appointment.customerNotes ?? null, priority: "normal", dueAt: appointment.startsAt, status: appointment.status, href: "/scheduling" })),
        ...invoiceResult.rows.filter((invoice) => !["paid", "void"].includes(String(invoice.status).toLowerCase())).map((invoice) => ({ id: `invoice-${invoice.id}`, kind: "invoice", title: `Invoice ${invoice.invoice_number}`, summary: `${invoice.currency} ${(Number(invoice.total_cents) / 100).toFixed(2)}`, priority: invoice.due_date && new Date(invoice.due_date).getTime() < now ? "high" : "normal", dueAt: invoice.due_date, status: invoice.status, href: `/invoices/${invoice.id}` })),
      ];
      res.json({
        client: { id: client.id, name: client.name, contactEmail: client.contactEmail, contactPhone: client.contactPhone, address: client.address, city: client.city, state: client.state, zipCode: client.zipCode, createdAt: client.createdAt },
        contacts: relatedContacts.map(overviewContact),
        devices: compactDevices, activeAlerts: compactAlerts, tickets: compactTickets,
        jobs: relatedJobs.map((job) => overviewJob(job, clientId)),
        invoices: invoiceResult.rows.map(overviewInvoice),
        appointments: relatedAppointments.map((appointment) => overviewAppointment(appointment, clientId)),
        leads: relatedLeads, deals: relatedDeals, intakes: relatedIntakes,
        timeline,
        communications: { calls, messages, interactions, serviceLogs, summary: { calls: calls.length, messages: messages.length, interactions: interactions.length, serviceLogs: serviceLogs.length } },
        outstandingActions,
        counts: { contacts: relatedContacts.length, devices: compactDevices.length, activeAlerts: compactAlerts.length, tickets: compactTickets.length, openTickets: compactTickets.filter((ticket) => !["closed", "resolved"].includes(ticket.status.toLowerCase())).length, jobs: relatedJobs.length, invoices: invoiceResult.rowCount ?? invoiceResult.rows.length, appointments: relatedAppointments.length, leads: relatedLeads.length, deals: relatedDeals.length, intakes: relatedIntakes.length },
      });
    } catch (error) {
      logger.error({ error }, "Client overview failed");
      res.status(500).json({ error: "Failed to fetch client overview" });
    }
  });

  }
  app.get("/api/clients/:id", async (req, res) => {
    try {
      const client = await storage.getClient(parseInt(req.params.id));
      const scope = await getStaffAssignmentScope(req);
      if (!client || !canSeeClient(scope, client.id)) {
        res.status(404).json({ error: "Client not found" });
        return;
      }
      res.json(client);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch client" });
    }
  });

  app.post("/api/clients", async (req, res) => {
    try {
      const clientData = insertClientSchema.parse(req.body);
      const client = await storage.createClient(clientData);
      res.status(201).json(client);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid client data", details: error.issues });
        return;
      }
      res.status(500).json({ error: "Failed to create client" });
    }
  });

  app.put("/api/clients/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const scope = await getStaffAssignmentScope(req);
      if (!canSeeClient(scope, id)) {
        res.status(404).json({ error: "Client not found" });
        return;
      }
      const client = await storage.updateClient(id, req.body);
      if (!client) {
        res.status(404).json({ error: "Client not found" });
        return;
      }
      res.json(client);
    } catch (error) {
      res.status(500).json({ error: "Failed to update client" });
    }
  });

  // Network scan endpoints
  app.get("/api/network-scans", async (req, res) => {
    try {
      const scans = await storage.getNetworkScans();
      res.json(scans);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch network scans" });
    }
  });

  app.post("/api/network-scans", async (req, res) => {
    try {
      const scanData = insertNetworkScanSchema.parse(req.body);
      const scan = await storage.createNetworkScan(scanData);
      res.status(201).json(scan);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid scan data", details: error.issues });
        return;
      }
      res.status(500).json({ error: "Failed to create network scan" });
    }
  });

  // Automation script endpoints
  app.get("/api/automation-scripts", async (req, res) => {
    try {
      const scripts = await storage.getAutomationScripts();
      res.json(scripts);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch automation scripts" });
    }
  });

  app.get("/api/automation-scripts/:id", async (req, res) => {
    try {
      const script = await storage.getAutomationScript(parseInt(req.params.id));
      if (!script) {
        res.status(404).json({ error: "Script not found" });
        return;
      }
      res.json(script);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch script" });
    }
  });

  app.post("/api/automation-scripts", async (req, res) => {
    try {
      const scriptData = insertAutomationScriptSchema.parse(req.body);
      const script = await storage.createAutomationScript(scriptData);
      res.status(201).json(script);
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.warn("[automation-scripts] validation failed:", error.issues);
        res.status(400).json({ error: "Invalid script data", details: error.issues });
        return;
      }
      console.error("[automation-scripts] create failed:", error);
      res.status(500).json({ error: "Failed to create script" });
    }
  });

  app.put("/api/automation-scripts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const script = await storage.updateAutomationScript(id, req.body);
      if (!script) {
        res.status(404).json({ error: "Script not found" });
        return;
      }
      res.json(script);
    } catch (error) {
      res.status(500).json({ error: "Failed to update script" });
    }
  });

  // Real-time monitoring — returns the most recent telemetry from each device
  // row. Values are whatever the agent last reported (0 / null if no agent).
  // Active alerts per device are joined in for the UI.
  app.get("/api/monitoring/realtime", async (req, res) => {
    try {
      const scope = await getStaffAssignmentScope(req);
      const [allDevices, activeAlerts] = await Promise.all([
        storage.getDevices(),
        storage.getActiveAlerts(),
      ]);
      const devices = allDevices.filter((device) => canSeeClient(scope, device.clientId));
      const visibleDeviceIds = new Set(devices.map((device) => device.id));
      const alertsByDevice = new Map<number, typeof activeAlerts>();
      for (const a of activeAlerts) {
        if (a.deviceId == null || !visibleDeviceIds.has(a.deviceId)) continue;
        const list = alertsByDevice.get(a.deviceId) ?? [];
        list.push(a);
        alertsByDevice.set(a.deviceId, list);
      }
      const monitoringData = devices.map(device => ({
        deviceId: device.id,
        deviceName: device.name,
        status: device.status,
        cpuUsage: device.cpuUsage ?? null,
        memoryUsage: device.memoryUsage ?? null,
        diskUsage: device.diskUsage ?? null,
        networkLatency: device.networkLatency ?? null,
        uptimeHours: device.uptimeHours ?? null,
        antivirusStatus: device.antivirusStatus ?? "unknown",
        firewallStatus: device.firewallStatus ?? "unknown",
        patchStatus: device.patchStatus ?? "unknown",
        backupStatus: device.backupStatus ?? "unknown",
        lastSeen: device.lastSeen,
        alerts: alertsByDevice.get(device.id) ?? [],
      }));
      res.json(monitoringData);
    } catch (error) {
      console.error("monitoring/realtime error:", error);
      res.status(500).json({ error: "Failed to fetch monitoring data" });
    }
  });

  // Patch management — patches surface what device agents have reported into
  // device_patches. Empty until a MeshCentral agent posts inventory.
  app.get("/api/patches", async (req, res) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const deviceId = req.query.deviceId ? parseInt(String(req.query.deviceId), 10) : undefined;
      if (deviceId != null && !(await canAccessAssignedDevice(req, deviceId))) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      const patches = (await Promise.all((await storage.getDevicePatches({ status, deviceId })).map(async (patch) =>
        patch.deviceId != null && await canAccessAssignedDevice(req, patch.deviceId) ? patch : null
      ))).filter(Boolean) as any[];
      // Group identical KBs across devices so the UI can show one row per patch.
      const byKb = new Map<string, any>();
      for (const p of patches) {
        const existing = byKb.get(p.kbId);
        if (existing) {
          if (p.deviceId != null) existing.deviceIds.push(p.deviceId);
        } else {
          byKb.set(p.kbId, {
            id: p.kbId,
            title: p.title,
            description: p.description,
            severity: p.severity,
            category: p.category,
            size: p.sizeBytes,
            installTime: p.installTimeMinutes,
            requiresReboot: p.requiresReboot,
            status: p.status,
            releaseDate: p.releaseDate,
            deviceIds: p.deviceId != null ? [p.deviceId] : [],
          });
        }
      }
      res.json(Array.from(byKb.values()));
    } catch (error) {
      console.error("/api/patches error:", error);
      res.status(500).json({ error: "Failed to fetch patches" });
    }
  });

  app.post("/api/patches/install", async (req, res) => {
    try {
      const { patchIds, deviceIds, scheduleTime } = req.body ?? {};
      if (!Array.isArray(patchIds) || patchIds.length === 0) {
        res.status(400).json({ error: "patchIds (array) is required" });
        return;
      }
      if (!Array.isArray(deviceIds) || deviceIds.length === 0) {
        res.status(400).json({ error: "deviceIds (array) is required" });
        return;
      }
      if (!(await Promise.all(deviceIds.map((id: unknown) => canAccessAssignedDevice(req, Number(id))))).every(Boolean)) {
        res.status(403).json({ error: "Device assignment required" });
        return;
      }
      const scheduledFor = scheduleTime ? new Date(scheduleTime) : new Date();
      const job = await storage.createPatchJob({
        jobType: "install",
        patchIds: patchIds.join(","),
        deviceIds: deviceIds.join(","),
        status: scheduleTime && scheduledFor > new Date() ? "scheduled" : "running",
        scheduledFor,
        createdBy: null,
      } as any);
      // Mark the targeted patches as "installing" so the UI reflects intent.
      for (const did of deviceIds) {
        const existing = await storage.getDevicePatches({ deviceId: Number(did) });
        for (const dp of existing) {
          if (patchIds.includes(dp.kbId)) {
            await storage.updateDevicePatch(dp.id, { status: "installing" });
          }
        }
      }
      await queueAutomationNotification(
        `patch-install-${job.id}`,
        { name: "Patch Installation", type: "patch-install" },
        "success",
        `Queued ${patchIds.length} patch(es) on ${deviceIds.length} device(s)`,
      );
      res.json({
        installationId: job.id,
        patchIds,
        deviceIds,
        status: job.status,
        scheduledTime: job.scheduledFor,
      });
    } catch (error) {
      console.error("/api/patches/install error:", error);
      res.status(500).json({ error: "Failed to install patches" });
    }
  });

  app.post("/api/patches/download", async (req, res) => {
    try {
      const { patchIds, deviceIds = [] } = req.body ?? {};
      if (!Array.isArray(patchIds) || patchIds.length === 0) {
        res.status(400).json({ error: "patchIds (array) is required" });
        return;
      }
      if (!Array.isArray(deviceIds) ||
          !(await Promise.all(deviceIds.map((id: unknown) => canAccessAssignedDevice(req, Number(id))))).every(Boolean)) {
        res.status(403).json({ error: "Device assignment required" });
        return;
      }
      const job = await storage.createPatchJob({
        jobType: "download",
        patchIds: patchIds.join(","),
        deviceIds: Array.isArray(deviceIds) ? deviceIds.join(",") : "",
        status: "running",
        scheduledFor: new Date(),
        createdBy: null,
      } as any);
      res.json({
        downloadId: job.id,
        patchIds,
        status: job.status,
        progress: job.progress ?? 0,
      });
    } catch (error) {
      console.error("/api/patches/download error:", error);
      res.status(500).json({ error: "Failed to download patches" });
    }
  });

  app.get("/api/patch-policies", async (_req, res) => {
    try {
      const policies = await storage.getPatchPolicies();
      res.json(policies.map(p => ({
        ...p,
        severityFilter: (p.severityFilter ?? "").split(",").filter(Boolean),
        excludePatches: (p.excludePatches ?? "").split(",").filter(Boolean),
      })));
    } catch (error) {
      console.error("/api/patch-policies error:", error);
      res.status(500).json({ error: "Failed to fetch patch policies" });
    }
  });

  app.post("/api/patch-policies", async (req, res) => {
    try {
      const body = req.body ?? {};
      const policy = await storage.createPatchPolicy({
        name: String(body.name ?? "").trim() || "New Policy",
        autoInstall: !!body.autoInstall,
        maintenanceWindow: body.maintenanceWindow ?? "02:00-06:00",
        severityFilter: Array.isArray(body.severityFilter) ? body.severityFilter.join(",") : (body.severityFilter ?? "critical"),
        excludePatches: Array.isArray(body.excludePatches) ? body.excludePatches.join(",") : (body.excludePatches ?? ""),
        testGroupPercentage: typeof body.testGroupPercentage === "number" ? body.testGroupPercentage : 10,
        isActive: body.isActive !== false,
      });
      res.status(201).json(policy);
    } catch (error) {
      console.error("POST /api/patch-policies error:", error);
      res.status(500).json({ error: "Failed to create patch policy" });
    }
  });

  app.put("/api/patch-policies/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const body = req.body ?? {};
      const update: any = { ...body };
      if (Array.isArray(body.severityFilter)) update.severityFilter = body.severityFilter.join(",");
      if (Array.isArray(body.excludePatches)) update.excludePatches = body.excludePatches.join(",");
      const policy = await storage.updatePatchPolicy(id, update);
      if (!policy) {
        res.status(404).json({ error: "Patch policy not found" });
        return;
      }
      res.json(policy);
    } catch (error) {
      res.status(500).json({ error: "Failed to update patch policy" });
    }
  });

  app.delete("/api/patch-policies/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const ok = await storage.deletePatchPolicy(id);
      if (!ok) {
        res.status(404).json({ error: "Patch policy not found" });
        return;
      }
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete patch policy" });
    }
  });

  // Script execution — runs the stored script through MeshCentral on the
  // requested device (or all devices that match the script's target type).
  // Without a configured MeshCentral, the request is rejected with 503 rather
  // than fabricating success.
  app.post("/api/automation-scripts/:id/execute", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const script = await storage.getAutomationScript(id);
      if (!script) {
        res.status(404).json({ error: "Script not found" });
        return;
      }
      if (!meshCentralService.isConfigured()) {
        res.status(503).json({
          error: "MeshCentral is not configured (MESHCENTRAL_URL missing); cannot execute scripts on devices.",
        });
        return;
      }

      const { deviceIds } = req.body ?? {};
      const targets: number[] = Array.isArray(deviceIds) ? deviceIds.map(Number).filter(Number.isFinite) : [];
      if (targets.length === 0) {
        res.status(400).json({ error: "deviceIds (array) is required" });
        return;
      }
      if (!(await Promise.all(targets.map((deviceId) => canAccessAssignedDevice(req, deviceId)))).every(Boolean)) {
        res.status(403).json({ error: "Device assignment required" });
        return;
      }

      const meshClient = getMeshCentralClient();
      if (!meshClient) {
        res.status(503).json({ error: "MeshCentral client unavailable" });
        return;
      }

      const startTime = new Date();
      const results: { deviceId: number; status: string; output: string }[] = [];
      for (const deviceId of targets) {
        const device = await storage.getDevice(deviceId);
        if (!device?.meshNodeId) {
          results.push({ deviceId, status: "failed", output: "Device has no MeshCentral node id" });
          continue;
        }
        try {
          const cmdResult = await meshClient.executeCommand(device.meshNodeId, script.scriptContent);
          const ok = cmdResult && !cmdResult.error;
          results.push({
            deviceId,
            status: ok ? "completed" : "failed",
            output: ok ? "Dispatched to device" : (cmdResult?.error ?? "Unknown error"),
          });
        } catch (err: any) {
          results.push({ deviceId, status: "failed", output: err?.message ?? String(err) });
        }
      }
      const endTime = new Date();
      const anyFailed = results.some(r => r.status === "failed");
      const allFailed = results.every(r => r.status === "failed");

      // Each invocation is a distinct event, even when the same script runs again.
      // Persist the notice before responding; the outbox worker delivers it later.
      await queueAutomationNotification(
        `automation-execution-${randomUUID()}`,
        script,
        allFailed ? "failure" : "success",
        results.map(r => `Device ${r.deviceId}: ${r.status}`).join("; "),
      );

      res.json({
        scriptId: id,
        status: allFailed ? "failed" : anyFailed ? "partial" : "completed",
        results,
        startTime,
        endTime,
      });
    } catch (error: any) {
      console.error("Script execution error:", error);
      res.status(500).json({ error: error?.message ?? "Failed to execute script" });
    }
  });

  // Remote access session endpoints
  app.get("/api/remote-sessions/active", async (req, res) => {
    try {
      const sessions = await storage.getActiveRemoteSessions();
      const visible = (await Promise.all(sessions.map(async (session) =>
        await canAccessAssignedDevice(req, session.deviceId) ? session : null
      ))).filter(Boolean);
      res.json(visible);
    } catch (error) {
      console.error("Failed to fetch active sessions:", error);
      res.status(500).json({ error: "Failed to fetch active sessions" });
    }
  });

  // Start a MeshCentral session
  app.post("/api/remote-sessions/start", async (req, res) => {
    try {
      const { deviceId, sessionType = "desktop", recording = true, sourceType, sourceId } = req.body;

      const device = await storage.getDevice(deviceId);
      if (!device || !(await canAccessAssignedDevice(req, deviceId))) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      if (device.status !== "online") {
        res.status(400).json({ error: "Device is offline" });
        return;
      }
      if (!device.meshNodeId) {
        res.status(400).json({
          error: "MeshCentral is not configured for this device",
          hint: "Set the device's meshNodeId or use the TeamViewer launcher instead.",
        });
        return;
      }

      const meshClient = getMeshCentralClient();
      let sessionUrl: string | null = null;

      if (meshClient) {
        try {
          await meshClient.authenticate();
          switch (sessionType) {
            case "desktop":
              sessionUrl = await meshClient.startRemoteDesktop(device.meshNodeId, recording);
              break;
            case "terminal":
              sessionUrl = await meshClient.startTerminal(device.meshNodeId);
              break;
            case "files":
              sessionUrl = await meshClient.startFileManager(device.meshNodeId);
              break;
            case "chat":
              await meshClient.sendChatMessage(
                device.meshNodeId,
                "A technician has initiated a chat session.",
              );
              sessionUrl = `${process.env.MESHCENTRAL_URL}/chat/${device.meshNodeId}`;
              break;
          }
        } catch (meshError) {
          console.warn("MeshCentral session failed:", meshError);
        }
      }

      if (!sessionUrl) {
        res.status(502).json({ error: "MeshCentral did not return a session URL" });
        return;
      }

      const session = await storage.createRemoteSession({
        deviceId: device.id,
        clientId: device.clientId ?? null,
        userId: req.dbUser?.id ?? null,
        provider: "meshcentral",
        sessionType,
        meshSessionId: sessionUrl,
        sourceType: sourceType ?? "manual",
        sourceId: sourceId ?? null,
        status: "active",
        recordingEnabled: recording,
        userAgent: req.get("user-agent") ?? null,
        clientIpAddress: req.ip ?? null,
      } as any);

      res.json({
        id: session.id,
        deviceId: device.id,
        deviceName: device.name,
        provider: "meshcentral",
        sessionType,
        sessionUrl,
        launchUrl: sessionUrl,
        recordingEnabled: recording,
        startTime: session.startTime,
      });
    } catch (error) {
      console.error("Failed to start MeshCentral session:", error);
      res.status(500).json({ error: "Failed to start remote session" });
    }
  });

  // Start a TeamViewer session via deep-link
  app.post("/api/remote-sessions/teamviewer/start", async (req, res) => {
    try {
      const { deviceId, sessionType = "desktop", sourceType, sourceId, password } = req.body;

      const device = await storage.getDevice(deviceId);
      if (!device || !(await canAccessAssignedDevice(req, deviceId))) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      const tvId = normalizeTeamviewerId(device.teamviewerId);
      if (!tvId) {
        res.status(400).json({
          error: "Device has no TeamViewer ID configured",
          code: "TEAMVIEWER_ID_MISSING",
        });
        return;
      }

      const launchUrl = buildTeamviewerLaunchUrl({
        teamviewerId: tvId,
        sessionType: sessionType === "files" ? "filetransfer" : "control",
        password,
      });

      const session = await storage.createRemoteSession({
        deviceId: device.id,
        clientId: device.clientId ?? null,
        userId: req.dbUser?.id ?? null,
        provider: "teamviewer",
        sessionType,
        teamviewerSessionCode: tvId,
        teamviewerLaunchUrl: launchUrl,
        sourceType: sourceType ?? "manual",
        sourceId: sourceId ?? null,
        status: "active",
        recordingEnabled: false,
        userAgent: req.get("user-agent") ?? null,
        clientIpAddress: req.ip ?? null,
      } as any);

      res.json({
        id: session.id,
        deviceId: device.id,
        deviceName: device.name,
        provider: "teamviewer",
        sessionType,
        launchUrl,
        sessionUrl: launchUrl,
        teamviewerId: tvId,
        startTime: session.startTime,
      });
    } catch (error) {
      console.error("Failed to start TeamViewer session:", error);
      res.status(500).json({ error: "Failed to start TeamViewer session" });
    }
  });

  // --- Phone-to-remote support codes ---------------------------------------
  // A technician generates a short, single-use 6-digit code for a device; the
  // customer types it into the public Remote Support widget (served below at
  // /remote-support) to be dropped straight into a MeshCentral session on
  // remote.computersystemsdepot.com. See server/support-codes.ts for the lifecycle.

  // Public: the customer-facing widget page. Served same-origin so its
  // redeem-code fetch needs no CORS. Embedded into the WordPress site via an
  // iframe (the [csd_remote_support] shortcode), so allow framing from there.
  app.get(["/remote-support", "/support"], (_req, res) => {
    res
      .type("html")
      .setHeader(
        "Content-Security-Policy",
        "frame-ancestors 'self' https://*.computersystemsdepot.com https://computersystemsdepot.com",
      );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(REMOTE_SUPPORT_WIDGET_HTML);
  });

  // Technician-only: mint a code for a device's MeshCentral session.
  app.post("/api/support/generate-code", requireAuth, async (req, res) => {
    try {
      const { deviceId, sessionType = "desktop" } = req.body ?? {};

      const device = await storage.getDevice(deviceId);
      if (!device || !(await canAccessAssignedDevice(req, deviceId))) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      if (!device.meshNodeId) {
        res.status(400).json({
          error: "MeshCentral is not configured for this device",
          hint: "Set the device's meshNodeId before generating a support code.",
        });
        return;
      }

      const redirectUrl = await meshCentralService.createRemoteSession(
        device.meshNodeId,
        sessionType,
      );
      if (!redirectUrl) {
        res.status(502).json({ error: "MeshCentral did not return a session URL" });
        return;
      }

      const record = createSupportCode({
        redirectUrl,
        deviceId: device.id,
        meshNodeId: device.meshNodeId,
        sessionType,
      });

      res.json({
        code: record.code,
        deviceId: device.id,
        deviceName: device.name,
        sessionType: record.sessionType,
        expiresAt: new Date(record.expiresAt).toISOString(),
      });
    } catch (error) {
      console.error("Failed to generate support code:", error);
      res.status(500).json({ error: "Failed to generate support code" });
    }
  });

  // Public: the customer-facing widget redeems a code for a redirect URL.
  // Intentionally vague on failure so the 6-digit space can't be probed.
  app.post("/api/support/redeem-code", publicWriteLimiter, async (req, res) => {
    try {
      const parsed = redeemCodeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          message: "A valid code is required.",
        });
        return;
      }
      const clientKey = req.ip || req.get("x-forwarded-for") || "unknown";
      const result = redeemSupportCode(parsed.data.code, clientKey);

      if (!result.ok) {
        if (result.reason === "throttled") {
          res.status(429).json({
            ok: false,
            message: "Too many attempts. Please wait a minute, then call 954-637-7300.",
          });
          return;
        }
        res.status(200).json({
          ok: false,
          message: "That code wasn't recognized or has expired. Please call us at 954-637-7300.",
        });
        return;
      }

      // Record the redemption as an active session for audit/visibility.
      try {
        await storage.createRemoteSession({
          deviceId: result.record.deviceId ?? null,
          provider: "meshcentral",
          sessionType: result.record.sessionType,
          meshSessionId: result.record.redirectUrl,
          sourceType: "support_code",
          status: "active",
          recordingEnabled: true,
          userAgent: req.get("user-agent") ?? null,
          clientIpAddress: req.ip ?? null,
        } as any);
      } catch (sessionError) {
        // Don't block the customer's connection on a bookkeeping failure.
        console.warn("Could not record support-code session:", sessionError);
      }

      res.json({ ok: true, redirectUrl: result.record.redirectUrl });
    } catch (error) {
      console.error("Failed to redeem support code:", error);
      res.status(500).json({ ok: false, message: "Something went wrong. Please call 954-637-7300." });
    }
  });

  app.post("/api/remote-sessions/:id/end", async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id);
      if (Number.isNaN(sessionId)) {
        res.status(400).json({ error: "Invalid session id" });
        return;
      }
      const existing = (await storage.getActiveRemoteSessions()).find((session) => session.id === sessionId);
      if (!existing || !(await canAccessAssignedDevice(req, existing.deviceId))) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const session = await storage.endRemoteSession(sessionId, {
        status: req.body?.status ?? "ended",
      });
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      res.json(session);
    } catch (error) {
      console.error("Failed to end session:", error);
      res.status(500).json({ error: "Failed to end session" });
    }
  });

  app.delete("/api/remote-sessions/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) {
        res.status(400).json({ error: "Invalid session id" });
        return;
      }
      const existing = (await storage.getActiveRemoteSessions()).find((session) => session.id === id);
      if (!existing || !(await canAccessAssignedDevice(req, existing.deviceId))) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const deleted = await storage.deleteRemoteSession(id);
      if (!deleted) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to delete session:", error);
      res.status(500).json({ error: "Failed to delete session" });
    }
  });

  app.get("/api/remote-sessions/recordings", async (req, res) => {
    try {
      const recordings = await storage.getRemoteSessionRecordings();
      const scope = await getStaffAssignmentScope(req);
      const devices = (await storage.getDevices()).filter((device) => canSeeClient(scope, device.clientId));
      const deviceById = new Map(devices.map(d => [d.id, d]));
      res.json(recordings.filter((r) => deviceById.has(r.deviceId)).map(r => ({
        id: r.id,
        deviceId: r.deviceId,
        deviceName: deviceById.get(r.deviceId)?.name ?? `Device #${r.deviceId}`,
        sessionType: r.sessionType,
        provider: r.provider,
        startTime: r.startTime,
        endTime: r.endTime,
        duration: r.duration,
        recordingPath: r.recordingPath,
      })));
    } catch (error) {
      console.error("/api/remote-sessions/recordings error:", error);
      res.status(500).json({ error: "Failed to fetch session recordings" });
    }
  });

  // Emergency alert management
  app.post("/api/alerts/:id/acknowledge", async (req, res) => {
    try {
      const alertId = parseInt(req.params.id);
      const { userId } = req.body;
      const existing = await storage.getAlert(alertId);
      const scope = await getStaffAssignmentScope(req);
      if (!existing || !(await canSeeAlert(scope, existing))) {
        res.status(404).json({ error: "Alert not found" });
        return;
      }
      
      const alert = await storage.updateAlert(alertId, {
        status: 'acknowledged',
        acknowledgedBy: userId,
        acknowledgedAt: new Date()
      });

      if (alert) {
        res.json({ message: "Alert acknowledged successfully" });
      } else {
        res.status(404).json({ error: "Alert not found" });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to acknowledge alert" });
    }
  });

  app.get("/api/emergency-contacts", async (_req, res) => {
    try {
      const contacts = await storage.getEmergencyContacts();
      res.json(contacts);
    } catch (error) {
      console.error("/api/emergency-contacts error:", error);
      res.status(500).json({ error: "Failed to fetch emergency contacts" });
    }
  });

  app.get("/api/emergency-contacts/:clientId", async (req, res) => {
    try {
      const clientId = parseInt(req.params.clientId, 10);
      if (Number.isNaN(clientId)) {
        res.status(400).json({ error: "Invalid clientId" });
        return;
      }
      const contacts = await storage.getEmergencyContacts(clientId);
      res.json(contacts);
    } catch (error) {
      console.error("/api/emergency-contacts/:clientId error:", error);
      res.status(500).json({ error: "Failed to fetch emergency contacts" });
    }
  });

  app.post("/api/emergency-contacts", async (req, res) => {
    try {
      const body = req.body ?? {};
      if (!body.clientId || !body.name || !body.phone || !body.email) {
        res.status(400).json({ error: "clientId, name, phone, email are required" });
        return;
      }
      const contact = await storage.createEmergencyContact({
        clientId: Number(body.clientId),
        name: String(body.name),
        role: body.role ?? null,
        phone: String(body.phone),
        email: String(body.email),
        priority: typeof body.priority === "number" ? body.priority : 1,
        availableHours: body.availableHours ?? "24/7",
        notificationMethods: body.notificationMethods ?? "phone,sms,email",
        isActive: body.isActive !== false,
      });
      res.status(201).json(contact);
    } catch (error) {
      console.error("POST /api/emergency-contacts error:", error);
      res.status(500).json({ error: "Failed to create emergency contact" });
    }
  });

  app.put("/api/emergency-contacts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const contact = await storage.updateEmergencyContact(id, req.body ?? {});
      if (!contact) {
        res.status(404).json({ error: "Emergency contact not found" });
        return;
      }
      res.json(contact);
    } catch (error) {
      res.status(500).json({ error: "Failed to update emergency contact" });
    }
  });

  app.delete("/api/emergency-contacts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const ok = await storage.deleteEmergencyContact(id);
      if (!ok) {
        res.status(404).json({ error: "Emergency contact not found" });
        return;
      }
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete emergency contact" });
    }
  });

  // MeshCentral integration endpoints — backed by a real, externally-hosted
  // MeshCentral server (see docs/meshcentral-setup.md). When MESHCENTRAL_URL
  // is not set, /status reports not_configured and /devices returns [].
  app.get("/api/meshcentral/status", async (req, res) => {
    try {
      if (!meshCentralService.isConfigured()) {
        res.json({
          status: "not_configured",
          isConfigured: false,
          url: null,
          message: "MeshCentral is not configured. Set MESHCENTRAL_URL plus credentials.",
        });
        return;
      }
      const meshClient = getMeshCentralClient();
      const isAuthenticated = meshClient ? await meshClient.authenticate() : false;
      const reason = meshClient?.getLastAuthError();
      const unreachable = !isAuthenticated && !!reason && /unreachable/i.test(reason);
      res.json({
        status: isAuthenticated ? "connected" : unreachable ? "unreachable" : "authentication_failed",
        isConfigured: true,
        url: process.env.MESHCENTRAL_URL || null,
        message: isAuthenticated ? undefined : reason,
      });
    } catch (error) {
      res.status(500).json({
        status: "error",
        message: "Failed to check MeshCentral status",
      });
    }
  });

  app.get("/api/meshcentral/devices", async (req, res) => {
    try {
      const devices = await meshCentralService.getDevices();
      const scope = await getStaffAssignmentScope(req);
      if (scope.unrestricted) {
        res.json(devices);
        return;
      }
      const localDevices = (await storage.getDevices()).filter((device) =>
        device.meshNodeId && canSeeClient(scope, device.clientId)
      );
      const visibleNodeIds = new Set(localDevices.map((device) => device.meshNodeId));
      res.json(devices.filter((device) => visibleNodeIds.has(device.nodeid)));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch MeshCentral devices" });
    }
  });

  // Pull machines from the configured MeshCentral server into the local devices
  // table so Device Management, Monitoring and Network Discovery show them.
  app.post("/api/meshcentral/sync", async (req, res) => {
    try {
      const scope = await getStaffAssignmentScope(req);
      if (!isAdministratorScope(scope)) {
        res.status(403).json({ error: "Administrator access required" });
        return;
      }
      const result = await meshCentralService.syncDevices();
      if (!result.configured) {
        res.status(503).json({
          error: "MeshCentral is not configured (set MESHCENTRAL_URL plus credentials).",
        });
        return;
      }
      if (result.error) {
        res.status(502).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: "Failed to sync MeshCentral devices" });
    }
  });

  // Helpdesk integrations (Zendesk, Freshdesk, ServiceNow, etc.)
  app.get("/api/helpdesk/integrations", async (req, res) => {
    try {
      const clientId = req.query.clientId ? parseInt(String(req.query.clientId), 10) : undefined;
      const integrations = await storage.getHelpdeskIntegrations(clientId);
      res.json(integrations.map(i => ({
        id: i.id,
        clientId: i.clientId,
        type: i.integrationType,
        status: i.syncStatus,
        isActive: i.isActive,
        syncEnabled: i.syncEnabled,
        lastSync: i.lastSyncAt,
        syncedTickets: i.syncedTicketsCount ?? 0,
        apiEndpoint: i.apiEndpoint,
        authMethod: i.authMethod,
      })));
    } catch (error) {
      console.error("/api/helpdesk/integrations error:", error);
      res.status(500).json({ error: "Failed to fetch helpdesk integrations" });
    }
  });

  app.post("/api/helpdesk/integrations", async (req, res) => {
    try {
      const body = req.body ?? {};
      if (!body.integrationType) {
        res.status(400).json({ error: "integrationType is required" });
        return;
      }
      const integration = await storage.createHelpdeskIntegration({
        clientId: body.clientId ?? null,
        integrationType: body.integrationType,
        apiEndpoint: body.apiEndpoint ?? null,
        authMethod: body.authMethod ?? null,
        isActive: body.isActive !== false,
        syncEnabled: body.syncEnabled !== false,
        syncStatus: body.syncStatus ?? "pending",
      });
      res.status(201).json(integration);
    } catch (error) {
      console.error("POST /api/helpdesk/integrations error:", error);
      res.status(500).json({ error: "Failed to create helpdesk integration" });
    }
  });

  app.put("/api/helpdesk/integrations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const integration = await storage.updateHelpdeskIntegration(id, req.body ?? {});
      if (!integration) {
        res.status(404).json({ error: "Integration not found" });
        return;
      }
      res.json(integration);
    } catch (error) {
      res.status(500).json({ error: "Failed to update integration" });
    }
  });

  app.delete("/api/helpdesk/integrations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const ok = await storage.deleteHelpdeskIntegration(id);
      if (!ok) {
        res.status(404).json({ error: "Integration not found" });
        return;
      }
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: "Failed to delete integration" });
    }
  });

  // Additional missing endpoints
  app.delete("/api/alerts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const alert = await storage.getAlert(id);
      const scope = await getStaffAssignmentScope(req);
      if (!alert || !(await canSeeAlert(scope, alert))) {
        res.status(404).json({ error: "Alert not found" });
        return;
      }
      // Mark alert as resolved instead of deleting
      const updatedAlert = await storage.updateAlert(id, { status: "resolved", resolvedAt: new Date() });
      res.json(updatedAlert);
    } catch (error) {
      res.status(500).json({ error: "Failed to resolve alert" });
    }
  });

  app.delete("/api/tickets/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const ticket = await storage.getTicket(id);
      const scope = await getStaffAssignmentScope(req);
      if (!ticket || !canSeeTicket(scope, ticket)) {
        res.status(404).json({ error: "Ticket not found" });
        return;
      }
      // Mark ticket as closed instead of deleting
      const updatedTicket = await storage.updateTicket(id, { status: "closed", updatedAt: new Date() });
      res.json(updatedTicket);
    } catch (error) {
      res.status(500).json({ error: "Failed to close ticket" });
    }
  });

  app.delete("/api/clients/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const client = await storage.getClient(id);
      const scope = await getStaffAssignmentScope(req);
      if (!client || !canSeeClient(scope, id)) {
        res.status(404).json({ error: "Client not found" });
        return;
      }
      // Front desk can see every account but removing one stays with administrators.
      if (scope.frontDesk) {
        res.status(403).json({ error: "Administrator access required to delete accounts" });
        return;
      }
      try {
        const ok = await storage.deleteClient(id);
        if (!ok) {
          res.status(404).json({ error: "Client not found" });
          return;
        }
        res.status(200).json({ message: "Client deleted", id });
      } catch (err: any) {
        // Foreign-key violation: client still has devices / tickets / contacts.
        if (err?.code === "23503" || /foreign key|violates/i.test(err?.message ?? "")) {
          res.status(409).json({
            error: "Cannot delete client: dependent records exist (devices, tickets, or emergency contacts). Reassign or remove them first.",
          });
          return;
        }
        throw err;
      }
    } catch (error) {
      console.error("DELETE /api/clients/:id error:", error);
      res.status(500).json({ error: "Failed to delete client" });
    }
  });

  app.put("/api/network-scans/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const scan = await storage.updateNetworkScan(id, req.body);
      if (!scan) {
        res.status(404).json({ error: "Network scan not found" });
        return;
      }
      res.json(scan);
    } catch (error) {
      res.status(500).json({ error: "Failed to update network scan" });
    }
  });

  app.delete("/api/network-scans/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) {
        res.status(400).json({ error: "Invalid network scan id" });
        return;
      }
      const deleted = await storage.deleteNetworkScan(id);
      if (!deleted) {
        res.status(404).json({ error: "Network scan not found" });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete network scan" });
    }
  });

  app.delete("/api/automation-scripts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const script = await storage.getAutomationScript(id);
      if (!script) {
        res.status(404).json({ error: "Script not found" });
        return;
      }
      // Mark script as inactive instead of deleting
      const updatedScript = await storage.updateAutomationScript(id, { isActive: false });
      res.json(updatedScript);
    } catch (error) {
      res.status(500).json({ error: "Failed to deactivate script" });
    }
  });

  // MeshCentral agent installer URLs (from configured server)
  app.get("/api/meshcentral/agents", async (req, res) => {
    try {
      const agents = await meshCentralService.getAgentInstallers();
      res.json(agents);
    } catch (error) {
      res.status(500).json({ error: "Failed to get agent installers" });
    }
  });

  // ---- Public customer agent download (no login) ----
  // Whether the one-click download is currently available, so the public page
  // can show buttons vs. a "call us" fallback.
  app.get("/api/download/status", publicReadLimiter, async (_req, res) => {
    try {
      const meshId = await meshCentralService.resolveAgentMeshId();
      res.json({ available: Boolean(meshId) });
    } catch {
      res.json({ available: false });
    }
  });

  // Direct download: customer clicks a CSD link, we resolve the agent URL on the
  // MeshCentral server and redirect their browser straight to the installer.
  // They never see the MeshCentral dashboard.
  app.get("/api/download/agent", publicReadLimiter, async (req, res) => {
    const platform = String(req.query.platform || "windows").toLowerCase();
    if (!["windows", "mac", "linux"].includes(platform)) {
      res.status(400).json({ error: "Unknown platform" });
      return;
    }
    try {
      const url = await meshCentralService.getAgentDownloadUrl(
        platform as "windows" | "mac" | "linux",
      );
      if (!url) {
        res.status(503).json({
          error:
            "The remote support download isn't available right now. Please call us at 954-637-7300 and we'll connect you.",
        });
        return;
      }
      res.redirect(302, url);
    } catch (error) {
      res.status(502).json({ error: "Could not reach the remote support server." });
    }
  });

  app.post("/api/meshcentral/create-session", async (req, res) => {
    try {
      const { deviceId, sessionType } = req.body;
      const localDevice = (await storage.getDevices()).find((device) => device.meshNodeId === String(deviceId));
      if (!localDevice || !(await canAccessAssignedDevice(req, localDevice.id))) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      const sessionUrl = await meshCentralService.createRemoteSession(localDevice.meshNodeId, sessionType);
      if (sessionUrl) {
        res.json({ success: true, sessionUrl });
      } else {
        res.status(400).json({ error: "MeshCentral is not configured (MESHCENTRAL_URL missing)" });
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to create remote session" });
    }
  });

  // CSD Intake endpoints
  app.get("/api/intake", async (req, res) => {
    try {
      const { startDate, endDate, source, status, page = 1, limit = 50 } = req.query;

      // Date, source and status are independent filters and compose: the
      // previous if/else chain silently ignored every filter but the first.
      let intakes;
      if (startDate && endDate) {
        const start = new Date(startDate as string);
        const end = new Date(endDate as string);
        intakes = await storage.getCsdIntakesByDateRange(start, end);
      } else {
        intakes = await storage.getCsdIntakes();
      }
      if (source && typeof source === "string") {
        intakes = intakes.filter((intake) => intake.source === source);
      }
      if (status && typeof status === "string") {
        intakes = intakes.filter((intake) => intake.status === status);
      }

      // Simple pagination
      const pageNum = parseInt(page as string, 10);
      const limitNum = parseInt(limit as string, 10);
      const startIndex = (pageNum - 1) * limitNum;
      const paginatedIntakes = intakes.slice(startIndex, startIndex + limitNum);
      
      res.json({
        intakes: paginatedIntakes,
        total: intakes.length,
        page: pageNum,
        totalPages: Math.ceil(intakes.length / limitNum)
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch intake records" });
    }
  });

  app.get("/api/intake/:id", async (req, res) => {
    try {
      const intake = await storage.getCsdIntake(parseInt(req.params.id));
      if (!intake) {
        res.status(404).json({ error: "Intake record not found" });
        return;
      }
      res.json(intake);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch intake record" });
    }
  });

  app.get("/api/intake/:id/email-history", async (req, res) => {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!/^[1-9]\d*$/.test(rawId)) {
      res.status(404).json({ message: "Service request not found" });
      return;
    }
    const intakeId = Number(rawId);
    if (!Number.isSafeInteger(intakeId)) {
      res.status(404).json({ message: "Service request not found" });
      return;
    }
    try {
      const intake = await storage.getCsdIntake(intakeId);
      if (!intake) {
        res.status(404).json({ message: "Service request not found" });
        return;
      }
      const attempts = await listIntakeEmailAttempts(intakeId);
      res.json({ attempts });
      return;
    } catch {
      req.log.error({ intakeId }, "Service request email history could not be fetched");
      res.status(500).json({ message: "Could not fetch service request email history" });
      return;
    }
  });

  app.post("/api/intake/:id/email", staffIntakeEmailLimiter, async (req, res) => {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!/^[1-9]\d*$/.test(rawId)) {
      res.status(404).json({ message: "Service request not found" });
      return;
    }
    const parsed = SendIntakeEmailBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Enter a valid subject, message, and recipient email" });
      return;
    }
    const subject = parsed.data.subject.trim();
    const body = parsed.data.body.trim();
    if (!subject || !body) {
      res.status(400).json({ message: "Subject and message are required" });
      return;
    }

    const intakeId = Number(rawId);
    if (!Number.isSafeInteger(intakeId)) {
      res.status(404).json({ message: "Service request not found" });
      return;
    }
    try {
      const intake = await storage.getCsdIntake(intakeId);
      if (!intake) {
        res.status(404).json({ message: "Service request not found" });
        return;
      }
      const recipient = intake.emailAddress?.trim();
      if (!recipient || !z.email().safeParse(recipient).success) {
        res.status(400).json({ message: "This service request has no valid customer email address" });
        return;
      }
      if (recipient.toLowerCase() !== parsed.data.expectedEmail.trim().toLowerCase()) {
        res.status(409).json({ message: "The customer's email changed. Refresh the service request before sending." });
        return;
      }
      const html = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\n/g, "<br>");
      if (!req.dbUser?.id) {
        res.status(401).json({ message: "Authentication required" });
        return;
      }
      const senderName =
        [req.dbUser.firstName, req.dbUser.lastName]
          .map((part) => part?.trim())
          .filter((part): part is string => Boolean(part))
          .join(" ")
          .slice(0, 120) || "Staff member";
      const submission = await sendIntakeEmailWithAudit(
        {
          intakeId,
          senderId: String(req.dbUser.id),
          senderName,
          provider: isSmtpConfigured() ? "smtp" : "sendgrid",
        },
        () => sendEmail(recipient, subject, body, { html, operation: "intake" }),
      );
      if (!submission.submitted) {
        req.log.info({ intakeId, status: submission.status }, "Service request email submission did not succeed");
        res.status(502).json({
          message: submission.status === "rejected"
            ? "Email could not be submitted. Check delivery before retrying."
            : "Email submission outcome is uncertain. Check delivery before retrying.",
        });
        return;
      }
      req.log.info({ intakeId }, "Service request email submitted to provider");
      res.json({ submitted: true });
      return;
    } catch (error) {
      if (error instanceof IntakeEmailAuditWriteError) {
        req.log.error({ intakeId, stage: error.stage }, "Service request email audit could not be recorded");
        if (error.stage === "create") {
          res.status(500).json({ message: "Email was not sent because its audit could not be recorded." });
          return;
        }
        res.status(502).json({
          message: "Email submission status could not be recorded. Check delivery before retrying.",
        });
        return;
      }
      req.log.error({ intakeId }, "Service request email could not be prepared");
      res.status(500).json({ message: "Could not send this email right now" });
      return;
    }
  });

  app.put("/api/intake/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const intake = await storage.updateCsdIntake(id, req.body);
      if (!intake) {
        res.status(404).json({ error: "Intake record not found" });
        return;
      }
      res.json(intake);
    } catch (error) {
      res.status(500).json({ error: "Failed to update intake record" });
    }
  });

  app.delete("/api/intake/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) {
        res.status(400).json({ error: "Invalid intake id" });
        return;
      }
      const deleted = await storage.deleteCsdIntake(id);
      if (!deleted) {
        res.status(404).json({ error: "Intake record not found" });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete intake record" });
    }
  });

  // CSD analytics endpoints
  app.get("/api/intake/analytics/sources", async (req, res) => {
    try {
      const intakes = await storage.getCsdIntakes();
      
      const sourceStats = intakes.reduce((acc, intake) => {
        const source = intake.source || 'Unknown';
        acc[source] = (acc[source] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      
      const last7Days = await storage.getCsdIntakesByDateRange(sevenDaysAgo, now);
      const last30Days = await storage.getCsdIntakesByDateRange(thirtyDaysAgo, now);
      
      res.json({
        allTime: sourceStats,
        last7Days: last7Days.length,
        last30Days: last30Days.length,
        total: intakes.length
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch analytics" });
    }
  });

  // ========================================
  // CRM ENDPOINTS
  // ========================================

  // CRM Contacts
  registerContactCrmRoutes(app, { canSeeClient, canSeeContact, canEditContact });
  if (false) {
  // Legacy form payloads commonly send 0/"" for an unselected account. Treat
  // those as no link; only a real positive integer can select an account.
  app.get("/api/crm/contacts", async (req, res) => {
    try {
      const { search } = req.query;
      let contacts;
      if (search && typeof search === 'string') {
        contacts = await storage.searchCrmContacts(search);
      } else {
        contacts = await storage.getCrmContacts();
      }
      const scope = await getStaffAssignmentScope(req);
      contacts = contacts.filter((contact) => canSeeContact(scope, contact.id));
      res.json(contacts.map((contact) => ({
        ...contact,
        canEdit: canEditContact(scope, contact.id),
      })));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch contacts" });
    }
  });

  app.get("/api/crm/contacts/:id", async (req, res) => {
    try {
      const contact = await storage.getCrmContact(parseInt(req.params.id));
      const scope = await getStaffAssignmentScope(req);
      if (!contact || !canSeeContact(scope, contact.id)) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      res.json({ ...contact, canEdit: canEditContact(scope, contact.id) });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch contact" });
    }
  });

  app.post("/api/crm/contacts", async (req, res) => {
    try {
      const normalized = normalizeOptionalClientId(req.body?.clientId, Object.prototype.hasOwnProperty.call(req.body ?? {}, "clientId"));
      if (normalized.kind === "invalid") {
        res.status(400).json({ error: normalized.message });
        return;
      }
      const contactData = insertCrmContactSchema.parse({ ...req.body, clientId: normalized.kind === "id" ? normalized.clientId : null });
      if (contactData.clientId != null && !(await storage.getClient(contactData.clientId))) {
        res.status(400).json({ error: "Client account not found" });
        return;
      }
      const scope = await getStaffAssignmentScope(req);
      if (!scope.unrestricted) {
        res.status(403).json({ error: "Administrator access required to create contacts" });
        return;
      }
      const contact = await storage.createCrmContact(contactData);
      res.status(201).json({ ...contact, canEdit: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid contact data", details: error.issues });
        return;
      }
      res.status(500).json({ error: "Failed to create contact" });
    }
  });

  app.put("/api/crm/contacts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await storage.getCrmContact(id);
      const scope = await getStaffAssignmentScope(req);
      if (!existing || !canSeeContact(scope, existing.id)) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      if (!canEditContact(scope, existing.id)) {
        res.status(403).json({ error: "Contact edit assignment required" });
        return;
      }
      const update = { ...req.body };
      const normalized = normalizeOptionalClientId(update.clientId, Object.prototype.hasOwnProperty.call(update, "clientId"));
      if (normalized.kind === "invalid") {
        res.status(400).json({ error: normalized.message });
        return;
      }
      if (normalized.kind === "unlink") update.clientId = null;
      if (normalized.kind === "id") update.clientId = normalized.clientId;
      if (update.clientId != null && !(await storage.getClient(update.clientId))) {
        res.status(400).json({ error: "Client account not found" });
        return;
      }
      if (!canSeeClient(scope, update.clientId ?? existing.clientId)) {
        res.status(403).json({ error: "Customer assignment required" });
        return;
      }
      const contact = await storage.updateCrmContact(id, update);
      if (!contact) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      res.json(contact);
    } catch (error) {
      res.status(500).json({ error: "Failed to update contact" });
    }
  });

  // Frontend uses PATCH for updates — accept it too.
  app.patch("/api/crm/contacts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await storage.getCrmContact(id);
      const scope = await getStaffAssignmentScope(req);
      if (!existing || !canSeeContact(scope, existing.id)) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      if (!canEditContact(scope, existing.id)) {
        res.status(403).json({ error: "Contact edit assignment required" });
        return;
      }
      const update = { ...req.body };
      const normalized = normalizeOptionalClientId(update.clientId, Object.prototype.hasOwnProperty.call(update, "clientId"));
      if (normalized.kind === "invalid") {
        res.status(400).json({ error: normalized.message });
        return;
      }
      if (normalized.kind === "unlink") update.clientId = null;
      if (normalized.kind === "id") update.clientId = normalized.clientId;
      if (update.clientId != null && !(await storage.getClient(update.clientId))) {
        res.status(400).json({ error: "Client account not found" });
        return;
      }
      if (!canSeeClient(scope, update.clientId ?? existing.clientId)) {
        res.status(403).json({ error: "Customer assignment required" });
        return;
      }
      const contact = await storage.updateCrmContact(id, update);
      if (!contact) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      res.json(contact);
    } catch (error) {
      res.status(500).json({ error: "Failed to update contact" });
    }
  });

  app.delete("/api/crm/contacts/:id", async (req, res) => {
    try {
      if (!isAdminUser(req)) {
        res.status(403).json({ error: "Administrator access required" });
        return;
      }
      const id = parseInt(req.params.id);
      const ok = await storage.deleteCrmContact(id);
      if (!ok) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      if (error instanceof ContactDeletionConflictError) {
        res.status(409).json({
          error: "Cannot delete contact: invoice or booking history requires this contact.",
        });
        return;
      }
      req.log.error({ err: error }, "Delete contact failed");
      res.status(500).json({ error: "Failed to delete contact" });
    }
  });

  app.post("/api/crm/contacts/find-or-create", async (req, res) => {
    try {
      const { fullName, mobilePhone, email, ...rest } = req.body;
      const normalized = normalizeOptionalClientId(rest.clientId, Object.prototype.hasOwnProperty.call(req.body ?? {}, "clientId"));
      if (normalized.kind === "invalid") {
        res.status(400).json({ error: normalized.message });
        return;
      }
      rest.clientId = normalized.kind === "id" ? normalized.clientId : null;
      if (rest.clientId != null && !(await storage.getClient(rest.clientId))) {
        res.status(400).json({ error: "Client account not found" });
        return;
      }
      const scope = await getStaffAssignmentScope(req);
      if (!canSeeClient(scope, rest.clientId)) {
        res.status(403).json({ error: "Customer assignment required" });
        return;
      }
      
      // Try to find existing contact by phone or email
      let contact = await storage.getCrmContactByPhoneOrEmail(mobilePhone, email);
      if (contact && !canSeeClient(scope, contact.clientId)) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      
      if (!contact) {
        // Create new contact
        const contactData = insertCrmContactSchema.parse({ fullName, mobilePhone, email, ...rest });
        contact = await storage.createCrmContact(contactData);
      }
      
      res.json(contact);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid contact data", details: error.issues });
        return;
      }
      res.status(500).json({ error: "Failed to find or create contact" });
    }
  });

  }
  // CRM Leads
  app.get("/api/crm/leads", async (req, res) => {
    try {
      const { status, contactId } = req.query;
      let leads;
      
      if (status && typeof status === 'string') {
        leads = await storage.getCrmLeadsByStatus(status);
      } else if (contactId) {
        leads = await storage.getCrmLeadsByContact(parseInt(contactId as string));
      } else {
        leads = await storage.getCrmLeads();
      }
      res.json(leads);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch leads" });
    }
  });

  app.get("/api/crm/leads/:id", async (req, res) => {
    try {
      const lead = await storage.getCrmLead(parseInt(req.params.id));
      if (!lead) {
        res.status(404).json({ error: "Lead not found" });
        return;
      }
      res.json(lead);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch lead" });
    }
  });

  // A lead does not have to belong to a contact, and the edit form's contact
  // <Select> reports "nothing selected" as 0. Resolve that to null so it never
  // reaches the contact_id foreign key, and reject an id no contact owns with a
  // 400 the form can show instead of an opaque 500.
  const resolveLeadContactId = async (
    body: any,
  ): Promise<{ ok: true; contactId?: number | null } | { ok: false; message: string }> => {
    const supplied = Object.prototype.hasOwnProperty.call(body ?? {}, "contactId");
    const normalized = normalizeOptionalRefId(body?.contactId, supplied, "contactId");
    if (normalized.kind === "invalid") return { ok: false, message: normalized.message };
    if (normalized.kind === "omitted") return { ok: true };
    if (normalized.kind === "unlink") return { ok: true, contactId: null };
    if (!(await storage.getCrmContact(normalized.id))) {
      return { ok: false, message: "Contact not found" };
    }
    return { ok: true, contactId: normalized.id };
  };

  app.post("/api/crm/leads", async (req, res) => {
    try {
      const contact = await resolveLeadContactId(req.body);
      if (!contact.ok) {
        res.status(400).json({ error: contact.message });
        return;
      }
      const leadData = insertCrmLeadSchema.parse({ ...req.body, contactId: contact.contactId ?? null });
      const lead = await storage.createCrmLead(leadData);
      res.status(201).json(lead);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid lead data", details: error.issues });
        return;
      }
      logger.error(`[crm] create lead failed: ${(error as Error)?.message ?? error}`);
      res.status(500).json({ error: "Failed to create lead" });
    }
  });

  // Accept both PUT and PATCH — the client edit dialog sends PATCH.
  const updateCrmLeadHandler = async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id);
      const update = { ...req.body };
      const contact = await resolveLeadContactId(req.body);
      if (!contact.ok) {
        res.status(400).json({ error: contact.message });
        return;
      }
      if (contact.contactId !== undefined) update.contactId = contact.contactId;
      const lead = await storage.updateCrmLead(id, update);
      if (!lead) {
        res.status(404).json({ error: "Lead not found" });
        return;
      }
      res.json(lead);
    } catch (error) {
      logger.error(`[crm] update lead ${req.params.id} failed: ${(error as Error)?.message ?? error}`);
      res.status(500).json({ error: "Failed to update lead" });
    }
  };
  app.put("/api/crm/leads/:id", updateCrmLeadHandler);
  app.patch("/api/crm/leads/:id", updateCrmLeadHandler);

  // CRM Lead stats for dashboard
  app.get("/api/crm/leads/stats/pipeline", async (req, res) => {
    try {
      const leads = await storage.getCrmLeads();
      
      const pipeline = {
        new: leads.filter(l => l.status === 'new').length,
        contacted: leads.filter(l => l.status === 'contacted').length,
        qualified: leads.filter(l => l.status === 'qualified').length,
        quoted: leads.filter(l => l.status === 'quoted').length,
        won: leads.filter(l => l.status === 'won').length,
        lost: leads.filter(l => l.status === 'lost').length,
      };
      
      const totalValue = leads
        .filter(l => l.estimatedValue && l.status !== 'lost')
        .reduce((sum, l) => sum + (l.estimatedValue || 0), 0);
      
      res.json({ pipeline, totalValue, total: leads.length });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch lead pipeline stats" });
    }
  });

  // CRM Jobs/Work Orders
  const withJobAccount = async (job: any) => {
    const contact = job.contactId == null ? undefined : await storage.getCrmContact(job.contactId);
    const client = contact?.clientId == null ? undefined : await storage.getClient(contact.clientId);
    return { ...job, clientId: contact?.clientId ?? null, clientName: client?.name ?? null };
  };
  app.get("/api/crm/jobs", async (req, res) => {
    try {
      const { status, leadId } = req.query;
      let jobs;
      
      if (status && typeof status === 'string') {
        jobs = await storage.getCrmJobsByStatus(status);
      } else if (leadId) {
        jobs = await storage.getCrmJobsByLead(parseInt(leadId as string));
      } else {
        jobs = await storage.getCrmJobs();
      }
      jobs = await scopedJobs(req, jobs);
      res.json(await Promise.all(jobs.map(withJobAccount)));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch jobs" });
    }
  });

  app.get("/api/crm/jobs/:id", async (req, res) => {
    try {
      const job = await storage.getCrmJob(parseInt(req.params.id));
      const scope = await getStaffAssignmentScope(req);
      if (!job || !(await canSeeJob(scope, job))) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      res.json(await withJobAccount(job));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch job" });
    }
  });

  app.post("/api/crm/jobs", async (req, res) => {
    try {
      // Generate job number
      const jobNumber = await storage.getNextJobNumber();
      const jobData = insertCrmJobSchema.parse({ ...req.body, jobNumber });
      const contact = jobData.contactId == null ? null : await storage.getCrmContact(jobData.contactId);
      if (jobData.contactId != null && !contact) {
        res.status(400).json({ error: "CRM contact not found" });
        return;
      }
      const scope = await getStaffAssignmentScope(req);
      if (!scope.unrestricted && (!contact || !canSeeClient(scope, contact.clientId))) {
        res.status(403).json({ error: "Customer assignment required" });
        return;
      }
      const job = await storage.createCrmJob(jobData);
      res.status(201).json(await withJobAccount(job));
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid job data", details: error.issues });
        return;
      }
      res.status(500).json({ error: "Failed to create job" });
    }
  });

  // Accept both PUT and PATCH — the client edit dialog sends PATCH.
  const updateCrmJobHandler = async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await storage.getCrmJob(id);
      const scope = await getStaffAssignmentScope(req);
      if (!existing || !(await canSeeJob(scope, existing))) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      if (req.body?.contactId != null) {
        const destination = await storage.getCrmContact(Number(req.body.contactId));
        if (!destination) {
          res.status(400).json({ error: "CRM contact not found" });
          return;
        }
        if (Number(req.body.contactId) !== existing.contactId && !canSeeClient(scope, destination.clientId)) {
          res.status(403).json({ error: "Customer assignment required" });
          return;
        }
      }
      let update: ReturnType<typeof crmJobUpdateFromBody>;
      try {
        update = crmJobUpdateFromBody(req.body, existing);
      } catch (validationError: any) {
        res.status(400).json({ error: validationError.message });
        return;
      }
      const job = await storage.updateCrmJob(id, update);
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      res.json(await withJobAccount(job));
    } catch (error) {
      res.status(500).json({ error: "Failed to update job" });
    }
  };
  app.put("/api/crm/jobs/:id", updateCrmJobHandler);
  app.patch("/api/crm/jobs/:id", updateCrmJobHandler);

  // CRM Job stats
  app.get("/api/crm/jobs/stats/summary", async (req, res) => {
    try {
      const jobs = await scopedJobs(req, await storage.getCrmJobs()) as any[];
      
      const summary = {
        open: jobs.filter(j => j.status === 'open').length,
        inProgress: jobs.filter(j => j.status === 'in_progress').length,
        waitingParts: jobs.filter(j => j.status === 'waiting_parts').length,
        completed: jobs.filter(j => j.status === 'completed').length,
        cancelled: jobs.filter(j => j.status === 'cancelled').length,
      };
      
      const revenue = jobs
        .filter(j => j.status === 'completed' && j.finalAmount)
        .reduce((sum, j) => sum + (j.finalAmount || 0), 0);
      
      res.json({ summary, revenue, total: jobs.length });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch job stats" });
    }
  });

  // CRM Interactions
  if (false) {
  const interactionContactId = async (interaction: any): Promise<number | null> => {
    if (interaction?.contactId != null) return Number(interaction.contactId);
    if (interaction?.leadId != null) return (await storage.getCrmLead(Number(interaction.leadId)))?.contactId ?? null;
    if (interaction?.jobId != null) return (await storage.getCrmJob(Number(interaction.jobId)))?.contactId ?? null;
    return null;
  };
  app.get("/api/crm/interactions", async (req, res) => {
    try {
      const { contactId, leadId, jobId } = req.query;
      let interactions;
      
      if (contactId) {
        interactions = await storage.getCrmInteractionsByContact(parseInt(contactId as string));
      } else if (leadId) {
        interactions = await storage.getCrmInteractionsByLead(parseInt(leadId as string));
      } else if (jobId) {
        interactions = await storage.getCrmInteractionsByJob(parseInt(jobId as string));
      } else {
        interactions = await storage.getCrmInteractions();
      }
      const scope = await getStaffAssignmentScope(req);
      const visible = (await Promise.all(interactions.map(async (interaction) =>
        canSeeContact(scope, await interactionContactId(interaction)) ? interaction : null
      ))).filter(Boolean);
      res.json(visible);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch interactions" });
    }
  });

  app.get("/api/crm/interactions/:id", async (req, res) => {
    try {
      const interaction = await storage.getCrmInteraction(parseInt(req.params.id));
      const scope = await getStaffAssignmentScope(req);
      if (!interaction || !canSeeContact(scope, await interactionContactId(interaction))) {
        res.status(404).json({ error: "Interaction not found" });
        return;
      }
      res.json(interaction);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch interaction" });
    }
  });

  app.post("/api/crm/interactions", async (req, res) => {
    try {
      const interactionData = insertCrmInteractionSchema.parse(req.body);
      const scope = await getStaffAssignmentScope(req);
      const contactId = await interactionContactId(interactionData);
      if (!canSeeContact(scope, contactId)) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      if (!canEditContact(scope, contactId)) {
        res.status(403).json({ error: "Contact edit assignment required" });
        return;
      }
      const interaction = await storage.createCrmInteraction(interactionData);
      res.status(201).json(interaction);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid interaction data", details: error.issues });
        return;
      }
      res.status(500).json({ error: "Failed to create interaction" });
    }
  });

  }
  // Service Logs endpoints
  app.get("/api/service-logs", async (req, res) => {
    try {
      const scope = await getStaffAssignmentScope(req);
      const logs = (await Promise.all((await storage.getServiceLogs()).map(async (log) =>
        await canSeeServiceLog(scope, log) ? log : null
      ))).filter(Boolean);
      res.json(logs);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch service logs" });
    }
  });

  app.get("/api/service-logs/:id", async (req, res) => {
    try {
      const log = await storage.getServiceLog(parseInt(req.params.id));
      const scope = await getStaffAssignmentScope(req);
      const visible = log && await canSeeServiceLog(scope, log);
      if (!visible) {
        res.status(404).json({ error: "Service log not found" });
        return;
      }
      res.json(log);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch service log" });
    }
  });

  app.post("/api/service-logs", async (req, res) => {
    try {
      const logData = insertServiceLogSchema.parse(req.body);
      const scope = await getStaffAssignmentScope(req);
      if (!(await canWriteServiceLog(scope, logData))) {
        res.status(403).json({ error: "Customer or job assignment required" });
        return;
      }
      const log = await storage.createServiceLog(logData);
      res.status(201).json(log);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid service log data", details: error.issues });
        return;
      }
      res.status(500).json({ error: "Failed to create service log" });
    }
  });

  app.put("/api/service-logs/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await storage.getServiceLog(id);
      const scope = await getStaffAssignmentScope(req);
      if (!existing || !(await canSeeServiceLog(scope, existing))) {
        res.status(404).json({ error: "Service log not found" });
        return;
      }
      if (!(await canWriteServiceLog(scope, { ...existing, ...req.body }))) {
        res.status(403).json({ error: "Customer or job assignment required" });
        return;
      }
      const log = await storage.updateServiceLog(id, req.body);
      if (!log) {
        res.status(404).json({ error: "Service log not found" });
        return;
      }
      res.json(log);
    } catch (error) {
      res.status(500).json({ error: "Failed to update service log" });
    }
  });

  app.delete("/api/service-logs/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) {
        res.status(400).json({ error: "Invalid service log id" });
        return;
      }
      const existing = await storage.getServiceLog(id);
      const scope = await getStaffAssignmentScope(req);
      if (!existing || !(await canSeeServiceLog(scope, existing))) {
        res.status(404).json({ error: "Service log not found" });
        return;
      }
      const deleted = await storage.deleteServiceLog(id);
      if (!deleted) {
        res.status(404).json({ error: "Service log not found" });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete service log" });
    }
  });

  app.get("/api/service-logs/contact/:contactId", async (req, res) => {
    try {
      const contact = await storage.getCrmContact(parseInt(req.params.contactId));
      const scope = await getStaffAssignmentScope(req);
      if (!contact || !canSeeClient(scope, contact.clientId)) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      const logs = await storage.getServiceLogsByContact(parseInt(req.params.contactId));
      res.json((await Promise.all(logs.map(async (log) => await canSeeServiceLog(scope, log) ? log : null))).filter(Boolean));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch service logs" });
    }
  });

  app.get("/api/service-logs/job/:jobId", async (req, res) => {
    try {
      const job = await storage.getCrmJob(parseInt(req.params.jobId));
      const scope = await getStaffAssignmentScope(req);
      if (!job || !(await canSeeJob(scope, job))) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      const logs = await storage.getServiceLogsByJob(parseInt(req.params.jobId));
      res.json((await Promise.all(logs.map(async (log) => await canSeeServiceLog(scope, log) ? log : null))).filter(Boolean));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch service logs" });
    }
  });

  // CRM Dashboard stats endpoint
  app.get("/api/crm/dashboard", async (req, res) => {
    try {
      const scope = await getStaffAssignmentScope(req);
      const [allContacts, allLeads, allJobs] = await Promise.all([
        storage.getCrmContacts(),
        storage.getCrmLeads(),
        storage.getCrmJobs()
      ]);
      const contacts = allContacts.filter((contact) => canSeeClient(scope, contact.clientId));
      const contactIds = new Set(contacts.map((contact) => contact.id));
      const leads = scope.unrestricted ? allLeads : allLeads.filter((lead) => lead.contactId != null && contactIds.has(lead.contactId));
      const jobs = await scopedJobs(req, allJobs) as any[];
      
      const now = new Date();
      const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      
      const newLeadsLast7Days = leads.filter(l => 
        l.createdAt && new Date(l.createdAt) >= last7Days
      ).length;
      
      const completedJobsLast30Days = jobs.filter(j => 
        j.status === 'completed' && j.completedDateTime && new Date(j.completedDateTime) >= last30Days
      ).length;
      
      const pipelineValue = leads
        .filter(l => l.estimatedValue && ['new', 'contacted', 'qualified', 'quoted'].includes(l.status || ''))
        .reduce((sum, l) => sum + (l.estimatedValue || 0), 0);
      
      const conversionRate = leads.length > 0 
        ? Math.round((leads.filter(l => l.status === 'won').length / leads.length) * 100)
        : 0;
      
      res.json({
        totalContacts: contacts.length,
        totalLeads: leads.length,
        totalJobs: jobs.length,
        newLeadsLast7Days,
        completedJobsLast30Days,
        pipelineValue,
        conversionRate,
        leadsByStatus: {
          new: leads.filter(l => l.status === 'new').length,
          contacted: leads.filter(l => l.status === 'contacted').length,
          qualified: leads.filter(l => l.status === 'qualified').length,
          quoted: leads.filter(l => l.status === 'quoted').length,
          won: leads.filter(l => l.status === 'won').length,
          lost: leads.filter(l => l.status === 'lost').length,
        },
        jobsByStatus: {
          open: jobs.filter(j => j.status === 'open').length,
          in_progress: jobs.filter(j => j.status === 'in_progress').length,
          waiting_parts: jobs.filter(j => j.status === 'waiting_parts').length,
          completed: jobs.filter(j => j.status === 'completed').length,
        }
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch CRM dashboard data" });
    }
  });

  // Direct intake endpoint - creates Contact, Lead, and Interaction in one call
  app.post("/api/intake", publicWriteLimiter, async (req, res) => {
    try {
      const validated = intakeSchema.safeParse(req.body);
      if (!validated.success) {
        res.status(400).json({
          success: false,
          error: "Invalid intake data",
          details: validated.error.flatten().fieldErrors,
        });
        return;
      }
      const {
        full_name,
        company_name,
        intake_submission_id,
        mobile_phone,
        email,
        preferred_contact_method,
        street_address,
        city,
        state,
        zip,
        how_did_you_hear_about_us,
        service_type,
        device_type,
        device_brand,
        device_model,
        operating_system,
        problem_description,
        from_active_call,
        call_notes,
        sms_consent,
        sms_consent_text
      } = req.body;
      const smsConsentGiven = sms_consent === true;
      const normalizedEmail = normalizeIntakeEmail(email);
      const normalizedPhone = normalizeIntakePhone(mobile_phone);
      if (mobile_phone?.trim() && !normalizedPhone) {
        res.status(400).json({
          success: false,
          error: "Mobile phone must be a valid phone number",
        });
        return;
      }
      let devicePhoto: ReturnType<typeof decodeCustomerPhoto> | null = null;
      if (validated.data.device_photo) {
        try {
          devicePhoto = decodeCustomerPhoto(validated.data.device_photo);
        } catch (error) {
          res.status(400).json({ success: false, error: (error as Error).message });
          return;
        }
      }
      const phoneDigits = normalizedPhoneDigits(normalizedPhone);
      const normalizedCompanyName =
        typeof company_name === "string" ? company_name.trim() || null : null;

      // Validate required fields
      if (!full_name || (!normalizedPhone && !normalizedEmail) || !service_type || !device_type || !problem_description) {
        res.status(400).json({ 
          success: false, 
          error: "Missing required fields: full_name, mobile_phone OR email, service_type, device_type, problem_description" 
        });
        return;
      }

      const brandModel = device_brand && device_model 
        ? `${device_brand} ${device_model}` 
        : (device_brand || device_model || null);
      // Catalog price for the selected booking service. Read from the database
      // rather than the request so a public caller cannot set deal value.
      const serviceId = validated.data.service_id ?? null;
      let servicePriceCents: number | null = null;
      if (serviceId) {
        try {
          const priceLookup = await pool.query(
            `SELECT base_price_cents FROM services WHERE id = $1 AND is_active = TRUE`,
            [serviceId],
          );
          const cents = priceLookup.rows[0]?.base_price_cents;
          servicePriceCents = cents == null ? null : Number(cents);
        } catch (error) {
          console.error("[intake] service price lookup failed:", error);
        }
      }
      const attribution = buildIntakeAttribution({
        fromActiveCall: !!from_active_call,
        howDidYouHear: how_did_you_hear_about_us,
      });
      const voiceIntake = validated.data.intake_channel === "voice";
      const interactionDetails = (call_notes 
        ? `Problem: ${problem_description}\n\nCall Notes: ${call_notes}`
        : `Problem: ${problem_description}`) + (voiceIntake ? `\n\nSubmitted via: voice intake` : "");
      const submissionId = intake_submission_id || randomUUID();
      const fingerprint = intakePayloadFingerprint({
        ...req.body,
        intake_submission_id: undefined,
        email: normalizedEmail,
        mobile_phone: normalizedPhone,
      });

      // Contact, lead, deal, and intake interaction form one durable unit. The
      // reservation row makes an in-flight retry wait for, then return, the
      // original transaction instead of duplicating either CRM or dispatch work.
      const client = await pool.connect();
      let crm: {
        contact: { id: number; fullName: string; company: string | null; clientId: number | null };
        clientId: number | null;
        clientStatus: "created" | "reused" | "identity_review" | "unlinked";
        intakeRecordId: number | null;
        leadId: number;
        dealId: number;
        contactStatus: "created" | "reused" | "identity_review";
        replayed: boolean;
      };
      try {
        await client.query("BEGIN");
        const reservation = await client.query(
          `INSERT INTO intake_submissions (submission_id, payload_fingerprint, contact_status)
           VALUES ($1, $2, 'created') ON CONFLICT DO NOTHING RETURNING submission_id`,
          [submissionId, fingerprint],
        );
        if (!reservation.rows.length) {
          const existing = await client.query(
            `SELECT payload_fingerprint, contact_id, contact_status, client_id, client_status, intake_record_id, lead_id, deal_id
             FROM intake_submissions WHERE submission_id = $1 FOR UPDATE`,
            [submissionId],
          );
          const row = existing.rows[0];
          if (!row || row.payload_fingerprint !== fingerprint) {
            const error = new Error("Intake submission ID was reused with a different payload");
            (error as any).statusCode = 409;
            throw error;
          }
          crm = {
            contact: { id: row.contact_id, fullName: "", company: null, clientId: row.client_id },
            clientId: row.client_id,
            clientStatus: row.client_status,
            intakeRecordId: row.intake_record_id,
            leadId: row.lead_id,
            dealId: row.deal_id,
            contactStatus: row.contact_status,
            replayed: true,
          };
        } else {
          const [phoneMatches, emailMatches] = await Promise.all([
            phoneDigits
              ? client.query(
                  `SELECT id, full_name, company, client_id FROM crm_contacts
                   WHERE CASE WHEN length(regexp_replace(COALESCE(mobile_phone, ''), '[^0-9]', '', 'g')) = 10
                     THEN '1' || regexp_replace(mobile_phone, '[^0-9]', '', 'g')
                     ELSE regexp_replace(COALESCE(mobile_phone, ''), '[^0-9]', '', 'g') END = $1 FOR UPDATE`,
                  [phoneDigits],
                )
              : Promise.resolve({ rows: [] as any[] }),
            normalizedEmail
              ? client.query(
                  `SELECT id, full_name, company, client_id FROM crm_contacts
                   WHERE lower(btrim(email)) = $1 FOR UPDATE`,
                  [normalizedEmail],
                )
              : Promise.resolve({ rows: [] as any[] }),
          ]);
          const decision = resolveIntakeIdentity({
            phoneProvided: !!phoneDigits,
            emailProvided: !!normalizedEmail,
            phoneContactIds: phoneMatches.rows.map((row) => Number(row.id)),
            emailContactIds: emailMatches.rows.map((row) => Number(row.id)),
          });
          let contact: { id: number; fullName: string; company: string | null; clientId: number | null } =
            { id: 0, fullName: "", company: null, clientId: null };
          let contactStatus: "created" | "reused" | "identity_review";
          if (decision.kind === "reuse") {
            const row = [...phoneMatches.rows, ...emailMatches.rows].find(
              (match) => Number(match.id) === decision.contactId,
            )!;
            contact = { id: Number(row.id), fullName: row.full_name, company: row.company, clientId: row.client_id };
            contactStatus = "reused";
          } else {
            contactStatus = decision.needsIdentityReview ? "identity_review" : "created";
          }

          // An already-linked contact is authoritative; intake data can never
          // replace that relationship. Otherwise accounts are matched by email
          // first, with any known phone match required to agree.
          let clientId = contact?.clientId ?? null;
          let clientStatus: "created" | "reused" | "identity_review" | "unlinked" =
            clientId ? "reused" : "unlinked";
          if (!clientId) {
            const [emailClients, phoneClients] = await Promise.all([
              normalizedEmail
                ? client.query(
                    `SELECT id FROM clients WHERE lower(btrim(contact_email)) = $1 FOR UPDATE`,
                    [normalizedEmail],
                  )
                : Promise.resolve({ rows: [] as any[] }),
              phoneDigits
                ? client.query(
                    `SELECT id FROM clients
                     WHERE CASE WHEN length(regexp_replace(COALESCE(contact_phone, ''), '[^0-9]', '', 'g')) = 10
                       THEN '1' || regexp_replace(contact_phone, '[^0-9]', '', 'g')
                       ELSE regexp_replace(COALESCE(contact_phone, ''), '[^0-9]', '', 'g') END = $1 FOR UPDATE`,
                    [phoneDigits],
                  )
                : Promise.resolve({ rows: [] as any[] }),
            ]);
            const accountDecision = resolveIntakeAccount({
              emailProvided: !!normalizedEmail,
              phoneProvided: !!phoneDigits,
              emailClientIds: emailClients.rows.map((row) => Number(row.id)),
              phoneClientIds: phoneClients.rows.map((row) => Number(row.id)),
            });
            if (accountDecision.kind === "reuse") {
              clientId = accountDecision.clientId;
              clientStatus = "reused";
            } else if (accountDecision.kind === "create") {
              const intakeClient = mapIntakeClient({
                fullName: full_name,
                companyName: normalizedCompanyName,
                email: normalizedEmail,
                phone: normalizedPhone,
                address: street_address,
                city,
                state,
                zip,
              });
              // resolveIntakeAccount only permits creation when email exists;
              // retaining this guard makes the required client email explicit.
              if (!intakeClient) {
                const error = new Error("Cannot create a client without an email");
                throw error;
              }
              const createdClient = await client.query(
                `INSERT INTO clients (name, contact_email, contact_phone, address, city, state, zip_code)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
                [intakeClient.name, intakeClient.contactEmail, intakeClient.contactPhone,
                  intakeClient.address, intakeClient.city, intakeClient.state, intakeClient.zipCode],
              );
              clientId = Number(createdClient.rows[0].id);
              clientStatus = "created";
            } else {
              clientStatus = "identity_review";
              contactStatus = "identity_review";
            }
          }

          if (decision.kind === "reuse") {
            // Only fill a missing relationship; never replace a contact's
            // existing account from unauthenticated intake data.
            if (!contact.clientId && clientId) {
              await client.query(
                `UPDATE crm_contacts SET client_id = $2, updated_at = NOW()
                 WHERE id = $1 AND client_id IS NULL`,
                [contact.id, clientId],
              );
              contact = { ...contact, clientId };
            }
          } else {
            const needsIdentityReview = decision.needsIdentityReview || clientStatus === "identity_review";
            contactStatus = needsIdentityReview ? "identity_review" : "created";
            const tags = [how_did_you_hear_about_us?.trim(), needsIdentityReview ? "identity_review" : null]
              .filter(Boolean)
              .join(", ") || null;
            const created = await client.query(
              `INSERT INTO crm_contacts
                (full_name, mobile_phone, email, company, contact_preference, address, city, state, zip_code, tags, client_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
               RETURNING id, full_name, company, client_id`,
              [full_name.trim(), normalizedPhone, normalizedEmail, normalizedCompanyName,
                preferred_contact_method || "text_email", street_address || null, city || null, state || null, zip || null, tags, clientId],
            );
            const row = created.rows[0];
            contact = { id: Number(row.id), fullName: row.full_name, company: row.company, clientId: row.client_id };
          }
          // The intake record is the shared request row used by the Intake
          // Requests view. It is created in this same transaction, not as a
          // second asynchronous source of truth.
          const intakeValues = mapIntakeRecord({
            fullName: full_name, phone: normalizedPhone, email: normalizedEmail, contactPreference: preferred_contact_method,
            serviceType: service_type, deviceType: device_type, brandModel, operatingSystem: operating_system,
            problemDescription: problem_description, source: how_did_you_hear_about_us,
            activeCall: !!from_active_call, callNotes: call_notes,
          });
          const intakeRecord = await client.query(
            `INSERT INTO csd_intake_records
              (customer_name, phone_number, email_address, contact_preference, service_type,
               device_type, device_brand_model, operating_system, problem_description,
               how_did_you_hear, is_from_active_call, call_notes, source, campaign,
               ip_address, user_agent, referrer_url)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
             RETURNING id`,
            [intakeValues.customerName, intakeValues.phoneNumber, intakeValues.emailAddress,
              intakeValues.contactPreference, intakeValues.serviceType, intakeValues.deviceType, intakeValues.deviceBrandModel,
              intakeValues.operatingSystem, intakeValues.problemDescription, intakeValues.howDidYouHear,
              intakeValues.isFromActiveCall, intakeValues.callNotes, attribution.source,
              // The voice tag keeps precedence: the board and Leads views key off it.
              voiceIntake ? "voice_intake" : normalizeUtmCampaign(validated.data.utm_campaign),
              req.ip || null, req.get("user-agent") || null, req.get("referer") || null],
          );
          const intakeRecordId = Number(intakeRecord.rows[0].id);
          if (devicePhoto) {
            await saveIntakeDevicePhoto(client, { intakeRecordId, clientId, photo: devicePhoto });
          }
          const leadResult = await client.query(
            `INSERT INTO crm_leads
              (contact_id, intake_record_id, source, campaign, service_type, device_type, brand_model, operating_system, problem_description, estimated_value, status, priority)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'new','normal') RETURNING id`,
            [contact.id, intakeRecordId, attribution.source, attribution.campaign,
              service_type, device_type, brandModel, operating_system || null, problem_description, servicePriceCents],
          );
          const leadId = Number(leadResult.rows[0].id);
          const dealData = buildIntakeDeal({
            serviceType: service_type, companyName: contact.company || normalizedCompanyName, contactName: contact.fullName || full_name,
            deviceType: device_type, problemDescription: problem_description, primaryContactId: contact.id, leadId,
            servicePriceCents,
          });
          const dealResult = await client.query(
            `INSERT INTO crm_deals
              (title, company_name, stage, estimated_mrr, one_time_fee, primary_contact_id, lead_id, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [dealData.title, dealData.companyName, dealData.stage, dealData.estimatedMrr, dealData.oneTimeFee,
              dealData.primaryContactId, dealData.leadId, dealData.notes],
          );
          const dealId = Number(dealResult.rows[0].id);
          await client.query(
            `INSERT INTO crm_interactions (type, summary, contact_id, lead_id, details, performed_by)
             VALUES ('intake_form', $1, $2, $3, $4, 'system')`,
            [`New intake – ${service_type}`, contact.id, leadId, interactionDetails],
          );
          await client.query(
            `UPDATE intake_submissions
             SET contact_id=$2, contact_status=$3, client_id=$4, client_status=$5, intake_record_id=$6, lead_id=$7, deal_id=$8
             WHERE submission_id=$1`,
            [submissionId, contact.id, contactStatus, clientId, clientStatus, intakeRecordId, leadId, dealId],
          );
          crm = { contact, clientId, clientStatus, intakeRecordId, leadId, dealId, contactStatus, replayed: false };
          await enqueueStaffEventNotification({ kind: "intake", id: intakeRecordId }, staffEventExecutor(client));
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      const contact: any = crm.contact;
      const lead = { id: crm.leadId };
      const deal = { id: crm.dealId, stage: "lead" };
      // The lead and intake row were committed together above; save the Slack
      // event before slower dispatch, email, SMS, and consent side effects.
      if (!crm.replayed) {
        await queueLeadNotification({
          name: full_name,
          contact: mobile_phone || email || 'No contact info',
          service: service_type,
          device: `${device_type}${brandModel ? ` (${brandModel})` : ''}`,
          issue: String(problem_description).slice(0, 200),
        }, `intake-${lead.id}`);
      }
      if (!crm.replayed) publishPipelineEvent({ type: "deal_created", dealId: deal.id, stage: deal.stage });
      if (!crm.replayed && crm.intakeRecordId != null && validated.data.referral_code != null) {
        // Best effort and idempotent per intake: never fails the request.
        await recordIntakeReferral({
          code: validated.data.referral_code,
          intakeRecordId: crm.intakeRecordId,
          leadId: crm.leadId,
          contactId: contact?.id ?? null,
          existingCustomer: crm.contactStatus === "reused",
          friendName: full_name,
          friendEmail: normalizedEmail,
          friendPhone: normalizedPhone,
        });
      }

      // Auto-create dispatch records so every intake lands on the work boards
      // without a manual conversion step: a CRM Job (work order) and a Helpdesk
      // Ticket. Each is wrapped independently so a failure in one never breaks
      // the intake response or the other record.
      let job: Awaited<ReturnType<typeof storage.createCrmJob>> | null = null;
      let ticket: Awaited<ReturnType<typeof storage.createTicket>> | null = null;
      // Serialize dispatch independently from CRM creation. A same-key retry
      // locks this row and fills only missing handoff records.
      const dispatchLock = await pool.connect();
      try {
        await dispatchLock.query("BEGIN");
        const persisted = await dispatchLock.query(
          `SELECT job_id, ticket_id FROM intake_submissions WHERE submission_id=$1 FOR UPDATE`,
          [submissionId],
        );
        let jobId = persisted.rows[0]?.job_id as number | null;
        let ticketId = persisted.rows[0]?.ticket_id as number | null;
        const dispatchPlan = planIntakeDispatch({ jobId, ticketId });
        const errors: string[] = [];
        if (jobId) job = await storage.getCrmJob(Number(jobId)) ?? null;
        if (dispatchPlan.createJob) {
          try {
            const jobNumber = await storage.getNextJobNumber();
            job = await storage.createCrmJob({
              leadId: lead.id, contactId: contact.id, jobNumber, serviceType: service_type,
              jobType: "drop_off", priority: "normal", status: "open", description: problem_description,
            });
            jobId = job.id;
            await dispatchLock.query(`UPDATE intake_submissions SET job_id=$2 WHERE submission_id=$1`, [submissionId, jobId]);
          } catch (error) {
            errors.push(`job: ${(error as Error).message}`);
          }
        }
        if (ticketId) ticket = await storage.getTicket(Number(ticketId)) ?? null;
        if (dispatchPlan.createTicket) {
          try {
            const ticketSubject = `${service_type} – ${device_type}${brandModel ? ` (${brandModel})` : ""}`;
            const baseTicket = await storage.createTicket({
              subject: ticketSubject, description: problem_description, priority: "medium", status: "open",
              source: "web", requesterName: full_name, requesterEmail: email || null,
              requesterPhone: mobile_phone || null, clientId: contact.clientId || null,
            });
            ticket = await enrichNewTicket(baseTicket, { suppressAutoresponder: true });
            ticketId = ticket.id;
            // Without this the deal's 360 history omits the ticket intake just
            // created — the timeline matches tickets on associated_deal_id only.
            await dispatchLock.query(`UPDATE tickets SET associated_deal_id=$2 WHERE id=$1`, [ticketId, deal.id]);
            await dispatchLock.query(`UPDATE intake_submissions SET ticket_id=$2 WHERE submission_id=$1`, [submissionId, ticketId]);
            void dispatchNewTicketToStaff(ticket, {
              clientName: full_name, clientPhone: mobile_phone || null,
              device: `${device_type}${brandModel ? ` (${brandModel})` : ""}`, issue: problem_description,
            }).catch((error) => console.error("[intake] staff dispatch failed:", error));
          } catch (error) {
            errors.push(`ticket: ${(error as Error).message}`);
          }
        }
        const state = errors.length ? (jobId || ticketId ? "partial" : "failed") : "completed";
        await dispatchLock.query(
          `UPDATE intake_submissions SET dispatch_state=$2, dispatch_error=$3 WHERE submission_id=$1`,
          [submissionId, state, errors.join("; ") || null],
        );
        await dispatchLock.query("COMMIT");
      } catch (error) {
        await dispatchLock.query("ROLLBACK");
        console.error("[intake] failed to resume dispatch:", error);
      } finally {
        dispatchLock.release();
      }

      // Cross-link the dispatch records on the lead's timeline.
      if (!crm.replayed && (job || ticket)) {
        try {
          await storage.createCrmInteraction({
            type: 'note',
            summary: 'Dispatch records created from intake',
            contactId: contact.id,
            leadId: lead.id,
            jobId: job?.id ?? null,
            details:
              `Auto-created from web intake.\n` +
              (job ? `Job: ${job.jobNumber}\n` : '') +
              (ticket ? `Ticket: ${ticket.ticketNumber}` : ''),
            performedBy: 'system',
          });
        } catch (e) {
          console.error('[intake] failed to log dispatch interaction:', e);
        }
      }

      // Admin email notification (SendGrid). Built from the request fields
      // rather than re-reading the csd_intake_records row written above, because
      // the email helper only needs this projection. Fire-and-forget; the helper
      // swallows its own errors.
      if (!crm.replayed) try {
        void sendIntakeNotificationEmail({
          id: crm.intakeRecordId ?? lead.id,
          customerName: full_name,
          phoneNumber: mobile_phone || '',
          emailAddress: email || '',
          contactPreference: preferred_contact_method || 'text_email',
          serviceType: service_type,
          deviceType: device_type,
          deviceBrandModel: brandModel || '',
          operatingSystem: operating_system || '',
          problemDescription: problem_description,
          howDidYouHear: how_did_you_hear_about_us || '',
          source: 'website_intake',
          campaign: from_active_call ? 'phone_call' : null,
          isFromActiveCall: !!from_active_call,
          callId: null,
          callNotes: call_notes || null,
          createdAt: new Date(),
        } as any);
      } catch (e) {
        console.error('[intake] notification email dispatch error:', e);
      }

      // Customer confirmation email — always sent when the customer provided an
      // email address. Fire-and-forget; the helper swallows its own errors.
      if (!crm.replayed) try {
        if (email) {
          const confirmationTicket = ticket;
          void (async () => {
            const businessPhone = (await getInvoiceSettings().catch(() => null))?.contactPhone || null;
            await sendCustomerConfirmationEmail({
            id: crm.intakeRecordId ?? lead.id,
            customerName: full_name,
            phoneNumber: mobile_phone || '',
            emailAddress: email,
            contactPreference: preferred_contact_method || 'text_email',
            serviceType: service_type,
            deviceType: device_type,
            deviceBrandModel: brandModel || '',
            operatingSystem: operating_system || '',
            problemDescription: problem_description,
            howDidYouHear: how_did_you_hear_about_us || '',
            source: 'website_intake',
            campaign: from_active_call ? 'phone_call' : null,
            isFromActiveCall: !!from_active_call,
            callId: null,
            callNotes: call_notes || null,
            createdAt: new Date(),
          } as any, {
            ticketNumber: confirmationTicket?.ticketNumber ?? null,
            portalUrl: confirmationTicket?.accessToken && confirmationTicket.requesterEmail
              ? ticketPortalUrl(confirmationTicket)
              : null,
            businessPhone,
          });
          })().catch((e) => console.error('[intake] customer confirmation email error:', e));
        }
      } catch (e) {
        console.error('[intake] customer confirmation email dispatch error:', e);
      }

      // A2P 10DLC consent proof. Only recorded when the customer voluntarily
      // checks the box. We store a timestamped audit record (interaction
      // createdAt = consent time) with the exact disclosure text they agreed
      // to, plus a note on the contact for quick visibility.
      if (!crm.replayed && smsConsentGiven) {
        const consentText =
          (typeof sms_consent_text === 'string' && sms_consent_text.trim()) ||
          'I agree to receive SMS text messages from Computer Systems Depot Inc. for support and service updates. Message and data rates may apply. Reply STOP to opt-out. View our Privacy Policy.';
        const consentTimestamp = new Date().toISOString();
        try {
          await storage.createCrmInteraction({
            type: 'sms_consent',
            summary: 'SMS opt-in consent granted',
            contactId: contact.id,
            leadId: lead.id,
            details:
              `Source: website intake form\n` +
              `Granted: ${consentTimestamp}\n` +
              `Contact: ${mobile_phone || 'n/a'}\n` +
              `Agreed to: "${consentText}"`,
            performedBy: 'system',
          });
          // Anonymous intake must never alter an existing CRM contact. A newly
          // created contact can retain this convenient consent note; the
          // interaction above remains the durable audit trail for reused ones.
          if (crm.contactStatus !== "reused") {
            const consentNote = `[SMS consent] Opted in via web form on ${consentTimestamp}.`;
            const stored = await storage.getCrmContact(contact.id);
            const existingNotes = stored?.notes?.trim();
            await storage.updateCrmContact(contact.id, {
              notes: existingNotes ? `${existingNotes}\n${consentNote}` : consentNote,
            });
          }
        } catch (e) {
          console.error('[intake] failed to record SMS consent:', e);
        }
        // Current consent state is independent of the historical CRM audit
        // record, so a notes/audit failure cannot silently lose the opt-in.
        if (mobile_phone) {
          try {
            await recordSmsConsentState(mobile_phone, true);
          } catch (e) {
            console.error('[intake] failed to store SMS consent state:', e);
          }
        }
      }

      // SMS to the customer after opting in on the form. Fires in the background —
      // never blocks the form response, never breaks the intake on failure.
      let thankYouSmsStatus: 'sent' | 'skipped' | 'failed' = 'skipped';
      if (!crm.replayed) try {
        const settings = await getTwilioSettings();
        // A2P compliance: only text the customer when they explicitly opted in.
        if (smsConsentGiven && mobile_phone && (await isTwilioConfigured())) {
          // Mandatory opt-in confirmation. The A2P campaign registration promises
          // that every opt-in (web form or START keyword) immediately receives an
          // automated confirmation identifying the business and restating
          // STOP/HELP — so this is NOT gated on the optional thank-you setting.
          const confirmation =
            'Computer Systems Depot Inc.: You are opted in to recurring service update texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.';
          sendSms(mobile_phone, confirmation)
            .then(() => console.log(`[intake] opt-in confirmation SMS sent to ${mobile_phone}`))
            .catch((e) => console.error('[intake] opt-in confirmation SMS failed:', e?.message || e));
          thankYouSmsStatus = 'sent';

          // Optional personalized thank-you (configurable in Phone & SMS Settings → SMS tab).
          if (settings.intakeSmsEnabled && (settings.intakeSmsText || '').trim()) {
            const firstName = (full_name || '').trim().split(/\s+/)[0] || 'there';
            const body = settings.intakeSmsText.replace(/\{\{name\}\}/gi, firstName);
            sendSms(mobile_phone, body)
              .then(() => console.log(`[intake] thank-you SMS sent to ${mobile_phone}`))
              .catch((e) => console.error('[intake] thank-you SMS failed:', e?.message || e));
          }
        }
      } catch (e) {
        console.error('[intake] thank-you SMS dispatch error:', e);
        thankYouSmsStatus = 'failed';
      }

      res.status(201).json({
        ...publicIntakeResponse({
          contactId: contact.id,
          contactStatus: crm.contactStatus,
          clientId: crm.clientId,
          clientStatus: crm.clientStatus,
          intakeRecordId: crm.intakeRecordId,
          leadId: lead.id,
          dealId: deal.id,
          replayed: crm.replayed,
        }),
        // The real helpdesk ticket number, so the customer can quote it. Null
        // when ticket dispatch failed; callers must never invent one.
        ticket: ticket?.ticketNumber ? { number: ticket.ticketNumber } : null,
      });
    } catch (error) {
      console.error('Intake creation error:', error);
      res.status((error as any)?.statusCode === 409 ? 409 : 500)
        .json({ success: false, error: (error as any)?.statusCode === 409 ? (error as Error).message : "Failed to create intake" });
    }
  });

  // Every record intake produced, resolved from the idempotency ledger so the
  // Intake Requests view can link straight into the CRM. There is no
  // "convert to lead" action: POST /api/intake already creates the contact,
  // client, lead, deal, job and ticket in one transaction, so re-converting
  // would only ever duplicate them.
  app.get("/api/intake/:id/links", async (req, res) => {
    try {
      const intakeId = parseInt(req.params.id, 10);
      if (!Number.isSafeInteger(intakeId) || intakeId < 1) {
        res.status(400).json({ error: "Invalid intake id" });
        return;
      }
      const { rows } = await pool.query(
        `SELECT s.contact_id, s.contact_status, s.client_id, s.client_status,
                s.lead_id, s.deal_id, s.job_id, s.ticket_id,
                s.dispatch_state, s.dispatch_error,
                j.job_number, t.ticket_number
         FROM intake_submissions s
         LEFT JOIN crm_jobs j ON j.id = s.job_id
         LEFT JOIN tickets t ON t.id = s.ticket_id
         WHERE s.intake_record_id = $1
         ORDER BY s.created_at DESC
         LIMIT 1`,
        [intakeId],
      );
      let row = rows[0];
      if (!row) {
        // No idempotency-ledger entry. That is expected for records that were
        // reconstructed from a historical lead, so resolve the same links
        // through crm_leads instead of reporting the intake as unlinked.
        const fallback = await pool.query(
          `SELECT l.contact_id, 'reused' AS contact_status, c.client_id, 'reused' AS client_status,
                  l.id AS lead_id, d.id AS deal_id, j.id AS job_id, NULL::int AS ticket_id,
                  'completed' AS dispatch_state, NULL::text AS dispatch_error,
                  j.job_number, NULL::text AS ticket_number
           FROM crm_leads l
           LEFT JOIN crm_contacts c ON c.id = l.contact_id
           LEFT JOIN crm_deals d ON d.lead_id = l.id
           LEFT JOIN crm_jobs j ON j.lead_id = l.id
           WHERE l.intake_record_id = $1
           ORDER BY l.created_at DESC
           LIMIT 1`,
          [intakeId],
        );
        row = fallback.rows[0];
      }
      if (!row) {
        res.json({ linked: false });
        return;
      }
      res.json({
        linked: true,
        contact: row.contact_id ? { id: Number(row.contact_id), status: row.contact_status } : null,
        client: row.client_id ? { id: Number(row.client_id), status: row.client_status } : null,
        lead: row.lead_id ? { id: Number(row.lead_id) } : null,
        deal: row.deal_id ? { id: Number(row.deal_id) } : null,
        job: row.job_id ? { id: Number(row.job_id), jobNumber: row.job_number ?? null } : null,
        ticket: row.ticket_id ? { id: Number(row.ticket_id), ticketNumber: row.ticket_number ?? null } : null,
        dispatch: { state: row.dispatch_state, error: row.dispatch_error ?? null },
      });
    } catch (error) {
      console.error("Intake links lookup failed:", error);
      res.status(500).json({ error: "Failed to resolve intake links" });
    }
  });

  // Google Contacts OAuth & Sync endpoints
  registerGoogleContactRoutes(app, {
    googleContactsService,
    canSeeContact,
    canEditContact,
  });
  if (false) {
  app.get("/api/google/status", async (req, res) => {
    try {
      const status = googleContactsService.getStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: "Failed to get Google Contacts status" });
    }
  });

  app.get("/api/google/auth-url", async (req, res) => {
    try {
      const authUrl = googleContactsService.getAuthUrl();
      if (!authUrl) {
        res.status(400).json({ 
          error: "Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets first." 
        });
        return;
      }
      res.json({ authUrl });
    } catch (error) {
      res.status(500).json({ error: "Failed to generate auth URL" });
    }
  });

  app.get("/api/google/callback", async (req, res) => {
    try {
      const code = req.query.code as string;
      if (!code) {
        res.status(400).json({ error: "No authorization code provided" });
        return;
      }
      
      const tokens = await googleContactsService.handleAuthCallback(code);
      
      console.log('Google OAuth completed successfully. Session is now active.');
      
      res.send(`
        <html>
          <head><title>Google Contacts Connected</title></head>
          <body style="font-family: sans-serif; padding: 40px; text-align: center;">
            <h1>Google Contacts Connected Successfully!</h1>
            <p>Your Google account is now connected for this session.</p>
            <p style="color: #666; font-size: 14px;">
              For permanent access, check the server logs and add the tokens as secrets:
              <br>GOOGLE_ACCESS_TOKEN and GOOGLE_REFRESH_TOKEN
            </p>
            <p><a href="/crm/contacts" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #4285f4; color: white; text-decoration: none; border-radius: 4px;">Return to CRM Contacts</a></p>
          </body>
        </html>
      `);
    } catch (error: any) {
      res.status(500).send(`
        <html>
          <head><title>OAuth Error</title></head>
          <body style="font-family: sans-serif; padding: 40px;">
            <h1>OAuth Error</h1>
            <p>${error.message}</p>
            <a href="/crm/contacts">Return to CRM Contacts</a>
          </body>
        </html>
      `);
    }
  });

  app.post("/api/google/sync-contact/:contactId", async (req, res) => {
    try {
      const contactId = parseInt(req.params.contactId);
      const contact = await storage.getCrmContact(contactId);
      const scope = await getStaffAssignmentScope(req);
      if (!contact || !canSeeContact(scope, contactId)) {
        res.status(404).json({ error: "Contact not found" });
        return;
      }
      if (!canEditContact(scope, contactId)) {
        res.status(403).json({ error: "Contact edit assignment required" });
        return;
      }
      
      const result = await googleContactsService.createContact({
        fullName: contact.fullName,
        email: contact.email,
        mobilePhone: contact.mobilePhone,
        officePhone: contact.officePhone,
        company: contact.company,
        address: contact.address,
        city: contact.city,
        state: contact.state,
        zipCode: contact.zipCode,
        notes: contact.notes,
      });
      
      if (result) {
        await storage.updateCrmContact(contactId, { 
          googleContactId: result.resourceName 
        });
        res.json({ success: true, resourceName: result.resourceName });
      } else {
        res.status(400).json({ 
          error: "Google Contacts not configured. Complete OAuth setup first." 
        });
      }
    } catch (error: any) {
      console.error('Google sync error:', error);
      res.status(500).json({ error: error.message || "Failed to sync contact" });
    }
  });

  app.post("/api/google/sync-all-contacts", requireStaffAdministrator, async (req, res) => {
    try {
      const contacts = await storage.getCrmContacts();
      const results = { synced: 0, failed: 0, skipped: 0 };
      
      for (const contact of contacts) {
        if (contact.googleContactId) {
          results.skipped++;
          continue;
        }
        
        try {
          const result = await googleContactsService.createContact({
            fullName: contact.fullName,
            email: contact.email,
            mobilePhone: contact.mobilePhone,
            officePhone: contact.officePhone,
            company: contact.company,
            address: contact.address,
            city: contact.city,
            state: contact.state,
            zipCode: contact.zipCode,
            notes: contact.notes,
          });
          
          if (result) {
            await storage.updateCrmContact(contact.id, { 
              googleContactId: result.resourceName 
            });
            results.synced++;
          } else {
            results.failed++;
          }
        } catch (err) {
          results.failed++;
        }
      }
      
      res.json(results);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to sync contacts" });
    }
  });

  app.post("/api/google/import-contacts", requireStaffAdministrator, async (req, res) => {
    try {
      const status = googleContactsService.getStatus();
      if (!status.configured) {
        res.status(400).json({ 
          error: "Google Contacts not configured. Complete OAuth setup first." 
        });
        return;
      }

      const googleContacts = await googleContactsService.listAllContacts();
      const results = { imported: 0, skipped: 0, failed: 0 };
      
      for (const gContact of googleContacts) {
        try {
          const googleContactId = (gContact as any).googleContactId;
          
          if (googleContactId) {
            const existingContact = await storage.getCrmContactByGoogleId(googleContactId);
            if (existingContact) {
              results.skipped++;
              continue;
            }
          }

          const existingByPhoneOrEmail = await storage.getCrmContactByPhoneOrEmail(
            gContact.mobilePhone || null, 
            gContact.email || null
          );
          
          if (existingByPhoneOrEmail) {
            await storage.updateCrmContact(existingByPhoneOrEmail.id, { 
              googleContactId 
            });
            results.skipped++;
            continue;
          }

          await storage.createCrmContact({
            fullName: gContact.fullName,
            email: gContact.email,
            mobilePhone: gContact.mobilePhone,
            officePhone: gContact.officePhone,
            company: gContact.company,
            address: gContact.address,
            city: gContact.city,
            state: gContact.state,
            zipCode: gContact.zipCode,
            notes: gContact.notes,
            googleContactId,
          });
          results.imported++;
        } catch (err) {
          console.error('Failed to import contact:', err);
          results.failed++;
        }
      }
      
      res.json({ 
        success: true, 
        totalFromGoogle: googleContacts.length,
        ...results 
      });
    } catch (error: any) {
      console.error('Google import error:', error);
      res.status(500).json({ error: error.message || "Failed to import contacts" });
    }
  });

  app.get("/api/google/contact-count", async (req, res) => {
    try {
      const count = await googleContactsService.getContactCount();
      res.json({ count });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to get contact count" });
    }
  });

  }
  // ============================================
  // Google Calendar (scheduling) Endpoints
  // ============================================
  app.get("/api/calendar/status", async (_req, res) => {
    try {
      const settings = await getTwilioSettings();
      const status = await googleCalendarService.getStatus();
      res.json({
        ...status,
        attachedCalendarId: settings.schedulingCalendarId || null,
        blockBusy: settings.schedulingCalendarBlockBusy,
        pushEvents: settings.schedulingCalendarPushEvents,
      });
    } catch (e: any) {
      res.status(500).json({ connected: false, error: e?.message || "Calendar status failed" });
    }
  });

  app.get("/api/calendar/list", async (_req, res) => {
    try {
      const items = await googleCalendarService.listCalendars();
      res.json({ calendars: items });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Failed to list calendars" });
    }
  });

  app.patch("/api/calendar/settings", async (req, res) => {
    try {
      const { schedulingCalendarId, schedulingCalendarBlockBusy, schedulingCalendarPushEvents } = req.body || {};
      const patch: any = {};
      if (schedulingCalendarId !== undefined) patch.schedulingCalendarId = schedulingCalendarId || null;
      if (schedulingCalendarBlockBusy !== undefined) patch.schedulingCalendarBlockBusy = !!schedulingCalendarBlockBusy;
      if (schedulingCalendarPushEvents !== undefined) patch.schedulingCalendarPushEvents = !!schedulingCalendarPushEvents;
      const updated = await updateTwilioSettings(patch);
      res.json({
        schedulingCalendarId: updated.schedulingCalendarId,
        schedulingCalendarBlockBusy: updated.schedulingCalendarBlockBusy,
        schedulingCalendarPushEvents: updated.schedulingCalendarPushEvents,
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Failed to update calendar settings" });
    }
  });

  // ============================================
  // ARIA AI Assistant Endpoints
  // ============================================

  // ── PUBLIC customer support chatbot ────────────────────────────────────────
  // Unauthenticated endpoint used by the website chat widget. Uses the restricted
  // customer-facing prompt (no internal platform data). Rate-limited per IP.
  const supportChatLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    message: "You're sending messages too quickly. Please wait a moment.",
  });
  app.post("/api/aria/support-chat", supportChatLimiter, async (req, res) => {
    try {
      if (!ariaService.getStatus().configured) {
        res.status(503).json({
          error: "The chat assistant is unavailable right now. Please call (954) 637-7300.",
        });
        return;
      }

      const raw = (req.body?.messages ?? []) as unknown;
      if (!Array.isArray(raw) || raw.length === 0) {
        res.status(400).json({ error: "messages is required" });
        return;
      }

      // Sanitize: keep only the recent turns, cap length, valid roles/content.
      const messages = raw
        .slice(-12)
        .map((m: any) => ({
          role: m?.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: String(m?.content ?? "").slice(0, 2000),
        }))
        .filter((m) => m.content.trim().length > 0);

      if (messages.length === 0) {
        res.status(400).json({ error: "Message cannot be empty" });
        return;
      }

      const result = await ariaService.supportChat(messages);
      res.json({ reply: result.content });
    } catch (error) {
      console.error("[aria support-chat] error:", error);
      res.status(500).json({
        error: "Sorry, something went wrong. Please try again or call (954) 637-7300.",
      });
    }
  });

  // All private Aria endpoints remain behind the existing staff gate. The
  // public support-chat endpoint above is intentionally separate.
  app.use("/api/aria", async (req, res, next) => {
    try {
      if (!req.dbUser?.id) { res.status(401).json({ error: "Sign in required" }); return; }
      const scope = await getStaffAssignmentScope(req);
      const staff = await getStaffAccess(req);
      if (staff.approvalStatus !== "approved") { res.status(403).json({ error: "Approved staff access required" }); return; }
      const pathId = /^\/conversations\/([^/]+)$/.exec(req.path)?.[1];
      const conversationId = pathId || req.body?.conversationId || req.query.conversationId;
      if (conversationId !== undefined) {
        if (!/^[1-9]\d*$/.test(String(conversationId))) { res.status(400).json({ error: "Invalid conversation" }); return; }
        const conversation = await storage.getAriaConversation(Number(conversationId));
        if (!conversation || !ownsAriaConversation(conversation, req.dbUser.id, scope)) {
          res.status(404).json({ error: "Conversation not found" }); return;
        }
      }
      next();
    } catch { res.status(500).json({ error: "Aria authorization could not be checked" }); }
  });
  registerAriaConnectionRoutes(app);

  // Get ARIA status (is it configured?)
  app.get("/api/aria/status", async (req, res) => {
    try {
      const status = ariaService.getStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: "Failed to get ARIA status" });
    }
  });

  // List conversations
  app.get("/api/aria/conversations", async (req, res) => {
    try {
      const scope = await getStaffAssignmentScope(req);
      const conversations = await storage.getAriaConversations();
      res.json(conversations.filter(c => ownsAriaConversation(c, req.dbUser!.id, scope)));
    } catch (error) {
      console.error("Error listing ARIA conversations:", error);
      res.status(500).json({ error: "Failed to get conversations" });
    }
  });

  // Get conversation with messages
  app.get("/api/aria/conversations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const conversation = await storage.getAriaConversation(id);

      if (!conversation) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }

      const messages = await storage.getAriaMessages(id);
      res.json({ conversation, messages });
    } catch (error) {
      console.error("Error getting ARIA conversation:", error);
      res.status(500).json({ error: "Failed to get conversation" });
    }
  });

  // Create new conversation
  app.post("/api/aria/conversations", async (req, res) => {
    try {
      const { title } = req.body;
      const scope = await getStaffAssignmentScope(req);

      const conversation = await storage.createAriaConversation({
        sessionId: uuidv4(),
        userId: null,
        title: title || null,
        status: "active",
        metadata: JSON.stringify({ ownerUserId: req.dbUser!.id, access: isAdministratorScope(scope) ? "administrator" : "assigned", assignmentScope: ariaScopeFingerprint(scope) }),
      });

      res.status(201).json(conversation);
    } catch (error) {
      console.error("Error creating ARIA conversation:", error);
      res.status(500).json({ error: "Failed to create conversation" });
    }
  });

  // Delete conversation
  app.delete("/api/aria/conversations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteAriaConversation(id);

      if (!deleted) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting ARIA conversation:", error);
      res.status(500).json({ error: "Failed to delete conversation" });
    }
  });

  // Send message (non-streaming)
  app.post("/api/aria/chat", async (req, res) => {
    try {
      const { conversationId, message } = req.body;

      if (!conversationId || typeof message !== "string" || !message.trim() || message.length > 20_000) {
        res.status(400).json({ error: "conversationId and a message of at most 20000 characters are required" });
        return;
      }

      // Get conversation
      const conversation = await storage.getAriaConversation(conversationId);
      if (!conversation) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }

      // Save user message
      await storage.createAriaMessage({
        conversationId,
        role: "user",
        content: message,
        contextRefs: null,
        moduleUsed: null,
        tokensUsed: null,
        modelVersion: null,
      });

      // Get conversation history
      const history = await storage.getAriaMessages(conversationId);
      const chatMessages = history.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // Call ARIA service
      const model = req.body.model || 'claude';
      const response = await ariaService.chat(chatMessages, conversationId, model, {
        userId: req.dbUser!.id, conversationId, scope: await getStaffAssignmentScope(req),
        canReadCrm: (await getStaffAccess(req)).features.crm,
        canCommunicate: (await getStaffAccess(req)).features.communications,
      });

      // Save assistant response
      const assistantMessage = await storage.createAriaMessage({
        conversationId,
        role: "assistant",
        content: response.content,
        contextRefs: JSON.stringify(response.contextRefs),
        moduleUsed: null,
        tokensUsed: response.tokensUsed,
        modelVersion: response.modelUsed,
      });

      // Update conversation title if first message
      if (history.length === 1 && !conversation.title) {
        const title = message.substring(0, 50) + (message.length > 50 ? "..." : "");
        await storage.updateAriaConversation(conversationId, { title });
      }

      res.json({
        message: assistantMessage,
        tokensUsed: response.tokensUsed,
      });
    } catch (error: any) {
      console.error("ARIA chat error:", error);
      res.status(500).json({ error: error.message || "Failed to process message" });
    }
  });

  // Streaming chat endpoint (SSE)
  app.post("/api/aria/chat/stream", async (req, res) => {
    try {
      const { conversationId, message } = req.body;

      if (!conversationId || typeof message !== "string" || !message.trim() || message.length > 20_000) {
        res.status(400).json({ error: "conversationId and a message of at most 20000 characters are required" });
        return;
      }

      const conversation = await storage.getAriaConversation(conversationId);
      if (!conversation) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }

      // Save user message
      await storage.createAriaMessage({
        conversationId,
        role: "user",
        content: message,
        contextRefs: null,
        moduleUsed: null,
        tokensUsed: null,
        modelVersion: null,
      });

      // Get conversation history
      const history = await storage.getAriaMessages(conversationId);
      const chatMessages = history.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // Set up SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      const heartbeat = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) res.write(": keep-alive\n\n");
      }, 15_000);
      res.once("close", () => clearInterval(heartbeat));

      let fullContent = "";
      const model = req.body.model || 'claude';

      const result = await ariaService.streamChat(
        chatMessages,
        conversationId,
        (chunk) => {
          fullContent += chunk;
          res.write(`data: ${JSON.stringify({ type: "chunk", content: chunk })}\n\n`);
        },
        model,
        { userId: req.dbUser!.id, conversationId, scope: await getStaffAssignmentScope(req), canReadCrm: (await getStaffAccess(req)).features.crm, canCommunicate: (await getStaffAccess(req)).features.communications }
      );

      // Save complete assistant message
      const assistantMessage = await storage.createAriaMessage({
        conversationId,
        role: "assistant",
        content: fullContent,
        contextRefs: JSON.stringify(result.contextRefs),
        moduleUsed: null,
        tokensUsed: result.tokensUsed,
        modelVersion: result.modelUsed,
      });

      // Update conversation title if needed
      if (history.length === 1 && !conversation.title) {
        const title = message.substring(0, 50) + (message.length > 50 ? "..." : "");
        await storage.updateAriaConversation(conversationId, { title });
      }

      res.write(`data: ${JSON.stringify({
        type: "done",
        messageId: assistantMessage.id,
        tokensUsed: result.tokensUsed
      })}\n\n`);
      res.end();
    } catch (error: any) {
      console.error("ARIA stream error:", error);
      res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
      res.end();
    }
  });

  app.post("/api/aria/tts", async (req, res) => {
    try {
      const { text, voice } = req.body;

      if (!text || typeof text !== 'string') {
        res.status(400).json({ error: "text is required" });
        return;
      }

      const audioBuffer = await ariaService.textToSpeech(text, voice || 'nova');

      if (!audioBuffer) {
        res.status(503).json({ error: "TTS not available" });
        return;
      }

      res.set({
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioBuffer.length.toString(),
        'Cache-Control': 'no-cache',
      });
      res.send(audioBuffer);
    } catch (error: any) {
      console.error("TTS error:", error);
      res.status(500).json({ error: error.message || "TTS failed" });
    }
  });

  app.get("/api/aria/tts/status", (req, res) => {
    res.json({
      available: ariaService.hasTTS,
      voices: ariaService.hasTTS ? [
        { id: 'nova', name: 'Nova', description: 'Warm and natural' },
        { id: 'shimmer', name: 'Shimmer', description: 'Soft and clear' },
        { id: 'coral', name: 'Coral', description: 'Friendly and expressive' },
        { id: 'sage', name: 'Sage', description: 'Calm and measured' },
        { id: 'alloy', name: 'Alloy', description: 'Neutral and balanced' },
        { id: 'echo', name: 'Echo', description: 'Warm and resonant' },
        { id: 'ash', name: 'Ash', description: 'Gentle and soft' },
        { id: 'fable', name: 'Fable', description: 'Storytelling warmth' },
        { id: 'onyx', name: 'Onyx', description: 'Deep and authoritative' },
      ] : [],
    });
  });

  registerAriaMultiCamRoutes(app);

  // Mount API routes
  app.use("/api/network", networkRoutes);
  app.use("/api/crm", crmPipelineRoutes); // deals + pipeline (contacts/leads/jobs stay inline above)

  // -------- Twilio (SMS / voice) --------
  app.get("/api/twilio/status", async (_req, res) => {
    try {
      const configured = await isTwilioConfigured();
      const phoneNumber = configured ? await getTwilioFromPhoneNumber() : undefined;
      res.json({ configured, phoneNumber });
    } catch (err: any) {
      res.json({ configured: false, error: err.message });
    }
  });

  // SMS-capable phone numbers on the Twilio account. The A2P wizard uses
  // this to let the owner pick which number to attach to the new Messaging
  // Service when more than one number is available.
  app.get("/api/twilio/phone-numbers", async (_req, res) => {
    try {
      const configured = await isTwilioConfigured();
      if (!configured) {
        res.json({ configured: false, numbers: [], configuredPhoneNumber: null });
        return;
      }
      const { listTwilioSmsNumbers } = await import("../twilio");
      const [numbers, configuredPhoneNumber] = await Promise.all([
        listTwilioSmsNumbers(),
        getTwilioFromPhoneNumber(),
      ]);
      res.json({ configured: true, numbers, configuredPhoneNumber: configuredPhoneNumber || null });
    } catch (err: any) {
      res.status(500).json({ configured: false, numbers: [], error: err?.message });
    }
  });

  // A2P 10DLC registration status. Surfaces brand + campaign state from Twilio
  // so the Messages page can warn the account owner before carriers start
  // dropping outbound texts with error 30034. The actual lookup lives in
  // `server/a2p-status.ts` so the scheduled monitor in `server/a2p-monitor.ts`
  // can reuse the exact same logic.
  app.get("/api/twilio/a2p/status", async (_req, res) => {
    const { getA2PStatus } = await import("../a2p-status");
    const result = await getA2PStatus();
    res.json(result);
  });

  // Server-Sent Events stream that pushes a `status` event whenever the
  // background monitor (server/a2p-monitor.ts) observes the A2P verdict or
  // rejection set change. The Messages page banner subscribes here so it
  // can refresh within seconds of a Twilio update instead of waiting up to
  // 5 minutes for its next poll. If the EventSource fails (proxy strips
  // SSE, browser tab throttled, etc.) the client keeps its 5-minute poll
  // as a fallback.
  // Requires auth (long-lived socket — gate it behind a session to avoid
  // anonymous connection abuse) even though the snapshot endpoint above
  // is open. Snooze GET is already isAuthenticated, so banner viewers
  // already have a session.
  app.get("/api/twilio/a2p/events", requireAuth, async (req, res) => {
    const { addA2PEventClient } = await import("../a2p-events");
    const cleanup = addA2PEventClient(res);
    req.on("close", cleanup);
    req.on("error", cleanup);
  });

  // Snooze controls so an owner who's already in a Twilio support thread can
  // mute repeat A2P alerts without disabling the monitor entirely. The
  // monitor reads the same state file we write here.
  //
  // Authorization model: muting A2P paging is org-wide, so restrict it to
  // the same "owner" identity the monitor already treats as the page
  // recipient (A2P_ALERT_EMAIL / CSD_ADMIN_EMAIL) plus any user whose
  // stored role is owner/admin. A logged-in but ordinary user gets 403 and
  // the UI hides the controls based on the GET response.
  const ownerEmailsFromEnv = (): string[] =>
    [process.env.A2P_ALERT_EMAIL, process.env.CSD_ADMIN_EMAIL]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map((v) => v.toLowerCase());
  const resolveActor = async (req: import("express").Request) => {
    const email = String(req.dbUser?.email || getAuth(req).sessionClaims?.email || "").toLowerCase() || null;
    const sub = req.dbUser?.id || null;
    let role: string | null = null;
    if (email) {
      try {
        const record = await storage.getUserByUsername(email);
        if (record?.role) role = record.role;
      } catch {
        // Storage may not have the user yet; fall through to env check.
      }
    }
    const isOwner =
      role === "owner" ||
      role === "admin" ||
      isAdminEmail(email) ||
      (email != null && ownerEmailsFromEnv().includes(email));
    return { email, sub, role, isOwner };
  };
  const requireOwner: import("express").RequestHandler = async (req, res, next) => {
    try {
      const actor = await resolveActor(req);
      if (!actor.isOwner) {
        res.status(403).json({ error: "Owner access required" });
        return;
      }
      (req as import("express").Request & { actor?: typeof actor }).actor = actor;
      next();
    } catch (err) {
      req.log.error({ error: (err as Error)?.message }, "Owner authorization check failed");
      res.status(500).json({ error: "Authorization check failed" });
    }
  };

  const emailCapacityRecheckLimiter = sharedRateLimit({
    windowMs: 60_000,
    max: 3,
    message: "Email capacity was checked recently. Please wait before checking again.",
    key: (req) => {
      const actor = (req as import("express").Request & {
        actor?: { sub: string | null; email: string | null };
      }).actor;
      return `provider-health-email-recheck:${actor?.sub || actor?.email || "unknown-owner"}`;
    },
  });

  app.get("/api/provider-health/email", providerHealthAuthMiddleware, requireOwner, async (req, res) => {
    try {
      res.json(GetEmailProviderHealthResponse.parse({
        provider: "SendGrid",
        proactiveCapacityMonitoring: getProviderHealthEmailCapacityStatus(),
        warningSettings: await getProviderHealthWarningSettings(),
        safeDefaults: {
          percentage: 10,
          remainingCredits: 100,
        },
      }));
    } catch (error) {
      req.log.error({ error: (error as Error)?.message }, "Invalid email provider health response");
      res.status(500).json({ error: "Email provider health is temporarily unavailable" });
    }
  });

  app.get("/api/provider-health/slack", providerHealthAuthMiddleware, requireOwner, async (req, res) => {
    try {
      res.json(GetSlackDeliveryHealthResponse.parse(await getSlackDeliveryHealth()));
    } catch (error) {
      req.log.error({ error: (error as Error)?.message }, "Invalid Slack delivery health response");
      res.status(500).json({ error: "Slack notification health is temporarily unavailable" });
    }
  });

  app.get("/api/provider-health/slack/failures", providerHealthAuthMiddleware, requireOwner, async (req, res) => {
    try {
      res.json(ListSlackTerminalFailuresResponse.parse(await listSlackTerminalFailures()));
    } catch {
      res.status(500).json({ error: "Slack failure history is temporarily unavailable" });
    }
  });

  app.post("/api/provider-health/slack/failures/:id/retry", providerHealthAuthMiddleware, requireOwner, async (req, res) => {
    const params = RetrySlackTerminalFailureParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid failure ID" });
      return;
    }
    const actor = (req as import("express").Request & { actor?: { sub: string | null } }).actor;
    if (!actor?.sub) {
      res.status(403).json({ error: "Owner identity required" });
      return;
    }
    try {
      const retry = await retrySlackTerminalFailure(params.data.id, actor.sub);
      if (!retry) {
        res.status(404).json({ error: "Terminal failure not found" });
        return;
      }
      res.json(RetrySlackTerminalFailureResponse.parse(retry));
    } catch {
      res.status(500).json({ error: "Slack retry could not be queued" });
    }
  });

  app.patch("/api/provider-health/email/warning-settings", providerHealthAuthMiddleware, requireOwner, async (req, res) => {
    const parsed = UpdateEmailProviderWarningSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Choose the safe defaults, a percentage from 1 to 100, or a remaining-credit threshold from 1 to 1,000,000,000." });
      return;
    }
    const actor = (req as import("express").Request & {
      actor?: { email: string | null; sub: string | null };
    }).actor;
    if (!actor?.sub) {
      res.status(500).json({ error: "Authenticated owner identity unavailable" });
      return;
    }
    try {
      res.json(UpdateEmailProviderWarningSettingsResponse.parse(
        await updateProviderHealthWarningSettings(parsed.data, {
          userId: actor.sub,
          email: actor.email,
        }),
      ));
    } catch (error) {
      req.log.error({ error: (error as Error)?.message }, "Invalid email provider warning settings response");
      res.status(500).json({ error: "Email provider health is temporarily unavailable" });
    }
  });

  app.get(
    "/api/provider-health/email/warning-settings/history",
    providerHealthAuthMiddleware,
    requireOwner,
    async (req, res) => {
      const query = GetEmailProviderWarningSettingsHistoryQueryParams.safeParse(req.query);
      if (!query.success) {
        res.status(400).json({ error: "Choose valid history pagination and date filters." });
        return;
      }
      if (!validWarningHistoryDates(query.data.fromDate, query.data.toDate)) {
        res.status(400).json({ error: "Choose valid history start and end dates." });
        return;
      }
      let cursor;
      try {
        cursor = query.data.cursor
          ? parseEmailCapacityWarningSettingsAuditCursor(query.data.cursor)
          : undefined;
      } catch {
        res.status(400).json({ error: "Choose valid history pagination and date filters." });
        return;
      }
      try {
        res.json(GetEmailProviderWarningSettingsHistoryResponse.parse(
          await getProviderHealthWarningSettingsAudit({
            limit: query.data.limit,
            cursor,
            fromDate: query.data.fromDate,
            toDate: query.data.toDate,
          }),
        ));
      } catch (error) {
        req.log.error({ error: (error as Error)?.message }, "Invalid email provider warning settings history response");
        res.status(500).json({ error: "Email provider health is temporarily unavailable" });
      }
    },
  );

  app.get(
    "/api/provider-health/email/warning-settings/history/export",
    providerHealthAuthMiddleware,
    requireOwner,
    async (req, res) => {
      const query = ExportEmailProviderWarningSettingsHistoryQueryParams.safeParse(req.query);
      if (!query.success || !validWarningHistoryDates(query.data.fromDate, query.data.toDate)) {
        res.status(400).json({ error: "Choose valid history start and end dates." });
        return;
      }
      try {
        const items: import("../email-capacity-settings").EmailCapacityWarningSettingsAuditEntry[] = [];
        let cursor: string | null = null;
        do {
          const page = GetEmailProviderWarningSettingsHistoryResponse.parse(
            await getProviderHealthWarningSettingsAudit({
              limit: 100,
              cursor: cursor ? parseEmailCapacityWarningSettingsAuditCursor(cursor) : undefined,
              fromDate: query.data.fromDate,
              toDate: query.data.toDate,
            }),
          );
          items.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", 'attachment; filename="email-warning-changes.csv"');
        res.setHeader("Cache-Control", "private, no-store");
        res.send(formatEmailCapacityWarningSettingsAuditCsv(items));
      } catch (error) {
        req.log.error({ error: (error as Error)?.message }, "Invalid email provider warning settings export response");
        res.status(500).json({ error: "Email provider health is temporarily unavailable" });
      }
    },
  );

  app.post(
    "/api/provider-health/email/recheck",
    providerHealthAuthMiddleware,
    requireOwner,
    emailCapacityRecheckLimiter,
    async (req, res) => {
      try {
        res.json(RecheckEmailProviderHealthResponse.parse(
          await recheckProviderHealthEmailCapacity(),
        ));
      } catch (error) {
        req.log.error({ error: (error as Error)?.message }, "Invalid email provider health recheck response");
        res.status(500).json({ error: "Email provider health is temporarily unavailable" });
      }
    },
  );

  app.get(
    "/api/crm/deleted-contact-placeholders",
    requireAuth,
    requireOwner,
    async (_req, res) => {
      const client = await pool.connect();
      try {
        const reviews = await reviewDeletedContactPlaceholdersWithRecords(client);
        res.json(reviews);
        return;
      } catch (error) {
        console.error("[crm/deleted-contact-placeholders] failed:", (error as Error)?.message);
        res.status(500).json({ error: "Failed to load retained deleted contacts" });
        return;
      } finally {
        client.release();
      }
    },
  );

  // GET is open to any authenticated user so the whole team can see when
  // A2P paging is muted — but we redact `snoozeStartedBy` for non-owners
  // and add an `allowed` flag the UI uses to decide whether to render the
  // snooze/resume buttons.
  app.get("/api/twilio/a2p/snooze", requireAuth, async (req, res) => {
    const { getA2PSnoozeStatus } = await import("../a2p-monitor");
    const [status, actor] = await Promise.all([
      getA2PSnoozeStatus(),
      resolveActor(req),
    ]);
    res.json({
      ...status,
      snoozeStartedBy: actor.isOwner ? status.snoozeStartedBy : null,
      allowed: actor.isOwner,
    });
  });

  const snoozeBodySchema = z.object({ hours: z.coerce.number().positive() });
  app.post("/api/twilio/a2p/snooze", requireAuth, requireOwner, async (req, res) => {
    const { snoozeA2PAlerts } = await import("../a2p-monitor");
    const parsed = snoozeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "hours must be a positive number" });
      return;
    }
    // Actor was resolved + verified by requireOwner, attached to req.
    const actor = (req as import("express").Request & {
      actor?: { email: string | null; sub: string | null };
    }).actor;
    const startedBy = actor?.email || actor?.sub || null;
    try {
      const status = await snoozeA2PAlerts(parsed.data.hours, startedBy);
      res.json(status);
    } catch (err) {
      res.status(400).json({ error: (err as Error)?.message || "Failed to snooze" });
    }
  });

  app.delete("/api/twilio/a2p/snooze", requireAuth, requireOwner, async (_req, res) => {
    const { clearA2PSnooze } = await import("../a2p-monitor");
    res.json(await clearA2PSnooze());
  });

  // Incident history for the Messages page. Returns the last ~10 alerts the
  // A2P background monitor opened, with start/end times, duration, and how
  // each one was resolved (auto by the monitor vs acknowledged by a human).
  // Restricted to owners/admins — same gate as the snooze controls — because
  // it exposes operational reliability data the rest of the team doesn't
  // need to act on.
  app.get(
    "/api/twilio/a2p/incidents",
    requireAuth,
    requireOwner,
    async (_req, res) => {
      try {
        const list = await storage.getAlertsBySource("a2p-monitor", 10);
        const incidents = list.map((a) => {
          const startedAt = a.createdAt ?? null;
          const resolvedAt = a.resolvedAt ?? null;
          let durationMs: number | null = null;
          if (startedAt && resolvedAt) {
            durationMs = new Date(resolvedAt).getTime() - new Date(startedAt).getTime();
          }
          // Heuristic: the background monitor's auto-resolve path only sets
          // `status` + `resolvedAt`. When a human resolves an alert through
          // the Alerts UI they ack first (acknowledgedBy is set). Use that
          // to distinguish the two outcomes.
          let outcome: "active" | "auto-resolved" | "human-resolved";
          if (a.status !== "resolved") {
            outcome = "active";
          } else if (a.acknowledgedBy != null) {
            outcome = "human-resolved";
          } else {
            outcome = "auto-resolved";
          }
          return {
            id: a.id,
            title: a.title,
            severity: a.severity,
            status: a.status,
            startedAt,
            resolvedAt,
            durationMs,
            outcome,
          };
        });
        res.json(incidents);
      } catch (err) {
        console.error(
          "[a2p/incidents] failed:",
          (err as Error)?.message,
        );
        res.status(500).json({ error: "Failed to fetch A2P incidents" });
      }
    },
  );

  // A2P rejection-suggestion feedback loop. When Twilio returns a rejection
  // reason that doesn't match any pattern in `client/src/lib/a2p-rejections.ts`,
  // staff can submit a proposed plain-English remediation. Submissions land
  // in `a2p_rejection_suggestions` for owners/admins to review and use to
  // extend the curated KB.
  const suggestionInputSchema = z.object({
    reasonText: z.string().trim().min(1).max(2000),
    suggestedTitle: z.string().trim().min(3).max(200),
    suggestedRemediation: z.string().trim().min(10).max(2000),
    docUrl: z.string().trim().url().max(500).optional().or(z.literal("")),
  });

  app.post(
    "/api/twilio/a2p/rejection-suggestions",
    requireAuth,
    async (req, res) => {
      const parsed = suggestionInputSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: parsed.error.issues[0]?.message || "Invalid suggestion" });
        return;
      }
      try {
        const actor = await resolveActor(req);
        // De-dup: if a pending suggestion already covers this exact rejection
        // (ignoring case/whitespace), don't add another row — just tell the
        // submitter it's already reported and point at the existing entry.
        const existing = await storage.getPendingA2pRejectionSuggestionByReason(
          parsed.data.reasonText,
        );
        if (existing) {
          res.json({
            ok: true,
            id: existing.id,
            duplicate: true,
            message:
              "Thanks — someone already reported this rejection. It's waiting for review.",
          });
          return;
        }
        const created = await storage.createA2pRejectionSuggestion({
          reasonText: parsed.data.reasonText,
          suggestedTitle: parsed.data.suggestedTitle,
          suggestedRemediation: parsed.data.suggestedRemediation,
          docUrl: parsed.data.docUrl || undefined,
          submittedBy: actor.email || actor.sub || null,
        });
        res.json({ ok: true, id: created.id, duplicate: false });
      } catch (err) {
        console.error(
          "[a2p/rejection-suggestions] create failed:",
          (err as Error)?.message,
        );
        res.status(500).json({ error: "Failed to save suggestion" });
      }
    },
  );

  app.get(
    "/api/twilio/a2p/rejection-suggestions",
    requireAuth,
    requireOwner,
    async (req, res) => {
      try {
        const status = typeof req.query.status === "string" ? req.query.status : undefined;
        const list = await storage.getA2pRejectionSuggestions(
          status ? { status } : undefined,
        );
        res.json(list);
      } catch (err) {
        console.error(
          "[a2p/rejection-suggestions] list failed:",
          (err as Error)?.message,
        );
        res.status(500).json({ error: "Failed to load suggestions" });
      }
    },
  );

  const suggestionUpdateSchema = z.object({
    status: z.enum(["pending", "reviewed", "merged", "dismissed"]).optional(),
    reviewerNotes: z.string().trim().max(2000).nullable().optional(),
  });
  app.patch(
    "/api/twilio/a2p/rejection-suggestions/:id",
    requireAuth,
    requireOwner,
    async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: "Invalid id" });
        return;
      }
      const parsed = suggestionUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: parsed.error.issues[0]?.message || "Invalid update" });
        return;
      }
      try {
        const updated = await storage.updateA2pRejectionSuggestion(id, parsed.data);
        if (!updated) {
          res.status(404).json({ error: "Not found" });
          return;
        }
        res.json(updated);
      } catch (err) {
        console.error(
          "[a2p/rejection-suggestions] update failed:",
          (err as Error)?.message,
        );
        res.status(500).json({ error: "Failed to update suggestion" });
      }
    },
  );

  // A2P 10DLC guided registration. The Messages page wizard collects business
  // profile + campaign details and posts them here. We attempt each Trust Hub /
  // messaging step in order and return a per-step result so the UI can show
  // exactly what got created and what failed (e.g. brand creation often errors
  // until a customer profile bundle is approved by Twilio review).
  app.post("/api/twilio/a2p/register", async (req, res) => {
    interface RegisterBody {
      business?: {
        legalName?: string;
        ein?: string;
        businessType?: string; // LLC, Corporation, ...
        industry?: string;
        website?: string;
        regionsOfOperation?: string; // comma separated ISO codes e.g. "USA"
        address?: {
          street?: string;
          city?: string;
          region?: string;
          postalCode?: string;
          isoCountry?: string;
        };
        contact?: {
          firstName?: string;
          lastName?: string;
          email?: string;
          phone?: string;
          jobTitle?: string;
        };
      };
      campaign?: {
        description?: string;
        usAppToPersonUsecase?: string; // MIXED, CUSTOMER_CARE, MARKETING, ...
        messageSamples?: string[];
        optInMessage?: string;
        optInKeywords?: string[];
        messageFlow?: string;
        hasEmbeddedLinks?: boolean;
        hasEmbeddedPhone?: boolean;
        brandType?: string; // STANDARD or SOLE_PROPRIETOR
      };
      // Optional explicit PN... SID to attach to the messaging service. When
      // omitted we fall back to the configured TWILIO_PHONE_NUMBER's SID.
      phoneNumberSid?: string;
    }

    type StepResult =
      | { ok: true; sid: string; note?: string; reused?: boolean; phoneNumber?: string }
      | { ok: false; error: string; skipped?: boolean };

    const result: {
      configured: boolean;
      customerProfile: StepResult | null;
      brand: StepResult | null;
      messagingService: StepResult | null;
      phoneNumber: StepResult | null;
      campaign: StepResult | null;
    } = {
      configured: false,
      customerProfile: null,
      brand: null,
      messagingService: null,
      phoneNumber: null,
      campaign: null,
    };

    try {
      const body = (req.body || {}) as RegisterBody;
      const business = body.business || {};
      const campaign = body.campaign || {};
      const contact = business.contact || {};
      const address = business.address || {};

      // Light validation. Carriers + Twilio will reject anything thin so we
      // refuse early instead of submitting garbage.
      const missing: string[] = [];
      if (!business.legalName) missing.push("business.legalName");
      if (!business.ein) missing.push("business.ein");
      if (!business.website) missing.push("business.website");
      if (!contact.email) missing.push("business.contact.email");
      if (!campaign.description) missing.push("campaign.description");
      if (!campaign.usAppToPersonUsecase) missing.push("campaign.usAppToPersonUsecase");
      if (!campaign.messageSamples || campaign.messageSamples.filter(Boolean).length < 1) {
        missing.push("campaign.messageSamples");
      }
      if (!campaign.messageFlow) missing.push("campaign.messageFlow");
      if (missing.length) {
        res.status(400).json({ error: "Missing required fields", missing });
        return;
      }

      const configured = await isTwilioConfigured();
      result.configured = configured;
      if (!configured) {
        res.status(400).json({ error: "Twilio is not configured on this account", ...result });
        return;
      }

      const { getTwilioClient } = await import("../twilio");
      const client = await getTwilioClient();

      // The Twilio Node SDK doesn't expose typed namespaces for trusthub.v1
      // or messaging.v1.brandRegistrations / usAppToPerson, so we narrow to
      // just the fields we actually call. This keeps the SDK strongly typed
      // at the call site instead of relying on a blanket `any`.
      interface SidObject { sid: string }
      interface CustomerProfileInstance extends SidObject {
        update(opts: { status: string }): Promise<SidObject>;
        customerProfilesEntityAssignments: {
          create(opts: { objectSid: string }): Promise<SidObject>;
        };
      }
      interface TrustProductInstance extends SidObject {
        update(opts: { status: string }): Promise<SidObject>;
        trustProductsEntityAssignments: {
          create(opts: { objectSid: string }): Promise<SidObject>;
        };
        trustProductsChannelEndpointAssignment: {
          create(opts: { channelEndpointType: string; channelEndpointSid: string }): Promise<SidObject>;
        };
      }
      interface ListedServicePhoneNumber { sid: string; phoneNumberSid?: string; phoneNumber?: string }
      interface MessagingServiceInstance extends SidObject {
        usAppToPerson: {
          create(opts: {
            brandRegistrationSid: string;
            description: string;
            messageSamples: string[];
            usAppToPersonUsecase: string;
            hasEmbeddedLinks: boolean;
            hasEmbeddedPhone: boolean;
            messageFlow: string;
            optInMessage?: string;
            optInKeywords?: string[];
          }): Promise<SidObject>;
        };
        phoneNumbers: {
          create(opts: { phoneNumberSid: string }): Promise<SidObject>;
          list(opts: { limit: number }): Promise<ListedServicePhoneNumber[]>;
        };
      }
      interface ListedCustomerProfile { sid: string; friendlyName?: string; policySid?: string; status?: string }
      interface ListedTrustProduct { sid: string; friendlyName?: string; policySid?: string; status?: string }
      interface ListedBrandRegistration {
        sid: string;
        customerProfileBundleSid?: string;
        a2pProfileBundleSid?: string;
        status?: string;
      }
      interface ListedService { sid: string; friendlyName?: string }
      interface ListedCampaign {
        sid: string;
        brandRegistrationSid?: string;
        campaignStatus?: string;
      }
      interface MessagingServiceInstanceFull extends MessagingServiceInstance {
        usAppToPerson: MessagingServiceInstance["usAppToPerson"] & {
          list(opts: { limit: number }): Promise<ListedCampaign[]>;
          (sid: string): {
            update(opts: {
              hasEmbeddedLinks: boolean;
              hasEmbeddedPhone: boolean;
              messageSamples: string[];
              messageFlow: string;
              optInMessage?: string;
              optInKeywords?: string[];
              description: string;
              ageGated: boolean;
              directLending: boolean;
            }): Promise<SidObject>;
          };
        };
      }
      interface TwilioApi {
        addresses: {
          create(opts: {
            customerName: string;
            street: string;
            city: string;
            region: string;
            postalCode: string;
            isoCountry: string;
          }): Promise<SidObject>;
        };
        trusthub: {
          v1: {
            customerProfiles: {
              create(opts: { friendlyName: string; email: string; policySid: string }): Promise<SidObject>;
              list(opts: { limit: number }): Promise<ListedCustomerProfile[]>;
              (sid: string): CustomerProfileInstance;
            };
            trustProducts: {
              create(opts: { friendlyName: string; email: string; policySid: string }): Promise<SidObject>;
              list(opts: { limit: number }): Promise<ListedTrustProduct[]>;
              (sid: string): TrustProductInstance;
            };
            endUsers: {
              create(opts: { friendlyName: string; type: string; attributes: Record<string, unknown> }): Promise<SidObject>;
            };
          };
        };
        messaging: {
          v1: {
            brandRegistrations: {
              create(opts: {
                customerProfileBundleSid: string;
                a2PProfileBundleSid: string;
                brandType: string;
              }): Promise<SidObject>;
              list(opts: { limit: number }): Promise<ListedBrandRegistration[]>;
            };
            services: {
              create(opts: { friendlyName: string }): Promise<SidObject>;
              list(opts: { limit: number }): Promise<ListedService[]>;
              (sid: string): MessagingServiceInstanceFull;
            };
          };
        };
      }
      const c = client as unknown as TwilioApi;

      // Well-known Twilio policy SIDs published in the A2P 10DLC onboarding
      // docs. These are stable values that identify the regulatory policy
      // bundle templates and aren't account-specific.
      // https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api
      const SECONDARY_CP_POLICY_SID = "RNdfbf3fae0e1107f8aded728e92e0289"; // Secondary Customer Profile
      const A2P_TRUST_PRODUCT_POLICY_SID = "RNb0d4771c2c98518d916a3d4cd70a8f8b"; // A2P Messaging Trust Product

      // ---- Step 1: Customer Profile (Trust Hub) ----------------------------
      // Discover any existing secondary customer profile bundle for this org
      // (matched by friendly name + policy SID) so re-runs after Twilio
      // review don't pile up duplicate unapproved bundles. Only create a new
      // one if none exists.
      const cpFriendlyName = `${business.legalName} Customer Profile`;
      let customerProfileSid: string | null = null;
      let customerProfileReused = false;
      let businessEndUserSid: string | null = null;
      let repEndUserSid: string | null = null;
      let addressSid: string | null = null;
      try {
        let cp: SidObject | null = null;
        try {
          const existing = await c.trusthub.v1.customerProfiles.list({ limit: 100 });
          const match = existing.find(
            (b) => b.policySid === SECONDARY_CP_POLICY_SID && b.friendlyName === cpFriendlyName,
          );
          if (match) {
            cp = { sid: match.sid };
            customerProfileReused = true;
          }
        } catch (listErr) {
          console.warn("[a2p/register] customerProfiles.list failed:", (listErr as Error)?.message);
        }
        if (!cp) {
          cp = await c.trusthub.v1.customerProfiles.create({
            friendlyName: cpFriendlyName,
            email: contact.email!,
            policySid: SECONDARY_CP_POLICY_SID,
          });
        }
        customerProfileSid = cp.sid;

        // On a re-run, the existing bundle already has end users + address
        // attached and is mid-review (or approved). Skip attach/submit work
        // entirely — repeating it produces duplicate end users and Twilio
        // rejects status updates on already-submitted bundles.
        let submitted = false;
        if (!customerProfileReused) {
          try {
            const eu = await c.trusthub.v1.endUsers.create({
              friendlyName: `${business.legalName} business info`,
              type: "customer_profile_business_information",
              attributes: {
                business_name: business.legalName,
                business_type: business.businessType || "LLC",
                business_registration_identifier: "EIN",
                business_registration_number: business.ein,
                business_identity: "direct_customer",
                business_industry: business.industry || "PROFESSIONAL_SERVICES",
                business_regions_of_operation: business.regionsOfOperation || "USA",
                website_url: business.website,
              },
            });
            businessEndUserSid = eu.sid;
            await c.trusthub.v1.customerProfiles(cp.sid).customerProfilesEntityAssignments.create({ objectSid: eu.sid });
          } catch (assignErr) {
            console.warn("[a2p/register] business end user attach failed:", (assignErr as Error)?.message);
          }

          try {
            const rep = await c.trusthub.v1.endUsers.create({
              friendlyName: `${contact.firstName || ""} ${contact.lastName || ""}`.trim() || "Authorized Rep",
              type: "authorized_representative_1",
              attributes: {
                first_name: contact.firstName,
                last_name: contact.lastName,
                email: contact.email,
                phone_number: contact.phone,
                business_title: contact.jobTitle || "Owner",
                job_position: "Director",
              },
            });
            repEndUserSid = rep.sid;
            await c.trusthub.v1.customerProfiles(cp.sid).customerProfilesEntityAssignments.create({ objectSid: rep.sid });
          } catch (repErr) {
            console.warn("[a2p/register] rep attach failed:", (repErr as Error)?.message);
          }

          if (address.street && address.city && address.region && address.postalCode) {
            try {
              const addr = await c.addresses.create({
                customerName: business.legalName!,
                street: address.street,
                city: address.city,
                region: address.region,
                postalCode: address.postalCode,
                isoCountry: address.isoCountry || "US",
              });
              addressSid = addr.sid;
              await c.trusthub.v1.customerProfiles(cp.sid).customerProfilesEntityAssignments.create({ objectSid: addr.sid });
            } catch (addrErr) {
              console.warn("[a2p/register] address attach failed:", (addrErr as Error)?.message);
            }
          }

          try {
            await c.trusthub.v1.customerProfiles(cp.sid).update({ status: "pending-review" });
            submitted = true;
          } catch (subErr) {
            console.warn("[a2p/register] cp submit failed:", (subErr as Error)?.message);
          }
        }

        result.customerProfile = {
          ok: true,
          sid: cp.sid,
          reused: customerProfileReused,
          note: customerProfileReused
            ? "Reusing existing customer profile bundle from a previous submission."
            : submitted
              ? "Customer profile bundle submitted for Twilio review."
              : "Customer profile bundle created. Finish review submission in Twilio Console.",
        };
      } catch (cpErr) {
        result.customerProfile = { ok: false, error: (cpErr as Error)?.message || "customer profile create failed" };
      }

      // ---- Step 1b: A2P Trust Product bundle -------------------------------
      // Same idempotent pattern as the customer profile: look up an existing
      // A2P Messaging Trust Product bundle by friendly name + policy SID and
      // reuse it. Only create + attach + submit when none exists.
      const tpFriendlyName = `${business.legalName} A2P Trust Product`;
      let a2pTrustProductSid: string | null = null;
      let a2pTrustProductReused = false;
      try {
        let tp: SidObject | null = null;
        try {
          const existing = await c.trusthub.v1.trustProducts.list({ limit: 100 });
          const match = existing.find(
            (b) => b.policySid === A2P_TRUST_PRODUCT_POLICY_SID && b.friendlyName === tpFriendlyName,
          );
          if (match) {
            tp = { sid: match.sid };
            a2pTrustProductReused = true;
          }
        } catch (listErr) {
          console.warn("[a2p/register] trustProducts.list failed:", (listErr as Error)?.message);
        }
        if (!tp) {
          tp = await c.trusthub.v1.trustProducts.create({
            friendlyName: tpFriendlyName,
            email: contact.email!,
            policySid: A2P_TRUST_PRODUCT_POLICY_SID,
          });
        }
        a2pTrustProductSid = tp.sid;

        if (!a2pTrustProductReused) {
          for (const objectSid of [businessEndUserSid, repEndUserSid, addressSid, customerProfileSid].filter(
            (s): s is string => !!s,
          )) {
            try {
              await c.trusthub.v1.trustProducts(tp.sid).trustProductsEntityAssignments.create({ objectSid });
            } catch (attachErr) {
              console.warn("[a2p/register] tp attach failed for", objectSid, (attachErr as Error)?.message);
            }
          }

          try {
            await c.trusthub.v1.trustProducts(tp.sid).update({ status: "pending-review" });
          } catch (subErr) {
            console.warn("[a2p/register] tp submit failed:", (subErr as Error)?.message);
          }
        }
      } catch (tpErr) {
        console.warn("[a2p/register] trust product create failed:", (tpErr as Error)?.message);
      }

      // ---- Step 2: Brand registration --------------------------------------
      // Discover an existing brand registration matching our two bundle SIDs
      // before attempting to create one. Brand creation only succeeds after
      // both bundles are approved (1–3 weeks); reusing the existing brand on
      // re-run lets Step 4 (campaign) finally go through without piling up
      // duplicates.
      if (customerProfileSid && a2pTrustProductSid) {
        let brandReused = false;
        let brandSid: string | null = null;
        let brandStatus: string | undefined;
        try {
          const existingBrands = await c.messaging.v1.brandRegistrations.list({ limit: 100 });
          const match = existingBrands.find(
            (b) =>
              b.customerProfileBundleSid === customerProfileSid &&
              b.a2pProfileBundleSid === a2pTrustProductSid,
          );
          if (match) {
            brandSid = match.sid;
            brandStatus = match.status;
            brandReused = true;
          }
        } catch (listErr) {
          console.warn("[a2p/register] brandRegistrations.list failed:", (listErr as Error)?.message);
        }

        if (brandSid) {
          // Reuse — surface the upstream status (APPROVED / PENDING / FAILED).
          // When the brand exists but isn't approved, we still want to expose
          // its SID to the UI without lying about success, so we report
          // ok:true with a status note for APPROVED and ok:false with a
          // "still in review" error otherwise. Step 4 keys off ok:true.
          if (brandStatus === "APPROVED") {
            result.brand = {
              ok: true,
              sid: brandSid,
              reused: true,
              note: "Reusing existing approved brand registration.",
            };
          } else {
            result.brand = {
              ok: false,
              error: `Reusing existing brand ${brandSid} — status is ${brandStatus || "unknown"}. Campaign will be attempted on re-run after Twilio approves the brand.`,
              skipped: true,
            };
          }
        } else {
          try {
            const brand = await c.messaging.v1.brandRegistrations.create({
              customerProfileBundleSid: customerProfileSid,
              a2PProfileBundleSid: a2pTrustProductSid,
              brandType: campaign.brandType || "STANDARD",
            });
            result.brand = { ok: true, sid: brand.sid, reused: false, note: "Brand registration submitted." };
          } catch (brandErr) {
            result.brand = {
              ok: false,
              error: (brandErr as Error)?.message || "brandRegistrations.create failed",
              skipped: false,
            };
          }
        }
      } else {
        result.brand = {
          ok: false,
          error: !customerProfileSid
            ? "Skipped: customer profile bundle was not created."
            : "Skipped: A2P trust product bundle was not created.",
          skipped: true,
        };
      }

      // ---- Step 3: Messaging Service ---------------------------------------
      // Idempotent reuse: discover existing service by friendly name before
      // creating a new one. Independent of brand status — owner needs the
      // service available regardless.
      const svcFriendlyName = `${business.legalName} A2P`;
      let messagingServiceSid: string | null = null;
      let messagingServiceReused = false;
      try {
        try {
          const existingServices = await c.messaging.v1.services.list({ limit: 100 });
          const match = existingServices.find((s) => s.friendlyName === svcFriendlyName);
          if (match) {
            messagingServiceSid = match.sid;
            messagingServiceReused = true;
          }
        } catch (listErr) {
          console.warn("[a2p/register] services.list failed:", (listErr as Error)?.message);
        }
        if (!messagingServiceSid) {
          const svc = await c.messaging.v1.services.create({ friendlyName: svcFriendlyName });
          messagingServiceSid = svc.sid;
        }
        result.messagingService = {
          ok: true,
          sid: messagingServiceSid,
          reused: messagingServiceReused,
          note: messagingServiceReused ? "Reusing existing messaging service." : undefined,
        };
      } catch (svcErr) {
        result.messagingService = { ok: false, error: (svcErr as Error)?.message || "messagingService create failed" };
      }

      // ---- Step 3b: attach the configured From number ----------------------
      // Carriers only enforce A2P rules on traffic sent through a Messaging
      // Service tied to an approved campaign — so the number must live on
      // the service or outbound texts keep hitting 30034 even after approval.
      if (messagingServiceSid) {
        try {
          const { getTwilioFromPhoneNumberSid, getTwilioFromPhoneNumber, listTwilioSmsNumbers } = await import("../twilio");
          const requestedSid = (body.phoneNumberSid || "").trim();
          const phoneNumberSid = requestedSid || (await getTwilioFromPhoneNumberSid());
          if (!phoneNumberSid) {
            result.phoneNumber = {
              ok: false,
              skipped: true,
              error: "Skipped: no Twilio phone number configured to attach.",
            };
          } else {
            // Re-check current attachments so re-runs don't error with
            // "phone number already in service".
            let existingAttachmentSid: string | null = null;
            let existingPhoneNumber: string | undefined;
            try {
              const attached = await c.messaging.v1.services(messagingServiceSid).phoneNumbers.list({ limit: 100 });
              const match = attached.find((p) => p.phoneNumberSid === phoneNumberSid || p.sid === phoneNumberSid);
              if (match) {
                existingAttachmentSid = match.sid;
                existingPhoneNumber = match.phoneNumber;
              }
            } catch (listErr) {
              console.warn("[a2p/register] service phoneNumbers.list failed:", (listErr as Error)?.message);
            }
            // Resolve the E.164 string for *this specific* SID so the result
            // panel doesn't misreport when the owner picked a number other
            // than the default configured one.
            const resolvePhoneNumberFor = async (sid: string): Promise<string | undefined> => {
              try {
                const all = await listTwilioSmsNumbers();
                const hit = all.find((n) => n.sid === sid);
                if (hit) return hit.phoneNumber;
              } catch { /* fall through */ }
              return (await getTwilioFromPhoneNumber()) || undefined;
            };
            if (existingAttachmentSid) {
              result.phoneNumber = {
                ok: true,
                sid: existingAttachmentSid,
                reused: true,
                phoneNumber: existingPhoneNumber || (await resolvePhoneNumberFor(phoneNumberSid)),
                note: "Phone number already attached to this messaging service.",
              };
            } else {
              const attached = await c.messaging.v1.services(messagingServiceSid).phoneNumbers.create({ phoneNumberSid });
              result.phoneNumber = {
                ok: true,
                sid: attached.sid,
                phoneNumber: await resolvePhoneNumberFor(phoneNumberSid),
              };
            }
          }
        } catch (attachErr) {
          result.phoneNumber = {
            ok: false,
            error: (attachErr as Error)?.message || "phoneNumbers.create failed",
          };
        }
      } else {
        result.phoneNumber = {
          ok: false,
          skipped: true,
          error: "Skipped: messaging service was not created.",
        };
      }

      // ---- Step 4: us_app_to_person campaign -------------------------------
      // Requires brand SID (APPROVED) + a messaging service SID. Re-uses an
      // existing campaign on the service when present so re-runs don't
      // duplicate. Only attempts creation when brand registration is
      // ok:true (i.e. approved or freshly created — Twilio itself rejects
      // campaign create when the brand isn't approved yet).
      if (messagingServiceSid && result.brand?.ok && "sid" in result.brand && result.brand.sid) {
        const brandSid = result.brand.sid;
        try {
          let existingCampaignSid: string | null = null;
          let existingCampaignStatus: string | undefined;
          try {
            const existing = await c.messaging.v1.services(messagingServiceSid).usAppToPerson.list({ limit: 10 });
            const match = existing.find((u) => u.brandRegistrationSid === brandSid);
            if (match) {
              existingCampaignSid = match.sid;
              existingCampaignStatus = match.campaignStatus;
            }
          } catch (listErr) {
            console.warn("[a2p/register] usAppToPerson.list failed:", (listErr as Error)?.message);
          }

          if (existingCampaignSid && existingCampaignStatus?.toUpperCase() === "FAILED") {
            try {
              const updated = await c.messaging.v1
                .services(messagingServiceSid)
                .usAppToPerson(existingCampaignSid)
                .update({
                  hasEmbeddedLinks: !!campaign.hasEmbeddedLinks,
                  hasEmbeddedPhone: !!campaign.hasEmbeddedPhone,
                  messageSamples: (campaign.messageSamples || []).filter(Boolean),
                  messageFlow: campaign.messageFlow!,
                  optInMessage: campaign.optInMessage,
                  optInKeywords: (campaign.optInKeywords || []).filter(Boolean),
                  description: campaign.description!,
                  ageGated: false,
                  directLending: false,
                });
              result.campaign = {
                ok: true,
                sid: updated.sid,
                reused: true,
                note: "Updated the rejected campaign with the revised CTA and resubmitted it for review.",
              };
            } catch (updateErr) {
              result.campaign = {
                ok: false,
                error: (updateErr as Error)?.message || "Failed to update the rejected campaign.",
              };
            }
          } else if (existingCampaignSid) {
            result.campaign = {
              ok: true,
              sid: existingCampaignSid,
              reused: true,
              note: "Reusing existing campaign on this messaging service.",
            };
          } else {
            const usaps = await c.messaging.v1.services(messagingServiceSid).usAppToPerson.create({
              brandRegistrationSid: brandSid,
              description: campaign.description!,
              messageSamples: (campaign.messageSamples || []).filter(Boolean),
              usAppToPersonUsecase: campaign.usAppToPersonUsecase!,
              hasEmbeddedLinks: !!campaign.hasEmbeddedLinks,
              hasEmbeddedPhone: !!campaign.hasEmbeddedPhone,
              messageFlow: campaign.messageFlow!,
              optInMessage: campaign.optInMessage,
              optInKeywords: (campaign.optInKeywords || []).filter(Boolean),
            });
            result.campaign = { ok: true, sid: usaps.sid, reused: false };
          }
        } catch (capErr) {
          result.campaign = { ok: false, error: (capErr as Error)?.message || "usAppToPerson.create failed" };
        }
      } else {
        result.campaign = {
          ok: false,
          skipped: true,
          error: !messagingServiceSid
            ? "Skipped: messaging service was not created."
            : "Skipped: brand registration is not yet approved. Re-run the wizard once Twilio approves the brand to submit the campaign.",
        };
      }

      // Persist the submitted body so the Messages page "Fix and resubmit"
      // action can pre-fill the wizard with what the owner sent last time,
      // instead of forcing them to retype everything after a rejection.
      try {
        const fs = await import("fs/promises");
        const path = await import("path");
        const file = path.join(process.cwd(), ".local", "a2p-last-submission.json");
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(
          file,
          JSON.stringify({ savedAt: new Date().toISOString(), body }, null, 2),
          "utf8",
        );
      } catch (persistErr) {
        console.warn("[a2p/register] failed to persist last submission:", (persistErr as Error)?.message);
      }

      // Kick the background monitor so any change Twilio reports is
      // pushed to the Messages page banner over SSE within seconds, plus
      // a short burst of follow-ups since Twilio reviews can land a few
      // minutes after a resubmit. The monitor de-dupes by fingerprint, so
      // a no-change cycle won't spam connected clients.
      try {
        const { runA2PMonitorOnce } = await import("../a2p-monitor");
        const kick = (delayMs: number) => {
          setTimeout(() => {
            runA2PMonitorOnce().catch((e) =>
              console.warn("[a2p/register] post-submit monitor run failed:", (e as Error)?.message),
            );
          }, delayMs).unref?.();
        };
        kick(0);
        kick(30_000);
        kick(2 * 60_000);
        kick(5 * 60_000);
      } catch (kickErr) {
        console.warn("[a2p/register] could not schedule post-submit monitor runs:", (kickErr as Error)?.message);
      }

      res.json(result);
    } catch (err: any) {
      console.error("[a2p/register] failed:", err);
      res.status(500).json({ error: err?.message || "registration failed", ...result });
    }
  });

  // Returns the most recent A2P registration submission so the wizard can
  // pre-fill itself for "Fix and resubmit". 404 when nothing has been
  // submitted yet — caller falls back to empty defaults.
  app.get("/api/twilio/a2p/prefill", async (_req, res) => {
    try {
      const fs = await import("fs/promises");
      const path = await import("path");
      const file = path.join(process.cwd(), ".local", "a2p-last-submission.json");
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as { savedAt?: string; body?: unknown };
      if (!parsed.body) {
        res.status(404).json({ error: "no prior submission" });
        return;
      }
      res.json({ savedAt: parsed.savedAt || null, body: parsed.body });
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        res.status(404).json({ error: "no prior submission" });
        return;
      }
      res.status(500).json({ error: err?.message || "failed to read prefill" });
    }
  });

  app.post("/api/twilio/test-sms", async (req, res) => {
    try {
      const { to, body } = req.body ?? {};
      if (!to || !body) {
        res.status(400).json({ error: "to and body required" });
        return;
      }
      const result = await sendSms(String(to), String(body));
      res.json({ success: true, ...result });
    } catch (err: any) {
      console.error("Test SMS failed:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // -------- Twilio Settings (admin) --------
  {
    const {
      getTwilioSettings,
      updateTwilioSettings,
      listVoicemails,
      getVoicemail,
      updateVoicemail,
      deleteVoicemail,
      listCallLog,
      getCallLogStats,
      deleteCallLog,
    } = await import("../twilio-settings-storage");
    const { updateTwilioSettingsSchema } = await import("@workspace/db");

    app.get("/api/twilio/settings", async (_req, res) => {
      try {
        const settings = await getTwilioSettings();
        res.json(settings);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    app.patch("/api/twilio/settings", async (req, res) => {
      try {
        const parsed = updateTwilioSettingsSchema.parse(req.body ?? {});
        if (parsed.smsForwardNumbers !== undefined && parsed.smsForwardNumbers !== null) {
          const { parseSmsForwardTargets } = await import("../sms-forward-outbox");
          const submitted = parsed.smsForwardNumbers
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
          const targets = parseSmsForwardTargets(parsed.smsForwardNumbers);
          if (submitted.length > 5) {
            res.status(400).json({ error: "SMS forwarding supports up to five numbers" });
            return;
          }
          if (targets.length !== submitted.length) {
            res.status(400).json({ error: "Forwarding numbers must be valid and unique" });
            return;
          }
          const businessNumber = String(parsed.twilioPhoneNumber || (await getTwilioSettings()).twilioPhoneNumber)
            .replace(/\D/g, "");
          if (targets.some((target) => target.replace(/\D/g, "") === businessNumber)) {
            res.status(400).json({ error: "The Twilio business number cannot receive its own forwards" });
            return;
          }
          parsed.smsForwardNumbers = targets.join(",");
          if (targets[0]) parsed.smsForwardToNumber = targets[0];
        }
        const settings = await updateTwilioSettings(parsed);
        res.json(settings);
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    });

    // ── Custom voicemail greeting audio (stored in Replit KV, played via <Play>) ──
    app.get("/api/twilio/voicemail-greeting/audio", async (_req, res) => {
      try {
        res.json(await getGreetingAudioInfo());
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    app.post(
      "/api/twilio/voicemail-greeting/audio",
      express.raw({ type: () => true, limit: "2mb" }),
      async (req, res) => {
        try {
          const buf = req.body as Buffer;
          if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
            res.status(400).json({ error: "No audio data received." });
            return;
          }
          // Greetings are short, so keep well under the key-value store's per-value
          // limit (base64 adds ~33% overhead): 1.5 MB of audio is roughly 3–4 minutes.
          if (buf.length > 1.5 * 1024 * 1024) {
            res.status(413).json({ error: "Audio file is too large. Please upload an MP3 or WAV under 1.5 MB (a short greeting is plenty)." });
            return;
          }
          const fileName = (req.headers["x-file-name"] || "").toString().slice(0, 120) || undefined;
          // Resolve a Twilio-playable content type; reject anything that isn't MP3/WAV.
          const ct = (req.headers["content-type"] || "").toString().toLowerCase().split(";")[0].trim();
          const mp3 = ["audio/mpeg", "audio/mp3"];
          const wav = ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"];
          let contentType = "";
          if (mp3.includes(ct)) contentType = "audio/mpeg";
          else if (wav.includes(ct)) contentType = "audio/wav";
          else if (ct === "application/octet-stream" || ct === "") {
            // Some browsers omit the type — fall back to the file extension.
            const name = (fileName || "").toLowerCase();
            if (name.endsWith(".mp3")) contentType = "audio/mpeg";
            else if (name.endsWith(".wav")) contentType = "audio/wav";
          }
          if (!contentType) {
            res.status(415).json({ error: "Unsupported file type. Please upload an MP3 or WAV audio file." });
            return;
          }
          await setGreetingAudio(buf, contentType, fileName);
          res.json(await getGreetingAudioInfo());
        } catch (err: any) {
          res.status(500).json({ error: err.message });
        }
      },
    );

    app.delete("/api/twilio/voicemail-greeting/audio", async (_req, res) => {
      try {
        await clearGreetingAudio();
        res.json(await getGreetingAudioInfo());
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    app.get("/api/twilio/voicemails", async (req, res) => {
      try {
        if (!(await canViewVoicemails(req))) {
          res.status(403).json({ message: "Voicemail access is disabled for this staff account" });
          return;
        }
        const unreadOnly = req.query.unread === "true";
        const list = await listVoicemails({ unreadOnly });
        res.json(list);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    app.patch("/api/twilio/voicemails/:id", async (req, res) => {
      try {
        if (!(await canViewVoicemails(req))) {
          res.status(403).json({ message: "Voicemail access is disabled for this staff account" });
          return;
        }
        const id = parseInt(req.params.id, 10);
        // Whitelist mutable fields — never accept arbitrary patches
        // (recordingUrl, callSid etc. must not be client-controllable).
        const safe: { listened?: boolean } = {};
        if (typeof req.body?.listened === "boolean") safe.listened = req.body.listened;
        const updated = await updateVoicemail(id, safe);
        if (!updated) {
          res.status(404).json({ error: "not found" });
          return;
        }
        res.json(updated);
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    });

    app.delete("/api/twilio/voicemails/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        const ok = await deleteVoicemail(id);
        res.json({ success: ok });
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    });

    // Stream a voicemail recording through our server (so Twilio HTTP basic-auth
    // is handled server-side and the browser can play it without credentials).
    // Hardened against SSRF: only api.twilio.com URLs are fetched.
    app.get("/api/twilio/voicemails/:id/audio", async (req, res) => {
      try {
        if (!(await canViewVoicemails(req))) {
          res.status(403).json({ message: "Voicemail access is disabled for this staff account" });
          return;
        }
        const id = parseInt(req.params.id, 10);
        const vm = await getVoicemail(id);
        if (!vm?.recordingUrl) {
          res.status(404).end();
          return;
        }

        const rawUrl = `${vm.recordingUrl}.mp3`;
        let parsed: URL;
        try { parsed = new URL(rawUrl); } catch { res.status(400).end(); return; }
        if (parsed.protocol !== "https:" || parsed.hostname !== "api.twilio.com") {
          res.status(400).end();
          return;
        }

        // Use the Twilio API key/secret from the Replit connector for Basic auth.
        const { getTwilioClient } = await import("../twilio");
        const client = await getTwilioClient();
        const apiKey = (client as any).username as string;
        const apiSecret = (client as any).password as string;
        if (!apiKey || !apiSecret) {
          console.error("voicemail audio: missing Twilio API key/secret on client");
          res.status(500).end();
          return;
        }
        const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");

        const resp = await fetch(parsed.toString(), { headers: { Authorization: `Basic ${auth}` } });
        if (!resp.ok || !resp.body) {
          console.error("voicemail audio: upstream", resp.status);
          // A 404 from Twilio means the recording captured no audio (status
          // "absent" — the caller hung up without leaving a message). Surface
          // that as 404, not 502, so the UI shows a clean "no audio" state
          // instead of looking like a broken server.
          res.status(resp.status === 404 ? 404 : 502).end();
          return;
        }
        res.setHeader("Content-Type", "audio/mpeg");
        const reader = resp.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
        if (!vm.listened) await updateVoicemail(id, { listened: true });
      } catch (err: any) {
        console.error("voicemail audio stream failed:", err);
        res.status(500).end();
      }
    });

    // -------- Call log --------
    app.get("/api/twilio/call-log", async (_req, res) => {
      try {
        const list = await listCallLog({ limit: 200 });
        res.json(list);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    app.get("/api/twilio/call-log/stats", async (_req, res) => {
      try {
        res.json(await getCallLogStats());
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    app.delete("/api/twilio/call-log/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        const ok = await deleteCallLog(id);
        res.json({ success: ok });
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    });

    // Sync the Twilio Console webhook URLs for the configured number to point
    // at this app's current public hostname. Useful when the Replit URL changes.
    app.post("/api/twilio/sync-webhooks", async (req, res) => {
      try {
        const settings = await getTwilioSettings();
        const configuredBase = canonicalPublicAppBaseUrl(process.env.APP_BASE_URL);
        if (!configuredBase.ok) {
          res.status(503).json({ error: configuredBase.error });
          return;
        }
        const base = configuredBase.origin;
        const { getTwilioClient } = await import("../twilio");
        const client = await getTwilioClient();
        const [num] = await client.incomingPhoneNumbers.list({
          phoneNumber: settings.twilioPhoneNumber,
          limit: 1,
        });
        if (!num) {
          res.status(404).json({ error: `Twilio number ${settings.twilioPhoneNumber} not found on this account` });
          return;
        }
        const updated = await client.incomingPhoneNumbers(num.sid).update({
          voiceUrl: `${base}/webhooks/voice/incoming`,
          voiceMethod: "POST",
          voiceFallbackUrl: `${base}/webhooks/voice/incoming`,
          statusCallback: `${base}/webhooks/voice/status`,
          statusCallbackMethod: "POST",
          smsUrl: `${base}/webhooks/sms/incoming`,
          smsMethod: "POST",
          smsFallbackUrl: `${base}/webhooks/sms/incoming`,
        });

        // Also point every provisioned call-tracking number at the same webhooks,
        // so one "Sync all numbers" action keeps the whole account in sync. SMS on
        // tracking numbers now routes to the unified /webhooks/sms/incoming handler.
        const { listTrackingNumbers } = await import("../twilio-tracking-storage");
        const trackingRows = await listTrackingNumbers();
        const tracking: any[] = [];
        for (const tn of trackingRows) {
          if (!tn.twilioSid) { tracking.push({ id: tn.id, phoneNumber: tn.phoneNumber, skipped: "no twilio sid" }); continue; }
          try {
            await client.incomingPhoneNumbers(tn.twilioSid).update({
              voiceUrl: `${base}/webhooks/voice/incoming`,
              voiceMethod: "POST",
              statusCallback: `${base}/webhooks/voice/status`,
              statusCallbackMethod: "POST",
              smsUrl: `${base}/webhooks/sms/incoming`,
              smsMethod: "POST",
            });
            tracking.push({ id: tn.id, phoneNumber: tn.phoneNumber, updated: true });
          } catch (e: any) {
            tracking.push({ id: tn.id, phoneNumber: tn.phoneNumber, error: e?.message || "update failed" });
          }
        }

        res.json({
          success: true,
          base,
          voiceUrl: updated.voiceUrl,
          smsUrl: updated.smsUrl,
          statusCallback: updated.statusCallback,
          main: { phoneNumber: settings.twilioPhoneNumber, updated: true },
          tracking,
        });
      } catch (err: any) {
        console.error("sync-webhooks failed:", err);
        res.status(500).json({ error: err.message });
      }
    });
  }

  // -------- Messaging (text customers directly) --------
  {
    const { listSmsConversations, listSmsMessages, createSmsMessage, deleteSmsMessage, deleteSmsConversation } =
      await import("../twilio-tracking-storage");

    // Conversation list (one row per counterparty number, latest message first)
    app.get("/api/sms/threads", async (_req, res) => {
      try {
        const threads = await listSmsConversations();

        // Enrich with CRM contact name when we can match on phone digits
        const contacts = await storage.getCrmContacts();
        const norm = (s: string) => (s || "").replace(/\D/g, "").replace(/^1/, "");
        const byPhone = new Map<string, { id: number; name: string }>();
        for (const c of contacts) {
          const name = (c.fullName ?? "").trim() || c.company || "";
          for (const p of [c.mobilePhone, c.officePhone].filter(Boolean) as string[]) {
            const k = norm(p);
            if (k && !byPhone.has(k)) byPhone.set(k, { id: c.id, name });
          }
        }

        const enriched = threads.map((t) => {
          const match = byPhone.get(norm(t.counterparty));
          return { ...t, contactId: match?.id ?? null, contactName: match?.name ?? null };
        });
        res.json(enriched);
      } catch (e: any) {
        console.error("GET /api/sms/threads failed:", e);
        res.status(500).json({ error: e?.message || "Failed to load threads" });
      }
    });

    // Full message history with one counterparty (oldest first for the UI)
    app.get("/api/sms/messages", async (req, res) => {
      try {
        const peer = String(req.query.peer || "");
        if (!peer) {
          res.status(400).json({ error: "peer query param required" });
          return;
        }
        const list = await listSmsMessages({ counterparty: peer, limit: 500 });
        res.json(list.slice().reverse());
      } catch (e: any) {
        console.error("GET /api/sms/messages failed:", e);
        res.status(500).json({ error: e?.message || "Failed to load messages" });
      }
    });

    // Send a text. When `from` is a provisioned call-tracking number, reply from
    // that number directly so the customer sees the line they contacted; otherwise
    // send from the main business line via sendSms (A2P messaging service),
    // which persists its own outbound row.
    // Shared inbox: owner, open/done, unread, notes, calls + voicemails per customer.
    registerSharedInboxRoutes(app);
    registerContactSmsRoutes(app, {
      sendSms,
      isTwilioConfigured,
      canSeeContact,
      canEditContact,
    });
    // Click-to-call: rings a configured staff forwarding phone, then bridges
    // to the customer from the business line once staff press 1.
    registerOutboundCallRoutes(app, {
      isTwilioConfigured,
      getFromNumber: getTwilioFromPhoneNumber,
      getAgentPhones: () => defaultAgentPhones(getTwilioSettings),
      createCall: async ({ to, from, twiml, statusCallback }) => {
        const client = await getTwilioClient();
        const call = await client.calls.create({ to, from, twiml, statusCallback, statusCallbackEvent: ["completed"] });
        return { sid: call.sid, status: call.status };
      },
      recordCall: upsertCallLog,
      canSeeContact,
      canEditContact,
    });
    registerBrowserVoiceRoutes(app, {
      getFromNumber: getTwilioFromPhoneNumber,
      getContacts: () => storage.getCrmContacts(),
      canSeeContact,
      canEditContact,
      recordCall: upsertCallLog,
    });
    if (false) {
    app.post("/api/sms/send", async (req, res) => {
      try {
        const { to, body, from } = req.body ?? {};
        if (!to || !body) {
          res.status(400).json({ error: "to and body are required" });
          return;
        }

        const targetNumber = toValidE164(String(to));
        if (!targetNumber) {
          res.status(400).json({
            error: "Destination phone number must be a valid E.164 number",
          });
          return;
        }
        const contacts = await storage.getCrmContacts();
        const matchingContacts = contacts.filter((contact) =>
          [contact.mobilePhone, contact.officePhone]
            .filter((phone): phone is string => Boolean(phone?.trim()))
            .some((phone) => toE164(phone) === targetNumber)
        );
        const scope = await getStaffAssignmentScope(req);
        if (matchingContacts.some((contact) => !canSeeContact(scope, contact.id))) {
          res.status(404).json({ error: "Contact not found" });
          return;
        }
        if (matchingContacts.some((contact) => !canEditContact(scope, contact.id))) {
          res.status(403).json({ error: "Contact edit assignment required" });
          return;
        }
        // Explicit unlinked-number policy: approved staff may text numbers that
        // do not resolve to CRM contacts. Pending and suspended staff may not.
        if (matchingContacts.length === 0 && (await getStaffAccess(req)).approvalStatus !== "approved") {
          res.status(403).json({ error: "Approved staff access required" });
          return;
        }
        if (!isTwilioConfigured()) {
          res.status(400).json({ error: "Twilio is not configured" });
          return;
        }

        const fromNum = from ? String(from).trim() : "";
        if (fromNum && fromNum !== "default") {
          const { getTrackingNumberByPhone } = await import("../twilio-tracking-storage");
          const tn = await getTrackingNumberByPhone(fromNum);
          if (tn) {
            // Reply from the tracking number the customer texted.
            const { getTwilioClient, toE164 } = await import("../twilio");
            const client = await getTwilioClient();
            const msg = await client.messages.create({ to: targetNumber, from: tn.phoneNumber, body: String(body) });
            await createSmsMessage({
              messageSid: msg.sid, fromNumber: tn.phoneNumber, toNumber: targetNumber,
              body: String(body), direction: "outbound", status: msg.status || "sent", trackingNumberId: tn.id,
            } as any).catch(() => {});
            await mirrorStaffSmsToForwardingPhones({
              messageSid: msg.sid,
              customerNumber: String(to),
              businessNumber: msg.from || tn.phoneNumber,
              body: String(body),
            }).catch((error) => {
              console.error("[sms-mirror] failed to queue tracking-number reply:", error);
            });
            res.json({ success: true, sid: msg.sid, to: msg.to, from: msg.from, status: msg.status });
            return;
          }
        }

        const result = await sendSms(targetNumber, String(body));
        await mirrorStaffSmsToForwardingPhones({
          messageSid: result.sid,
          customerNumber: String(to),
          businessNumber: result.from || "",
          body: String(body),
        }).catch((error) => {
          console.error("[sms-mirror] failed to queue staff reply:", error);
        });
        res.json({ success: true, ...result });
      } catch (e: any) {
        console.error("POST /api/sms/send failed:", e);
        res.status(500).json({ success: false, error: e?.message || "Send failed" });
      }
    });

    app.get("/api/sms/bulk-recipients", async (req, res) => {
      try {
        const messageClass = String(req.query.messageClass || "service") as SmsMessageClass;
        if (!["service", "marketing"].includes(messageClass)) {
          res.status(400).json({ error: "messageClass must be service or marketing" });
          return;
        }
        const scope = await getStaffAssignmentScope(req);
        const contacts = (await storage.getCrmContacts()).filter((contact) => canSeeContact(scope, contact.id));
        const recipients = await Promise.all(contacts.map(async (contact) => {
          const mobilePhone = contact.mobilePhone?.trim() || null;
          if (!mobilePhone) {
            return {
              contactId: contact.id,
              name: contact.fullName || contact.company || `Contact ${contact.id}`,
              mobilePhone: null,
              eligible: false,
              reason: "No mobile number",
            };
          }
          const consent = await getSmsConsentEligibility(mobilePhone, contact.id, messageClass);
          return {
            contactId: contact.id,
            name: contact.fullName || contact.company || `Contact ${contact.id}`,
            mobilePhone,
            ...consent,
          };
        }));
        res.json(recipients);
      } catch (e: any) {
        console.error("GET /api/sms/bulk-recipients failed:", e);
        res.status(500).json({ error: e?.message || "Failed to load recipients" });
      }
    });

    app.post("/api/sms/bulk-send", async (req, res) => {
      try {
        const messageClass = String(req.body?.messageClass || "") as SmsMessageClass;
        const body = String(req.body?.body || "").trim();
        const rawIds = Array.isArray(req.body?.contactIds) ? req.body.contactIds : [];
        const contactIds = [...new Set(rawIds.map(Number).filter(Number.isSafeInteger))];
        if (!["service", "marketing"].includes(messageClass)) {
          res.status(400).json({ error: "messageClass must be service or marketing" });
          return;
        }
        if (!body) {
          res.status(400).json({ error: "Message body is required" });
          return;
        }
        if (body.length > 1600) {
          res.status(400).json({ error: "Message body is too long" });
          return;
        }
        if (!contactIds.length) {
          res.status(400).json({ error: "Select at least one contact" });
          return;
        }
        if (contactIds.length > 100) {
          res.status(400).json({ error: "Bulk sends are limited to 100 contacts" });
          return;
        }
        if (!isTwilioConfigured()) {
          res.status(400).json({ error: "Twilio is not configured" });
          return;
        }

        const results: Array<Record<string, unknown>> = [];
        const deliveredPhones = new Set<string>();
        const scope = await getStaffAssignmentScope(req);
        for (const contactId of contactIds) {
          const contact = await storage.getCrmContact(contactId);
          if (!contact || !canSeeContact(scope, contactId)) {
            results.push({ contactId, status: "skipped", reason: "Contact not found" });
            continue;
          }
          if (!canEditContact(scope, contactId)) {
            results.push({ contactId, status: "skipped", reason: "Contact edit assignment required" });
            continue;
          }
          const mobilePhone = contact?.mobilePhone?.trim();
          if (!contact || !mobilePhone) {
            results.push({ contactId, status: "skipped", reason: "Contact has no mobile number" });
            continue;
          }
          const normalized = toValidE164(mobilePhone);
          if (!normalized) {
            results.push({
              contactId,
              status: "skipped",
              reason: "Contact has an invalid mobile number",
            });
            continue;
          }
          if (deliveredPhones.has(normalized)) {
            results.push({ contactId, status: "skipped", reason: "Duplicate mobile number" });
            continue;
          }
          const consent = await getSmsConsentEligibility(mobilePhone, contact.id, messageClass);
          if (!consent.eligible) {
            results.push({ contactId, status: "skipped", reason: consent.reason });
            continue;
          }
          try {
            const sent = await sendSms(normalized, body);
            deliveredPhones.add(normalized);
            await mirrorStaffSmsToForwardingPhones({
              messageSid: sent.sid,
              customerNumber: normalized,
              businessNumber: sent.from || "",
              body,
            }).catch((error) => console.error("[sms-mirror] failed to queue bulk text:", error));
            results.push({ contactId, status: "sent", sid: sent.sid });
          } catch (error: any) {
            results.push({ contactId, status: "failed", reason: error?.message || "Send failed" });
          }
        }
        res.json({
          success: true,
          sent: results.filter((result) => result.status === "sent").length,
          skipped: results.filter((result) => result.status === "skipped").length,
          failed: results.filter((result) => result.status === "failed").length,
          results,
        });
      } catch (e: any) {
        console.error("POST /api/sms/bulk-send failed:", e);
        res.status(500).json({ success: false, error: e?.message || "Bulk send failed" });
      }
    });

    }
    // Delete a whole conversation (all messages with one counterparty)
    app.delete("/api/sms/threads/:peer", async (req, res) => {
      try {
        const peer = String(req.params.peer || "");
        if (!peer) {
          res.status(400).json({ error: "peer is required" });
          return;
        }
        const count = await deleteSmsConversation(peer);
        res.json({ success: true, deleted: count });
      } catch (e: any) {
        console.error("DELETE /api/sms/threads failed:", e);
        res.status(500).json({ error: e?.message || "Failed to delete conversation" });
      }
    });

    // Delete a single message by id
    app.delete("/api/sms/messages/:id", async (req, res) => {
      try {
        const id = parseInt(req.params.id);
        if (Number.isNaN(id)) {
          res.status(400).json({ error: "Invalid message id" });
          return;
        }
        const deleted = await deleteSmsMessage(id);
        if (!deleted) {
          res.status(404).json({ error: "Message not found" });
          return;
        }
        res.json({ success: true });
      } catch (e: any) {
        console.error("DELETE /api/sms/messages failed:", e);
        res.status(500).json({ error: e?.message || "Failed to delete message" });
      }
    });
  }

  // Booking platform — service catalog, availability, slot locks, appointments
  registerBookingRoutes(app);
  registerStaffMeetingRoutes(app);
  registerCommunicationEmailRoutes(app, { canSeeContact });
  registerStaffCalendarRoutes(app);
  if (!options.disableBackgroundServices) startSlotLockSweeper();

  // A2P 10DLC background monitor — proactively alerts the account owner when
  // brand/campaign registration transitions to rejected/failed so outbound
  // texts don't silently fail with carrier error 30034.
  if (!options.disableBackgroundServices) {
    const { startA2PMonitor } = await import("../a2p-monitor");
    startA2PMonitor();
    seedBookingDefaults()
      .then(r => console.log(`[booking] seed complete: ${r.serviceCount} new services, resource #${r.resourceId}`))
      .catch(err => console.error("[booking] seed failed:", err));
  }

  // Keep the local device list in sync with the MeshCentral server. Runs once
  // shortly after startup and then on an interval. No-ops when not configured.
  if (!options.disableBackgroundServices && meshCentralService.isConfigured()) {
    // Self-scheduling sync with exponential backoff. On success we poll at the
    // base interval; on failure we back off (up to a cap) instead of retrying
    // every minute. This matters because repeated failed logins trip
    // MeshCentral's invalid-login IP throttle — a fixed 60s retry would keep the
    // server's IP permanently blocked and never let the cooldown expire.
    const BASE_INTERVAL = 60_000;
    const MAX_INTERVAL = 15 * 60_000;
    let delay = BASE_INTERVAL;
    const runSync = async () => {
      try {
        const r = await meshCentralService.syncDevices();
        if (r.error) {
          console.warn("[meshcentral] device sync error:", r.error);
          delay = Math.min(delay * 2, MAX_INTERVAL);
        } else {
          console.log(`[meshcentral] device sync: ${r.synced} machine(s)`);
          delay = BASE_INTERVAL;
        }
      } catch (err) {
        console.error("[meshcentral] device sync failed:", err);
        delay = Math.min(delay * 2, MAX_INTERVAL);
      } finally {
        setTimeout(runSync, delay);
      }
    };
    setTimeout(runSync, 10_000);
  }

  const httpServer = createServer(app);
  return httpServer;
}
