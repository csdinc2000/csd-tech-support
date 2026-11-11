import express, { type Request, Response, NextFunction } from "express";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { assertRequiredSecrets, isAdminUser } from "./security";
import { requireAuth } from "./middlewares/clerkAuth";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import { twilioWebhookSignatureBoundary } from "./twilio-webhook-security";
import { setupPttServer } from "./ptt";
import { logger } from "./lib/logger";
import { attachRequestLogger } from "./middlewares/request-logger";
import { enforceAssignedResourceBoundary, getStaffAccess } from "./staff-access";
import { registerStaffInviteDeliveryWebhook } from "./staff-invites";
import { apiAuthenticationBoundary } from "./api-auth-boundary";
import { registerReadinessRoutes } from "./readiness";
import { pool } from "./db";
import { runMigrations } from "./boot/migrations";
import { startBackgroundWorkers } from "./boot/workers";
import { registerApiRoutes } from "./boot/api-routes";
import { initStripe, registerStripeWebhook } from "./boot/stripe";

// Boot order:
//   1. Clerk, security headers, signed webhooks that need the raw body
//   2. Body parsers and request logging
//   3. Routes that must skip the auth boundary (auth/access, readiness)
//   4. Global API auth boundary + Twilio signature boundary
//   5. Schema migrations (boot/migrations.ts)
//   6. Stripe, every API route (boot/api-routes.ts), background workers (boot/workers.ts)
//   7. PTT WebSocket server, error handler, listen

const log = (message: string) => logger.info(message);

const app = express();

app.use(attachRequestLogger);
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

// Signed webhooks that verify the raw body: register before express.json().
registerStripeWebhook(app);
registerStaffInviteDeliveryWebhook(app);

// Multi-camera ARIA commands carry base64 JPEG frames, so this path needs a
// larger body limit than the default parser allows.
app.use("/api/aria/agent-command", express.json({ limit: "20mb" }));
app.use("/api/paypal-import", express.json({ limit: "8mb" }));
app.use("/api/contact-import", express.json({ limit: "8mb" }));
// Marketplace listings carry up to 8 base64 photos (each capped at 1.5 MB server-side).
app.use(["/api/portal/marketplace", "/api/marketplace"], express.json({ limit: "16mb" }));
// Intake, avatars and portal ads carry one base64 image (≤1 MB server-side).
app.use(["/api/intake", "/api/clients/:id/avatar", "/api/staff-profile/me/avatar", "/api/crm/portal-ads"], express.json({ limit: "2mb" }));
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

(async () => {
  // Fail fast at boot if a secret the app cannot run without is missing.
  assertRequiredSecrets();
  const readinessSmokeTest = process.argv.includes("--readiness-smoke-test");

  // Authorization data, not a second identity source. It lets the browser hide
  // admin-only navigation while ADMIN_EMAILS remains enforced from verified Clerk
  // session claims on every protected server route. Registered before the auth
  // boundary so pending staff can still learn their own status.
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
  // requireAuth resolves/JIT-provisions the matching auth_users record, and
  // the boundary applies the per-path feature gate from security.ts.
  app.use(apiAuthenticationBoundary);
  app.use(enforceAssignedResourceBoundary);

  // All present and future Twilio POST callbacks inherit signature verification.
  // Public GET resources under /webhooks (such as greeting audio) remain available.
  app.use("/webhooks", twilioWebhookSignatureBoundary);

  const migrations = await runMigrations();
  await initStripe();
  const server = await registerApiRoutes(app);
  startBackgroundWorkers(migrations);
  setupPttServer(server);

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) {
      logger.error({ err, method: req.method, path: req.path }, "Unhandled request error");
    }
    if (res.headersSent) return;
    res.status(status).json({ message: status >= 500 ? "Internal Server Error" : err.message || "Request failed" });
  });

  // ALWAYS serve the app on the port specified in the environment variable PORT.
  // Other ports are firewalled. This serves both the API and the client.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });
})();
