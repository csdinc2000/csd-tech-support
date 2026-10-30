import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupAuth, registerAuthRoutes } from "./replit_integrations/auth";
import { assertRequiredSecrets, isAdminUser, isAdminApiPath } from "./security";
import { registerTwilioForwarding } from "./twilio-forwarding";
import { registerTwilioTracking } from "./twilio-tracking";
import { setupPttServer } from "./ptt";
import { setupVite, serveStatic, log } from "./vite";
import { WebhookHandlers } from "./webhookHandlers";
import { isStripeConfigured, getStripeSync } from "./stripeClient";
import { applyBillingMigration } from "./migrations/2026-05-13-billing";
import { applyTeamviewerMigration } from "./migrations/2026-05-13-teamviewer";
import { applyHelpdeskMigration } from "./migrations/2026-05-14-helpdesk";
import { applyA2pRejectionSuggestionsMigration } from "./migrations/2026-05-23-a2p-rejection-suggestions";
import { applyPatchMgmtMigration } from "./migrations/2026-06-09-patch-mgmt";
import { applySmsErrorCodeMigration } from "./migrations/2026-06-17-sms-error-code";
import { applyBookingEngineMigration } from "./migrations/2026-07-04-booking-engine";
import { applyBackupForwardNumberMigration } from "./migrations/2026-07-08-backup-forward-number";
import { applyCrmPipelineMigration } from "./migrations/2026-07-16-crm-pipeline";
import { handleInvoiceStripeWebhookEvent } from "./invoice-routes";

const app = express();

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
          "script-src 'self' 'unsafe-inline' https://replit.com",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: https:",
          "font-src 'self' data:",
          "connect-src 'self' https: wss:",
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
      return res.status(400).json({ error: "Missing stripe-signature" });
    }
    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      // stripe-replit-sync has verified the signature and processed its own
      // sync before this invoice-specific finality hook runs.
      await handleInvoiceStripeWebhookEvent(JSON.parse(req.body.toString("utf8")));
      res.status(200).json({ received: true });
    } catch (error: any) {
      console.error("Stripe webhook error:", error?.message ?? error);
      res.status(400).json({ error: "Webhook processing error" });
    }
  }
);

// Multi-camera ARIA commands carry base64 JPEG frames, so this path needs a
// larger body limit than the default parser allows.
app.use("/api/aria/agent-command", express.json({ limit: "20mb" }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
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
      if (capturedJsonResponse) {
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
        await stripeSync.findOrCreateManagedWebhook(`${webhookBaseUrl}/api/stripe/webhook`);
      } catch (err: any) {
        console.warn("Stripe webhook setup warning:", err?.message ?? err);
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

// Paths under /api that stay reachable WITHOUT a logged-in session. Some are
// method-specific: a path can be public for one verb but admin for another
// (e.g. POST /api/intake is the public web form, GET /api/intake is the admin list).
function isPublicApiRequest(method: string, path: string): boolean {
  if (path === "/api/health") return true;
  if (
    (method === "GET" && /^\/api\/public\/invoices\/[^/]+$/.test(path)) ||
    (method === "POST" && /^\/api\/public\/invoices\/[^/]+\/create-stripe-checkout$/.test(path))
  )
    return true;
  if (path === "/api/google/callback") return true; // Google OAuth redirect target
  if (method === "POST" && path === "/api/intake") return true; // public service intake form
  if (method === "POST" && path === "/api/support/redeem-code") return true; // customer joins a remote session
  // Customer booking flow — enumerated per method+path (NOT a prefix wildcard)
  // so new internal booking endpoints are auth-gated by default.
  // Legacy booking module (used by the live intake form):
  if (
    method === "GET" &&
    (path === "/api/booking/categories" ||
      path === "/api/booking/services" ||
      /^\/api\/booking\/services\/[^/]+$/.test(path) ||
      path === "/api/booking/availability" ||
      /^\/api\/booking\/appointments\/[^/]+$/.test(path))
  )
    return true;
  if (method === "POST" && (path === "/api/booking/locks" || path === "/api/booking/appointments"))
    return true;
  if (method === "DELETE" && /^\/api\/booking\/locks\/[^/]+$/.test(path)) return true;
  // Booking engine v2 public surface (holds/confirm flow; everything else
  // under /api/booking/v2 — PATCH appointments, admin CRUD — requires a session):
  if (
    method === "GET" &&
    (path === "/api/booking/v2/services" || path === "/api/booking/v2/availability")
  )
    return true;
  if (
    method === "POST" &&
    (path === "/api/booking/v2/holds" || /^\/api\/booking\/v2\/holds\/[^/]+\/confirm$/.test(path))
  )
    return true;
  if (path === "/api/portal" || path.startsWith("/api/portal/")) return true; // customer ticket portal
  if (method === "GET" && path.startsWith("/api/download/")) return true; // customer remote-support agent download
  if (method === "POST" && path === "/api/aria/support-chat") return true; // public website support chatbot
  return false;
}

(async () => {
  // Fail fast at boot if a secret the app cannot run without is missing.
  assertRequiredSecrets();

  // Initialize auth/session FIRST so the API auth gate below can read the
  // session and every downstream route (including the Twilio /api/* admin
  // routes registered next) sits behind it.
  await setupAuth(app);
  registerAuthRoutes(app);

  // Global API auth gate. Everything under /api requires a valid session except
  // the explicit public allowlist above. Public auth routes (/api/login,
  // /api/callback, /api/logout, /api/auth/user) and the Stripe webhook are
  // registered before this point, so requests reach them before the gate runs.
  app.use((req, res, next) => {
    // Express routing is case-insensitive by default, so a request to
    // "/API/..." reaches the same handler as "/api/...". Normalize the path to
    // lower case before every gate check, otherwise a differently-cased prefix
    // would slip past this middleware entirely (skipping both the session check
    // and the admin check) while still matching the real route.
    const path = req.path.toLowerCase();
    if (!path.startsWith("/api")) return next();
    if (isPublicApiRequest(req.method, path)) return next();
    const authed =
      typeof (req as any).isAuthenticated === "function" && (req as any).isAuthenticated();
    if (!authed) return res.status(401).json({ message: "Authentication required" });

    // Admin route groups (mesh, billing, call-tracking, twilio settings) need an
    // admin user on top of a valid session.
    if (isAdminApiPath(path, req.method) && !isAdminUser(req)) {
      return res.status(403).json({ message: "Admin access required" });
    }

    return next();
  });

  registerTwilioForwarding(app);
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
  } catch (err: any) {
    console.error("CRM pipeline migration failed:", err?.message ?? err);
  }
  await initStripe();
  const server = await registerRoutes(app);
  setupPttServer(server);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

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
