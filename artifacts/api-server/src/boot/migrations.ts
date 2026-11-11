import { logger } from "../lib/logger";
import { applyBillingMigration } from "../migrations/2026-05-13-billing";
import { applyTeamviewerMigration } from "../migrations/2026-05-13-teamviewer";
import { applyHelpdeskMigration } from "../migrations/2026-05-14-helpdesk";
import { applyA2pRejectionSuggestionsMigration } from "../migrations/2026-05-23-a2p-rejection-suggestions";
import { applyPatchMgmtMigration } from "../migrations/2026-06-09-patch-mgmt";
import { applySmsErrorCodeMigration } from "../migrations/2026-06-17-sms-error-code";
import { applySmsForwardingMigration } from "../migrations/2026-09-07-sms-forwarding";
import { applyBookingEngineMigration } from "../migrations/2026-07-04-booking-engine";
import { applyBackupForwardNumberMigration } from "../migrations/2026-07-08-backup-forward-number";
import { applyCrmPipelineMigration } from "../migrations/2026-07-16-crm-pipeline";
import { applyIntakeIdempotencyMigration } from "../migrations/2026-07-17-intake-idempotency";
import { applyCustomerPhotosMigration } from "../migrations/2026-10-22-customer-photos";
import { applyStaffAvatarsMigration } from "../migrations/2026-11-06-staff-avatars";
import { applyStaffBusinessCardsMigration } from "../migrations/2026-11-06-staff-business-cards";
import { applyPttPagesMigration } from "../migrations/2026-11-06-ptt-pages";
import { applyCustomerLinkMigration } from "../customer-links";
import { applyPttTelemetryMigration } from "../migrations/2026-09-06-ptt-telemetry";
import { applyMarketplaceMigration } from "../migrations/2026-09-16-marketplace";
import { applyCatalogMigration } from "../migrations/2026-09-28-catalog";
import { applyCommunicationEmailMigration } from "../migrations/2026-10-27-communication-email";
import { applyStaffClientMessagesMigration } from "../migrations/2026-09-06-staff-client-messages";
import { applyCallSupportTicketMigration } from "../migrations/2026-09-07-call-support-ticket";
import { applyStaffAccessMigration } from "../migrations/2026-09-07-staff-access";
import { applyServiceContractsMigration } from "../migrations/2026-09-08-service-contracts";
import { applyEmailCapacityAlertMigration } from "../migrations/2026-09-14-email-capacity-alert";
import { applyEmailCapacitySettingsMigration } from "../migrations/2026-09-14-email-capacity-settings";
import { applySharedRateLimitsMigration } from "../migrations/2026-09-16-shared-rate-limits";
import { applySlackDeliveryHealthMigration } from "../migrations/2026-09-22-slack-delivery-health";
import { applySlackNotificationOutboxMigration } from "../migrations/2026-09-27-slack-notification-outbox";
import { applyStaffInvitesMigration } from "../migrations/2026-09-23-staff-invites";
import { applyCallForwardingOutcomesMigration } from "../migrations/2026-10-26-call-forwarding-outcomes";
import { applyCallForwardingStaffOutcomesMigration } from "../migrations/2026-10-27-call-forwarding-staff-outcomes";
import { applySharedInboxMigration } from "../migrations/2026-10-30-shared-inbox";
import { applyReferralsMigration } from "../migrations/2026-10-30-referrals";
import { applyVouchersMigration } from "../migrations/2026-11-10-vouchers";
import { applyOutboundCallOutcomesMigration } from "../migrations/2026-11-06-outbound-call-outcomes";
import { applyLocalWebsiteIntelligenceMigration } from "../local-website-intelligence";
import { applySalesAgentsMigration } from "../migrations/2026-11-10-sales-agents";
import { applyA2pMonitorStateMigration } from "../migrations/2026-11-11-a2p-monitor-state";

export type Migration = { name: string; apply: () => Promise<unknown> };

