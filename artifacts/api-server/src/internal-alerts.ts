import { logger } from "./lib/logger";
import { storage } from "./storage";

export const SHARED_RATE_LIMIT_CLEANUP_ALERT_SOURCE =
  "shared-rate-limit-cleanup";
export const SHARED_RATE_LIMIT_CLEANUP_FAILURE_THRESHOLD = 3;

type InternalAlertStorage = Pick<
  typeof storage,
  "upsertActiveAlertBySource" | "resolveActiveAlertsBySource"
>;

export function createSharedRateLimitCleanupHealthReporter(
  alertStorage: InternalAlertStorage,
  alertSource = SHARED_RATE_LIMIT_CLEANUP_ALERT_SOURCE,
  now: () => Date = () => new Date(),
) {
  let consecutiveFailures = 0;

  return {
    async recordFailure(): Promise<void> {
      const failureObservedAt = now();
      consecutiveFailures += 1;
      if (consecutiveFailures < SHARED_RATE_LIMIT_CLEANUP_FAILURE_THRESHOLD) {
        return;
      }

      try {
        await alertStorage.upsertActiveAlertBySource(
          alertSource,
          {
            title: "Request-limit cleanup needs attention",
            description:
              "Expired request-limit records have repeatedly failed to clean up. " +
              "Review API service health and database availability before storage use grows. " +
              "No request-limit keys, database errors, or database details are stored in this alert.",
            severity: "warning",
            category: "system",
            status: "active",
            alertSource,
            affectedServices: JSON.stringify([]),
            businessImpact: "warning",
            isEmergency: false,
          },
          undefined,
          failureObservedAt,
        );
      } catch {
        logger.error(
          "[security] request-limit cleanup incident could not be recorded",
        );
      }
    },

    async recordSuccess(): Promise<void> {
      const recoveryStartedAt = now();
      consecutiveFailures = 0;
      try {
        await alertStorage.resolveActiveAlertsBySource(
          alertSource,
          undefined,
          recoveryStartedAt,
        );
      } catch {
        logger.error(
          "[security] request-limit cleanup incident could not be resolved",
        );
      }
    },
  };
}

let reporter = createSharedRateLimitCleanupHealthReporter(storage);

export function __setInternalAlertStorageForTests(
  override: InternalAlertStorage | null,
): void {
  reporter = createSharedRateLimitCleanupHealthReporter(override ?? storage);
}

export async function recordSharedRateLimitCleanupFailure(): Promise<void> {
  await reporter.recordFailure();
}

export async function recordSharedRateLimitCleanupSuccess(): Promise<void> {
  await reporter.recordSuccess();
}