import { storage } from "./storage";
import { logger } from "./lib/logger";
import {
  getEmailCapacityWarningSettings,
  type EmailCapacityWarningSettings,
} from "./email-capacity-settings";

export const EMAIL_CAPACITY_ALERT_SOURCE = "email-provider-capacity";
export const EMAIL_CAPACITY_LOW_PERCENT = 10;
export const EMAIL_CAPACITY_LOW_ABSOLUTE = 100;
const DEFAULT_CAPACITY_POLL_INTERVAL_MS = 15 * 60_000;
export const EMAIL_CAPACITY_READING_STALE_AFTER_MS = 30 * 60_000;

export type EmailOperation = "helpdesk" | "invoice" | "invoice reminder" | "marketplace" | "intake" | "staff invite" | "communications" | "referrals" | "vouchers";
export type EmailProvider = "sendgrid" | "smtp";

type HealthStorage = Pick<typeof storage, "getActiveAlerts" | "createAlert" | "updateAlert"> &
  Partial<Pick<typeof storage, "upsertActiveAlertBySource" | "resolveActiveAlertsBySource">>;
let healthStorage: HealthStorage = storage;
type CreditFetcher = (url: string, init: RequestInit) => Promise<Response>;
let creditFetcher: CreditFetcher = fetch;
let warningSettingsFetcher: () => Promise<EmailCapacityWarningSettings> = getEmailCapacityWarningSettings;
let capacityMonitorStarted = false;

export type EmailCapacityMonitoringStatus = {
  available: boolean;
  state: "not_checked" | "available" | "unavailable";
  reason: "not_checked" | "not_configured" | "permission_denied" | "provider_unavailable" | null;
  checkedAt: string | null;
  balance: {
    remaining: number;
    total: number;
    percentage: number;
    checkedAt: string;
    stale: boolean;
  } | null;
};

let capacityMonitoringStatus: EmailCapacityMonitoringStatus = {
  available: false,
  state: "not_checked",
  reason: "not_checked",
  checkedAt: null,
  balance: null,
};

export function getEmailCapacityMonitoringStatus(): EmailCapacityMonitoringStatus {
  const balance = capacityMonitoringStatus.balance;
  return {
    ...capacityMonitoringStatus,
    balance: balance
      ? {
          ...balance,
          stale:
            capacityMonitoringStatus.state !== "available" ||
            Date.now() - new Date(balance.checkedAt).getTime() > EMAIL_CAPACITY_READING_STALE_AFTER_MS,
        }
      : null,
  };
}

function setCapacityMonitoringStatus(
  state: "available" | "unavailable",
  reason: EmailCapacityMonitoringStatus["reason"],
): void {
  capacityMonitoringStatus = {
    available: state === "available",
    state,
    reason,
    checkedAt: new Date().toISOString(),
    balance: capacityMonitoringStatus.balance,
  };
}

function retainReliableBalance(credits: SendGridCredits): void {
  const checkedAt = new Date().toISOString();
  capacityMonitoringStatus = {
    available: true,
    state: "available",
    reason: null,
    checkedAt,
    balance: {
      remaining: credits.remain,
      total: credits.total,
      percentage: Math.max(0, Math.round((credits.remain / credits.total) * 100)),
      checkedAt,
      stale: false,
    },
  };
}

export function __setEmailProviderHealthStorageForTests(override: HealthStorage | null): void {
  healthStorage = override ?? storage;
  lifecycleQueue = Promise.resolve();
}

export function __setEmailCreditFetcherForTests(override: CreditFetcher | null): void {
  creditFetcher = override ?? fetch;
}

export function __setEmailCapacityWarningSettingsFetcherForTests(
  override: (() => Promise<EmailCapacityWarningSettings>) | null,
): void {
  warningSettingsFetcher = override ?? getEmailCapacityWarningSettings;
}

type ProviderError = {
  message?: unknown;
  field?: unknown;
  help?: unknown;
};