// Every boot-time schema migration, in the order it runs. Each one is
// idempotent (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), so the
// whole list runs on every start. Add new migrations at the END.
//
// A few older schemas are still created inside registerRoutes()
// (ensureInvoiceSchema and friends) because the route integration tests rely
// on registerRoutes() creating them.
export const MIGRATIONS: readonly Migration[] = [
  { name: "billing", apply: applyBillingMigration },
  { name: "teamviewer", apply: applyTeamviewerMigration },
  { name: "helpdesk", apply: applyHelpdeskMigration },
  { name: "a2p-rejection-suggestions", apply: applyA2pRejectionSuggestionsMigration },
  { name: "patch-mgmt", apply: applyPatchMgmtMigration },
  { name: "sms-error-code", apply: applySmsErrorCodeMigration },
  { name: "sms-forwarding", apply: applySmsForwardingMigration },
  { name: "booking-engine", apply: applyBookingEngineMigration },
  { name: "backup-forward-number", apply: applyBackupForwardNumberMigration },
  { name: "crm-pipeline", apply: applyCrmPipelineMigration },
  { name: "intake-idempotency", apply: applyIntakeIdempotencyMigration },
  { name: "customer-photos", apply: applyCustomerPhotosMigration },
  { name: "staff-avatars", apply: applyStaffAvatarsMigration },
  { name: "staff-business-cards", apply: applyStaffBusinessCardsMigration },
  { name: "ptt-pages", apply: applyPttPagesMigration },
  { name: "customer-links", apply: applyCustomerLinkMigration },
  { name: "ptt-telemetry", apply: applyPttTelemetryMigration },
  { name: "marketplace", apply: applyMarketplaceMigration },
  { name: "catalog", apply: applyCatalogMigration },
  { name: "communication-email", apply: applyCommunicationEmailMigration },
  { name: "staff-client-messages", apply: applyStaffClientMessagesMigration },
  { name: "call-support-ticket", apply: applyCallSupportTicketMigration },
  { name: "staff-access", apply: applyStaffAccessMigration },
  { name: "service-contracts", apply: applyServiceContractsMigration },
  { name: "email-capacity-alert", apply: applyEmailCapacityAlertMigration },
  { name: "email-capacity-settings", apply: applyEmailCapacitySettingsMigration },
  { name: "shared-rate-limits", apply: applySharedRateLimitsMigration },
  { name: "slack-delivery-health", apply: applySlackDeliveryHealthMigration },
  { name: "slack-notification-outbox", apply: applySlackNotificationOutboxMigration },
  { name: "staff-invites", apply: applyStaffInvitesMigration },
  { name: "call-forwarding-outcomes", apply: applyCallForwardingOutcomesMigration },
  { name: "call-forwarding-staff-outcomes", apply: applyCallForwardingStaffOutcomesMigration },
  { name: "shared-inbox", apply: applySharedInboxMigration },
  { name: "referrals", apply: applyReferralsMigration },
  { name: "vouchers", apply: applyVouchersMigration },
  { name: "outbound-call-outcomes", apply: applyOutboundCallOutcomesMigration },
  { name: "local-website-intelligence", apply: applyLocalWebsiteIntelligenceMigration },
  { name: "sales-agents", apply: applySalesAgentsMigration },
  { name: "a2p-monitor-state", apply: applyA2pMonitorStateMigration },
];

export type MigrationReport = { applied: string[]; failed: string[] };

// Runs every migration in order. A failure is logged and the rest still run,
// so one broken feature can't take the whole app down; the returned report
// lets boot skip background workers whose tables are missing.
export async function runMigrations(
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<MigrationReport> {
  const report: MigrationReport = { applied: [], failed: [] };
  for (const migration of migrations) {
    try {
      await migration.apply();
      report.applied.push(migration.name);
    } catch (error) {
      report.failed.push(migration.name);
      logger.error({ err: error, migration: migration.name }, "Boot migration failed");
    }
  }
  if (report.failed.length) {
    logger.error(
      { failed: report.failed },
      `${report.failed.length} of ${migrations.length} boot migrations failed; features that depend on them may not work`,
    );
  } else {
    logger.info({ count: report.applied.length }, "Boot migrations applied");
  }
  return report;
}
