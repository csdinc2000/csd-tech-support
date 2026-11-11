import { logger } from "./lib/logger";
import type { SlackNotificationType } from "./slack-outbox";

type SlackDispatchCategory = SlackNotificationType | "automation";

/**
 * Background delivery must never delay the caller. Outbox writes are different:
 * use "await-enqueue" so the notification is durable before returning, without
 * waiting for the Slack provider.
 */
export function dispatchBestEffortSlack(
  action: () => void | Promise<unknown>,
  category: SlackDispatchCategory,
): void;
export function dispatchBestEffortSlack(
  action: () => void | Promise<unknown>,
  category: SlackDispatchCategory,
  mode: "await-enqueue",
): Promise<void>;
export function dispatchBestEffortSlack(
  action: () => void | Promise<unknown>,
  category: SlackDispatchCategory,
  mode?: "await-enqueue",
): void | Promise<void> {
  const handled = Promise.resolve()
    .then(action)
    .then(() => undefined)
    .catch(() => {
      // Never log the exception: it can include message content or connector data.
      logger.warn({ category }, "Best-effort Slack notification failed");
    });
  if (mode === "await-enqueue") return handled;
  void handled;
}