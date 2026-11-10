import express, { type Request, Response, NextFunction } from "express";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { registerRoutes } from "./routes/routes";
import { assertRequiredSecrets, isAdminEmail, isAdminUser, requiredFeatureForApiPath } from "./security";
import { requireAuth } from "./middlewares/clerkAuth";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import { registerTwilioForwarding } from "./twilio-forwarding";
import { registerIncomingCallAlerts } from "./incoming-call-alerts";
import { startSmsForwardOutboxWorker } from "./sms-forward-outbox";
import { startSlackNotificationOutboxWorker } from "./slack-outbox";
import { sendSlackMessage } from "./slack";
import { twilioWebhookSignatureBoundary } from "./twilio-webhook-security";
import { registerTwilioTracking } from "./twilio-tracking";
import { setupPttServer } from "./ptt";
import { logger } from "./lib/logger";
import { WebhookHandlers } from "./webhookHandlers";
import type Stripe from "stripe";
import { isStripeConfigured, getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { applyBillingMigration } from "./migrations/2026-05-13-billing";
import { applyTeamviewerMigration } from "./migrations/2026-05-13-teamviewer";
import { applyHelpdeskMigration } from "./migrations/2026-05-14-helpdesk";
import { applyA2pRejectionSuggestionsMigration } from "./migrations/2026-05-23-a2p-rejection-suggestions";
import { applyPatchMgmtMigration } from "./migrations/2026-06-09-patch-mgmt";
import { applySmsErrorCodeMigration } from "./migrations/2026-06-17-sms-error-code";
import { applySmsForwardingMigration } from "./migrations/2026-09-07-sms-forwarding";
import { applyBookingEngineMigration } from "./migrations/2026-07-04-booking-engine";
import { applyBackupForwardNumberMigration } from "./migrations/2026-07-08-backup-forward-number";
import { applyCrmPipelineMigration } from "./migrations/2026-07-16-crm-pipeline";
import { handleInvoiceStripeWebhookEvent } from "./invoice-routes";
import { handleCatalogStripeWebhookEvent, startCatalogReconciliationWorker } from "./catalog";
import { missingCatalogWebhookEvents } from "./catalog-webhook-events";
import { applyCustomerLinkMigration } from "./customer-links";
import { applyIntakeIdempotencyMigration } from "./migrations/2026-07-17-intake-idempotency";
import { applyPttTelemetryMigration } from "./migrations/2026-09-06-ptt-telemetry";
import { applyStaffClientMessagesMigration } from "./migrations/2026-09-06-staff-client-messages";
import { startStaffClientMessageHistoryWorker } from "./staff-dispatch";
import { applyCallSupportTicketMigration } from "./migrations/2026-09-07-call-support-ticket";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { applyServiceContractsMigration } from "./migrations/2026-09-08-service-contracts";
import { applyEmailCapacityAlertMigration } from "./migrations/2026-09-14-email-capacity-alert";
import { applyEmailCapacitySettingsMigration } from "./migrations/2026-09-14-email-capacity-settings";
import { applyMarketplaceMigration } from "./migrations/2026-09-16-marketplace";
import { applySharedRateLimitsMigration } from "./migrations/2026-09-16-shared-rate-limits";
import { applyCatalogMigration } from "./migrations/2026-09-28-catalog";
import { applyCustomerPhotosMigration } from "./migrations/2026-10-22-customer-photos";
import { applyStaffAvatarsMigration } from "./migrations/2026-11-06-staff-avatars";
import { registerStaffProfileRoutes } from "./staff-profile";
import { applyStaffBusinessCardsMigration } from "./migrations/2026-11-06-staff-business-cards";
import { registerStaffBusinessCardRoutes } from "./staff-business-card";
import { applyPttPagesMigration } from "./migrations/2026-11-06-ptt-pages";
import { registerPttPageRoutes } from "./ptt-pages";
import { applySalesAgentsMigration } from "./migrations/2026-11-10-sales-agents";
import { registerLeadGenRoutes } from "./lead-gen-agent";
import { registerSpeedToLeadRoutes, startSpeedToLeadWorker } from "./speed-to-lead";
import { registerLeadResearchRoutes } from "./lead-research";
import { registerExecutiveAssistantRoutes } from "./executive-assistant";
import { applySlackDeliveryHealthMigration } from "./migrations/2026-09-22-slack-delivery-health";
import { applySlackNotificationOutboxMigration } from "./migrations/2026-09-27-slack-notification-outbox";
import { applyStaffInvitesMigration } from "./migrations/2026-09-23-staff-invites";
import { applyCallForwardingOutcomesMigration } from "./migrations/2026-10-26-call-forwarding-outcomes";
import { applyCommunicationEmailMigration } from "./migrations/2026-10-27-communication-email";
import { canAccessFeature, enforceAssignedResourceBoundary, getStaffAccess, registerStaffAccessRoutes } from "./staff-access";
import { registerStaffInviteDeliveryWebhook, registerStaffInviteRoutes } from "./staff-invites";
import { registerStaffContactProfileRoutes } from "./staff-contact-profile";
import { requireStaffAdministrator } from "./staff-access";
import { registerStaffAccountDeletionRoutes } from "./staff-account-deletion";
import { apiAuthenticationBoundary } from "./api-auth-boundary";
import { registerReadinessRoutes } from "./readiness";
import { pool } from "./db";

import { applyCallForwardingStaffOutcomesMigration } from "./migrations/2026-10-27-call-forwarding-staff-outcomes";
import { applySharedInboxMigration } from "./migrations/2026-10-30-shared-inbox";
import { applyReferralsMigration } from "./migrations/2026-10-30-referrals";
import { applyVouchersMigration } from "./migrations/2026-11-10-vouchers";
import { applyOutboundCallOutcomesMigration } from "./migrations/2026-11-06-outbound-call-outcomes";
import { applyLocalWebsiteIntelligenceMigration } from "./local-website-intelligence";

const log = (message: string) => logger.info(message);

const app = express();

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

// Security headers. The "no-sniff" and referrer policies are safe everywhere;
// HSTS, frame protection, and CSP are applied ONLY in production so they don't
// break the Replit dev preview (which loads the app inside a cross-origin iframe)
// or pin HSTS on the shared *.replit.dev domain.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  if (app.get("env") === "production") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload"
    );

    if (req.path === "/embed" || req.path === "/embed/") {
      // The embed page is meant to be iframed by our own marketing site only.
      res.setHeader(
        "Content-Security-Policy",
        "frame-ancestors 'self' https://computersystemsdepot.com https://*.computersystemsdepot.com"
      );
    } else {
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      res.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' https://replit.com https://*.clerk.com https://*.clerk.accounts.dev https://challenges.cloudflare.com",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: https:",
          "font-src 'self' data:",
          "connect-src 'self' https: wss:",
          "frame-src 'self' https://*.clerk.com https://*.clerk.accounts.dev https://challenges.cloudflare.com",
          "frame-ancestors 'self'",
          "base-uri 'self'",
          "form-action 'self'",
          "object-src 'none'",
        ].join("; ")
      );
    }
  }

  next();
});

