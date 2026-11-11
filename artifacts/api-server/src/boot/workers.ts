import { logger } from "../lib/logger";
import { startSmsForwardOutboxWorker } from "../sms-forward-outbox";
import { startSlackNotificationOutboxWorker } from "../slack-outbox";
import { sendSlackMessage } from "../slack";
import { startStaffClientMessageHistoryWorker } from "../staff-dispatch";
import { startSpeedToLeadWorker } from "../speed-to-lead";
import { startCatalogReconciliationWorker } from "../catalog";
import { startInvoiceEmailOutboxWorker } from "../invoice-email-outbox";
import { startMailboxWorker } from "../mailbox-service";
import { startEmailProviderCapacityMonitor } from "../email-provider-health";
import { startSlotLockSweeper } from "../booking/booking-routes";
import { seedBookingDefaults } from "../booking/seed";
import { startA2PMonitor } from "../a2p-monitor";
import { meshCentralService } from "../meshcentral-service";
import type { MigrationReport } from "./migrations";

export type BackgroundWorker = {
  name: string;
  // Boot migrations (by name, see MIGRATIONS) whose tables the worker needs.
  // If any of them failed, the worker is skipped instead of erroring forever.
  requires?: string[];
  start: () => void;
};

// Keeps the local device list in sync with the MeshCentral server. Backs off
// exponentially on failure: repeated failed logins trip MeshCentral's
// invalid-login IP throttle, so a fixed 60s retry would keep us locked out.
function startMeshCentralDeviceSync(): void {
  if (!meshCentralService.isConfigured()) return;
  const BASE_INTERVAL = 60_000;
  const MAX_INTERVAL = 15 * 60_000;
  let delay = BASE_INTERVAL;
  const runSync = async () => {
    try {
      const r = await meshCentralService.syncDevices();
      if (r.error) {
        logger.warn({ error: r.error }, "MeshCentral device sync error");
        delay = Math.min(delay * 2, MAX_INTERVAL);
      } else {
        logger.info({ synced: r.synced }, "MeshCentral device sync complete");
        delay = BASE_INTERVAL;
      }
    } catch (err) {
      logger.error({ err }, "MeshCentral device sync failed");
      delay = Math.min(delay * 2, MAX_INTERVAL);
    } finally {
      setTimeout(runSync, delay).unref();
    }
  };
  setTimeout(runSync, 10_000).unref();
}

// Every recurring background job the API runs. Per-connection timers (SSE and
// WebSocket heartbeats) live with their connections and aren't listed here.
// Workers that send or claim work use database claims, so running one copy per
// autoscale instance is safe.
export const BACKGROUND_WORKERS: readonly BackgroundWorker[] = [
  { name: "sms-forward-outbox", requires: ["sms-forwarding"], start: startSmsForwardOutboxWorker },
  {
    name: "staff-client-message-history",
    requires: ["staff-client-messages"],
    start: () =>
      startStaffClientMessageHistoryWorker((error) =>
        logger.warn({ error }, "Staff client message history worker failed"),
      ),
  },
  {
    name: "slack-notification-outbox",
    requires: ["slack-notification-outbox"],
    start: () => startSlackNotificationOutboxWorker(sendSlackMessage),
  },
  { name: "speed-to-lead", requires: ["sales-agents"], start: startSpeedToLeadWorker },
  { name: "catalog-reconciliation", requires: ["catalog"], start: startCatalogReconciliationWorker },
  { name: "invoice-email-outbox", start: startInvoiceEmailOutboxWorker },
  { name: "mailbox", start: startMailboxWorker },
  { name: "email-provider-capacity", start: () => startEmailProviderCapacityMonitor() },
  { name: "booking-slot-lock-sweeper", requires: ["booking-engine"], start: () => startSlotLockSweeper() },
  {
    name: "booking-seed",
    requires: ["booking-engine"],
    start: () => {
      seedBookingDefaults()
        .then((r) => logger.info({ services: r.serviceCount, resourceId: r.resourceId }, "Booking seed complete"))
        .catch((err) => logger.error({ err }, "Booking seed failed"));
    },
  },
  { name: "a2p-monitor", requires: ["a2p-monitor-state"], start: () => startA2PMonitor() },
  { name: "meshcentral-device-sync", start: startMeshCentralDeviceSync },
];

export function startBackgroundWorkers(
  migrations: MigrationReport,
  workers: readonly BackgroundWorker[] = BACKGROUND_WORKERS,
): void {
  const failed = new Set(migrations.failed);
  for (const worker of workers) {
    const missing = (worker.requires ?? []).filter((name) => failed.has(name));
    if (missing.length) {
      logger.warn({ worker: worker.name, missing }, "Background worker not started; its migration failed");
      continue;
    }
    try {
      worker.start();
    } catch (err) {
      logger.error({ err, worker: worker.name }, "Background worker failed to start");
    }
  }
}