function providerMessages(error: unknown): string[] {
  const errors = (error as any)?.response?.body?.errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .flatMap((entry: ProviderError) => [entry?.message, entry?.field, entry?.help])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

// Nodemailer surfaces the SMTP server's reply text on `error.response`
// (e.g. Gmail's "550 5.4.5 Daily user sending quota exceeded").
function smtpResponse(error: unknown): string {
  const response = (error as any)?.response;
  return typeof response === "string" ? response : "";
}

export function isEmailProviderCapacityError(error: unknown): boolean {
  const text = [...providerMessages(error), smtpResponse(error), String((error as any)?.message || "")]
    .join(" ")
    .toLowerCase();
  return [
    /maximum (?:sending )?credits? exceeded/,
    /(?:sending|email) (?:credits?|quota|limit) (?:has been )?(?:exceeded|exhausted|reached)/,
    /(?:quota|capacity) exceeded/,
    /out of (?:sending )?credits?/,
    /insufficient (?:sending )?credits?/,
    /account (?:has been )?(?:suspended|deactivated) due to (?:billing|usage|quota)/,
    // SMTP relay / mailbox provider throttles and quotas.
    /(?:daily|hourly|monthly) (?:user )?(?:sending|message|email|send) (?:quota|limit)/,
    /(?:sending|message|send|email) (?:rate )?limit (?:has been )?(?:exceeded|reached)/,
    /too many (?:messages|recipients|emails)/,
    /rate ?limit/,
    /\b(?:4|5)\.7\.(?:0|1|28)\b.*(?:limit|quota|throttl)/,
  ].some((pattern) => pattern.test(text));
}

let lifecycleQueue: Promise<void> = Promise.resolve();

function serializeLifecycle(work: () => Promise<void>): Promise<void> {
  const next = lifecycleQueue.then(work, work);
  lifecycleQueue = next.catch(() => undefined);
  return next;
}

function parseAffectedServices(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

const CAPACITY_FAILURE_DESCRIPTION: Record<EmailProvider, string> = {
  sendgrid:
    "SendGrid account capacity is blocking operational email. " +
    "Restore sending credits or account capacity in SendGrid, then confirm delivery with the next operational email. ",
  smtp:
    "The SMTP mail server is rejecting operational email with a sending quota or rate limit. " +
    "Raise the limit or wait for the mailbox provider's quota window to reset, then confirm delivery with the next operational email. ",
};

export async function recordEmailProviderCapacityFailure(
  operation: EmailOperation,
  provider: EmailProvider = "sendgrid",
): Promise<void> {
  await serializeLifecycle(async () => {
    const input = {
      title: "Email provider capacity is exhausted",
      description:
        CAPACITY_FAILURE_DESCRIPTION[provider] +
        "Affected operation categories are recorded separately; no customer message content or provider credentials are stored in this alert.",
      severity: "critical",
      category: "email",
      status: "active",
      alertSource: EMAIL_CAPACITY_ALERT_SOURCE,
      affectedServices: JSON.stringify([operation]),
      businessImpact: "critical",
      isEmergency: false,
    } as const;
    if (healthStorage.upsertActiveAlertBySource) {
      await healthStorage.upsertActiveAlertBySource(
        EMAIL_CAPACITY_ALERT_SOURCE,
        input,
        operation,
      );
      return;
    }

    const active = (await healthStorage.getActiveAlerts())
      .filter((alert) => alert.alertSource === EMAIL_CAPACITY_ALERT_SOURCE);
    const operations = new Set<string>([operation]);
    for (const alert of active) {
      for (const value of parseAffectedServices(alert.affectedServices)) operations.add(value);
    }
    const affectedServices = JSON.stringify([...operations].sort());
    if (active[0]) {
      await healthStorage.updateAlert(active[0].id, {
        ...input,
        affectedServices,
        resolvedAt: null,
      });
    } else {
      await healthStorage.createAlert({ ...input, affectedServices });
    }
  });
}

export async function recordLowEmailProviderCapacity(remaining: number, total: number): Promise<void> {
  await serializeLifecycle(async () => {
    const active = (await healthStorage.getActiveAlerts())
      .filter((alert) => alert.alertSource === EMAIL_CAPACITY_ALERT_SOURCE);
    const percent = Math.max(0, Math.round((remaining / total) * 100));
    const description =
      `SendGrid reports ${remaining.toLocaleString()} of ${total.toLocaleString()} sending credits remaining (${percent}%). ` +
      "Review the SendGrid plan before operational email is interrupted. " +
      "No customer message content or provider credentials are stored in this alert.";
    const [existing, ...duplicates] = active;
    if (existing) {
      await healthStorage.updateAlert(existing.id, {
        title: "Email provider capacity is running low",
        description,
        severity: "warning",
        category: "email",
        status: "active",
        affectedServices: JSON.stringify([]),
        businessImpact: "warning",
        resolvedAt: null,
      });
      await Promise.all(duplicates.map((alert) =>
        healthStorage.updateAlert(alert.id, { status: "resolved", resolvedAt: new Date() })
      ));
      return;
    }
    await healthStorage.createAlert({
      title: "Email provider capacity is running low",
      description,
      severity: "warning",
      category: "email",
      status: "active",
      alertSource: EMAIL_CAPACITY_ALERT_SOURCE,
      affectedServices: JSON.stringify([]),
      businessImpact: "warning",
      isEmergency: false,
    });
  });
}

export async function resolveEmailProviderCapacityAlert(includeLowCapacity = false): Promise<void> {
  await serializeLifecycle(async () => {
    const excludedTitle = includeLowCapacity
      ? undefined
      : "Email provider capacity is running low";
    if (healthStorage.resolveActiveAlertsBySource) {
      await healthStorage.resolveActiveAlertsBySource(EMAIL_CAPACITY_ALERT_SOURCE, excludedTitle);
      return;
    }
    const active = (await healthStorage.getActiveAlerts()).filter((alert) =>
      alert.alertSource === EMAIL_CAPACITY_ALERT_SOURCE &&
      (!excludedTitle || alert.title !== excludedTitle)
    );
    const resolvedAt = new Date();
    await Promise.all(active.map((alert) =>
      healthStorage.updateAlert(alert.id, { status: "resolved", resolvedAt })
    ));
  });
}

type SendGridCredits = {
  remain: number;
  total: number;
};

function parseReliableCredits(value: unknown): SendGridCredits | null {
  const body = value as Record<string, unknown> | null;
  if (
    !body ||
    !Number.isSafeInteger(body.remain) ||
    !Number.isSafeInteger(body.total) ||
    (body.remain as number) < 0 ||
    (body.total as number) <= 0 ||
    (body.remain as number) > (body.total as number)
  ) return null;
  return { remain: body.remain as number, total: body.total as number };
}

export async function checkEmailProviderCapacityOnce(): Promise<"low" | "healthy" | "unavailable"> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    setCapacityMonitoringStatus("unavailable", "not_configured");
    return "unavailable";
  }
  const baseUrl = process.env.SENDGRID_API_BASE_URL || "https://api.sendgrid.com";
  try {
    const response = await creditFetcher(`${baseUrl.replace(/\/+$/, "")}/v3/user/credits`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      setCapacityMonitoringStatus(
        "unavailable",
        response.status === 401 || response.status === 403
          ? "permission_denied"
          : "provider_unavailable",
      );
      return "unavailable";
    }
    const credits = parseReliableCredits(await response.json());
    if (!credits) {
      setCapacityMonitoringStatus("unavailable", "provider_unavailable");
      return "unavailable";
    }
    retainReliableBalance(credits);
    const warningSettings = await warningSettingsFetcher();
    const low = warningSettings.mode === "percentage"
      ? credits.remain / credits.total <= warningSettings.value / 100
      : warningSettings.mode === "remainingCredits"
        ? credits.remain <= warningSettings.value
        : credits.remain <= EMAIL_CAPACITY_LOW_ABSOLUTE ||
          credits.remain / credits.total <= EMAIL_CAPACITY_LOW_PERCENT / 100;
    if (low) {
      await recordLowEmailProviderCapacity(credits.remain, credits.total);
      return "low";
    }
    await resolveEmailProviderCapacityAlert(true);
    return "healthy";
  } catch (error) {
    setCapacityMonitoringStatus("unavailable", "provider_unavailable");
    logger.warn(
      { error: error instanceof Error ? error.message : "unknown error" },
      "SendGrid credit balance could not be checked",
    );
    return "unavailable";
  }
}

export function startEmailProviderCapacityMonitor(
  intervalMs = DEFAULT_CAPACITY_POLL_INTERVAL_MS,
): void {
  if (capacityMonitorStarted) return;
  if (!process.env.SENDGRID_API_KEY) {
    setCapacityMonitoringStatus("unavailable", "not_configured");
    return;
  }
  capacityMonitorStarted = true;
  setTimeout(() => void checkEmailProviderCapacityOnce(), 30_000);
  const timer = setInterval(() => void checkEmailProviderCapacityOnce(), intervalMs);
  timer.unref();
}