// Stripe webhook MUST be registered before express.json() so the raw body is available.
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) {
      res.status(400).json({ error: "Missing stripe-signature" });
      return;
    }
    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      // stripe-replit-sync has verified the signature and processed its own
      // sync before this invoice-specific finality hook runs.
      const event = JSON.parse(req.body.toString("utf8"));
      await handleInvoiceStripeWebhookEvent(event);
      await handleCatalogStripeWebhookEvent(event);
      res.status(200).json({ received: true });
      return;
    } catch (error: any) {
      console.error("Stripe webhook error:", error?.message ?? error);
      res.status(400).json({ error: "Webhook processing error" });
      return;
    }
  }
);

registerStaffInviteDeliveryWebhook(app);

// Multi-camera ARIA commands carry base64 JPEG frames, so this path needs a
// larger body limit than the default parser allows.
app.use("/api/aria/agent-command", express.json({ limit: "20mb" }));
app.use("/api/paypal-import", express.json({ limit: "8mb" }));
app.use("/api/contact-import", express.json({ limit: "8mb" }));
// Marketplace listings carry up to 8 base64 photos (each capped at 1.5 MB server-side).
app.use(["/api/portal/marketplace", "/api/marketplace"], express.json({ limit: "16mb" }));
// Intake and the customer avatar carry one base64 device photo (≤1 MB server-side).
app.use(["/api/intake", "/api/clients/:id/avatar", "/api/staff-profile/me/avatar"], express.json({ limit: "2mb" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
    const path = req.path.toLowerCase();
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      // Invite creation returns a single-use bearer link. Never put it in logs.
      if (capturedJsonResponse && path !== "/api/staff-access/invites" && !path.startsWith("/api/aria")) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

async function initStripe() {
  try {
    if (!(await isStripeConfigured())) {
      log("Stripe integration not connected; skipping initialization.");
      return;
    }
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      log("DATABASE_URL not set; skipping Stripe initialization.");
      return;
    }
    const { runMigrations } = await import("stripe-replit-sync");
    await runMigrations({ databaseUrl });
    const stripeSync = await getStripeSync();
    const webhookBaseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;
    if (process.env.REPLIT_DOMAINS) {
      try {
        const webhook = await stripeSync.findOrCreateManagedWebhook(`${webhookBaseUrl}/api/stripe/webhook`);
        const missing = missingCatalogWebhookEvents(webhook.enabled_events);
        if (missing.length) {
          const stripe = await getUncachableStripeClient();
          await stripe.webhookEndpoints.update(webhook.id, {
            enabled_events: [...new Set([...webhook.enabled_events, ...missing])] as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
          });
          logger.info({ eventCount: missing.length }, "Enabled missing catalog webhook events");
        }
      } catch (err: any) {
        logger.warn(
          { errorType: err?.type ?? "unknown", statusCode: err?.statusCode },
          "Stripe webhook setup warning; catalog purchase reconciliation remains active",
        );
      }
    }
    (async () => {
      try {
        await stripeSync.syncBackfill();
      } catch (err: any) {
        console.error("Stripe syncBackfill error:", err?.message ?? err);
      }
      // Explicitly sync the entities the Billing page needs, in case the
      // backfill above silently skipped them.
      try {
        await stripeSync.syncProducts();
        await stripeSync.syncPrices();
      } catch (err: any) {
        console.error("Stripe products/prices sync error:", err?.message ?? err);
      }
    })();
    log("Stripe initialized.");
  } catch (err: any) {
    console.error("Stripe initialization failed:", err?.message ?? err);
  }
}

(async () => {
  // Fail fast at boot if a secret the app cannot run without is missing.
  assertRequiredSecrets();
  const readinessSmokeTest = process.argv.includes("--readiness-smoke-test");

  // This is authorization data, not a second identity source. It lets the
  // browser hide admin-only navigation while ADMIN_EMAILS remains enforced from
  // verified Clerk session claims on every protected server route.
  app.get("/api/auth/access", requireAuth, (req, res) => {
    void getStaffAccess(req)
      .then((access) => res.json({ isAdmin: isAdminUser(req), ...access }))
      .catch((error) => res.status(500).json({ message: error?.message || "Could not load access" }));
  });

  registerReadinessRoutes(app, {
    critical: readinessSmokeTest
      ? [async () => {}]
      : [async () => {
          await pool.query("SELECT 1");
        }],
  });

  // The production-bundle smoke test exercises the real entrypoint, middleware,
  // readiness route registration, and listener without touching a database or
  // running migrations. It is enabled only by an explicit local CLI argument.
  if (readinessSmokeTest) {
    const port = parseInt(process.env.PORT || "5000", 10);
    app.listen({ port, host: "0.0.0.0", reusePort: true }, () => {
      log(`serving on port ${port}`);
    });
    return;
  }

  // Global API auth gate. Clerk validates the signed browser cookie above;
  // requireAuth resolves/JIT-provisions the matching auth_users record.
  app.use(apiAuthenticationBoundary);
  app.use(enforceAssignedResourceBoundary);

  // All present and future Twilio POST callbacks inherit signature verification.
  // Public GET resources under /webhooks (such as greeting audio) remain available.
  app.use("/webhooks", twilioWebhookSignatureBoundary);
  registerTwilioForwarding(app);
  registerIncomingCallAlerts(app);
  registerTwilioTracking(app);
  try {
    await applyBillingMigration();
  } catch (err: any) {
    console.error("Billing migration failed:", err?.message ?? err);
  }
  try {
    await applyTeamviewerMigration();
  } catch (err: any) {
    console.error("TeamViewer migration failed:", err?.message ?? err);
  }
  try {
    await applyHelpdeskMigration();
  } catch (err: any) {
    console.error("Helpdesk migration failed:", err?.message ?? err);
  }
  try {
    await applyA2pRejectionSuggestionsMigration();
  } catch (err: any) {
    console.error("A2P rejection suggestions migration failed:", err?.message ?? err);
  }
  try {
    await applyPatchMgmtMigration();
  } catch (err: any) {
    console.error("Patch management migration failed:", err?.message ?? err);
  }
  try {
    await applySmsErrorCodeMigration();
  } catch (err: any) {
    console.error("SMS error_code migration failed:", err?.message ?? err);
  }
  try {
    await applySmsForwardingMigration();
    startSmsForwardOutboxWorker();
  } catch (err: any) {
    logger.warn({ error: err }, "SMS forwarding migration failed; outbox worker not started");
  }
  try {
    await applyBookingEngineMigration();
  } catch (err: any) {
    console.error("Booking engine migration failed:", err?.message ?? err);
  }
  try {
    await applyBackupForwardNumberMigration();
  } catch (err: any) {
    console.error("Backup forward number migration failed:", err?.message ?? err);
  }
  try {
    await applyCrmPipelineMigration();
    await applyIntakeIdempotencyMigration();
  } catch (err: any) {
    console.error("CRM pipeline migration failed:", err?.message ?? err);
  }
  try {
    await applyCustomerPhotosMigration();
  } catch (err: any) {
    logger.error({ error: err }, "Customer photos migration failed");
  }
  try {
    await applyStaffAvatarsMigration();
  } catch (err: any) {
    logger.error({ error: err }, "Staff avatars migration failed");
  }
  try {
    await applyStaffBusinessCardsMigration();
  } catch (err: any) {
    logger.error({ error: err }, "Staff business cards migration failed");
  }
  try {
    await applyPttPagesMigration();
  } catch (err: any) {
    logger.error({ error: err }, "PTT pages migration failed");
  }
  try {
    await applyCustomerLinkMigration();
  } catch (err: any) {
    logger.warn({ error: err }, "Customer link migration skipped");
  }
  try {
    await applyPttTelemetryMigration();
  } catch (err: any) {
    logger.warn({ error: err }, "PTT telemetry migration skipped");
  }
  try {
    await applyMarketplaceMigration();
  } catch (err: any) {
    logger.warn({ error: err }, "Marketplace migration skipped");
  }
  try {
    await applyCatalogMigration();
  } catch (err: any) {
    logger.error({ error: err }, "Catalog migration failed");
  }
  try {
    await applyCommunicationEmailMigration();
  } catch (err: any) {
    logger.error({ error: err }, "Communication email audit migration failed");
  }
  try {
    await applyStaffClientMessagesMigration();
    await applyCallSupportTicketMigration();
    await applyStaffAccessMigration();
    await applyServiceContractsMigration();
    await applyEmailCapacityAlertMigration();
    await applyEmailCapacitySettingsMigration();
    await applySharedRateLimitsMigration();
    await applySlackDeliveryHealthMigration();
    startStaffClientMessageHistoryWorker((error) =>
      logger.warn({ error }, "Staff client message history worker failed"),
    );
  } catch (err: any) {
    logger.warn({ error: err }, "Staff client message migration skipped");
  }
  try {
    await applySlackNotificationOutboxMigration();
    startSlackNotificationOutboxWorker(sendSlackMessage);
  } catch {
    logger.error("Slack notification outbox migration failed; worker not started");
  }
  try {
    await applyStaffInvitesMigration();
  } catch (err: any) {
    logger.warn({ error: err }, "Staff invitation migration skipped");
  }
  try {
    await applyCallForwardingOutcomesMigration();
    await applyCallForwardingStaffOutcomesMigration();
  } catch (err: any) {
    logger.error({ error: err }, "Call forwarding outcomes migration failed");
  }
  try {
    await applySharedInboxMigration();
  } catch (err: any) {
    logger.error({ error: err }, "Shared inbox migration failed");
  }
  try {
    await applyReferralsMigration();
  } catch (err: any) {
    logger.error({ error: err }, "Referrals migration failed");
  }
  try {
    await applyVouchersMigration();
  } catch (err: any) {
    logger.error({ error: err }, "Vouchers migration failed");
  }
  try {
    await applyOutboundCallOutcomesMigration();
  } catch (err: any) {
    logger.error({ error: err }, "Outbound call outcomes migration failed");
  }
  try {
    await applyLocalWebsiteIntelligenceMigration();
  } catch (err: any) {
    logger.error({ error: err }, "Local website intelligence migration failed");
  }
  try {
    await applySalesAgentsMigration();
    startSpeedToLeadWorker();
  } catch (err: any) {
    logger.error({ error: err }, "Sales agents migration failed; Speed to Lead worker not started");
  }
  await initStripe();
  startCatalogReconciliationWorker();
  registerStaffAccessRoutes(app);
  registerStaffProfileRoutes(app);
  registerStaffBusinessCardRoutes(app);
  registerPttPageRoutes(app);
  registerLeadGenRoutes(app);
  registerSpeedToLeadRoutes(app);
  registerLeadResearchRoutes(app);
  registerExecutiveAssistantRoutes(app);
  registerStaffContactProfileRoutes(app, requireStaffAdministrator, { isOwnerEmail: isAdminEmail });
  registerStaffInviteRoutes(app);
  registerStaffAccountDeletionRoutes(app);
  const server = await registerRoutes(app);
  setupPttServer(server);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });
})();
