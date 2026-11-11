import type { Express } from "express";
import express from "express";
import { ExportEmailProviderWarningSettingsHistoryQueryParams, GetEmailProviderHealthResponse, GetSlackDeliveryHealthResponse, ListSlackTerminalFailuresResponse, RetrySlackTerminalFailureParams, RetrySlackTerminalFailureResponse, GetEmailProviderWarningSettingsHistoryQueryParams, GetEmailProviderWarningSettingsHistoryResponse, RecheckEmailProviderHealthResponse, UpdateEmailProviderWarningSettingsBody, UpdateEmailProviderWarningSettingsResponse } from "@workspace/api-zod";
import { getSlackDeliveryHealth } from "../slack-delivery-health";
import { listSlackTerminalFailures, retrySlackTerminalFailure } from "../slack-outbox";
import { sharedRateLimit } from "../security";
import { formatEmailCapacityWarningSettingsAuditCsv, parseEmailCapacityWarningSettingsAuditCursor } from "../email-capacity-settings";
import { requireOwner } from "./owner-auth";
import type { getEmailCapacityMonitoringStatus } from "../email-provider-health";
import type {
  getEmailCapacityWarningSettings,
  getEmailCapacityWarningSettingsAudit,
  updateEmailCapacityWarningSettings,
} from "../email-capacity-settings";

export type ProviderHealthRouteOptions = {
  providerHealthAuthMiddleware: express.RequestHandler;
  recheckProviderHealthEmailCapacity: () => Promise<ReturnType<typeof getEmailCapacityMonitoringStatus>>;
  getProviderHealthEmailCapacityStatus: () => unknown;
  getProviderHealthWarningSettings: typeof getEmailCapacityWarningSettings;
  getProviderHealthWarningSettingsAudit: typeof getEmailCapacityWarningSettingsAudit;
  updateProviderHealthWarningSettings: typeof updateEmailCapacityWarningSettings;
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

// Owner-only email (SendGrid/SMTP capacity) and Slack delivery health.
export function registerProviderHealthRoutes(app: Express, options: ProviderHealthRouteOptions): void {
  const {
    providerHealthAuthMiddleware,
    recheckProviderHealthEmailCapacity,
    getProviderHealthEmailCapacityStatus,
    getProviderHealthWarningSettings,
    getProviderHealthWarningSettingsAudit,
    updateProviderHealthWarningSettings,
  } = options;

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
}
