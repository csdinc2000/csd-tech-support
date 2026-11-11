import type { Express } from "express";
import type { Server } from "node:http";
import { registerRoutes } from "../routes/routes";
import { isAdminEmail } from "../security";
import { registerTwilioForwarding } from "../twilio-forwarding";
import { registerIncomingCallAlerts } from "../incoming-call-alerts";
import { registerTwilioTracking } from "../twilio-tracking";
import { registerStaffAccessRoutes, requireStaffAdministrator } from "../staff-access";
import { registerStaffProfileRoutes } from "../staff-profile";
import { registerStaffBusinessCardRoutes } from "../staff-business-card";
import { registerPttPageRoutes } from "../ptt-pages";
import { registerLeadGenRoutes } from "../lead-gen-agent";
import { registerSpeedToLeadRoutes } from "../speed-to-lead";
import { registerLeadResearchRoutes } from "../lead-research";
import { registerExecutiveAssistantRoutes } from "../executive-assistant";
import { registerStaffContactProfileRoutes } from "../staff-contact-profile";
import { registerStaffInviteRoutes } from "../staff-invites";
import { registerStaffAccountDeletionRoutes } from "../staff-account-deletion";

export type ApiRouteOptions = Parameters<typeof registerRoutes>[1];

// Registers every route that sits behind the global API auth boundary (see
// api-auth-boundary.ts), in one place, so boot and the route-coverage test
// (api-route-coverage.integration.test.ts) see exactly the same set.
//
// Routes that must run BEFORE the JSON body parser or the auth boundary (the
// Stripe and SendGrid signed webhooks, readiness probes, and /api/auth/access,
// which pending staff need to learn their status) stay in index.ts.
export async function registerApiRoutes(app: Express, options: ApiRouteOptions = {}): Promise<Server> {
  // Twilio webhooks under /webhooks are signature-checked by
  // twilioWebhookSignatureBoundary, mounted in index.ts.
  registerTwilioForwarding(app);
  registerIncomingCallAlerts(app);
  registerTwilioTracking(app);

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
  return registerRoutes(app, options);
}
