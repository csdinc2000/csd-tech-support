import { useEffect, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "wouter";
import type {
  EmailProviderCapacityStatus,
  EmailProviderHealth,
  EmailProviderWarningSettings,
  SlackDeliveryHealth,
} from "@workspace/api-client-react";
import {
  getEmailProviderWarningSettingsHistory,
  getExportEmailProviderWarningSettingsHistoryUrl,
  useUpdateEmailProviderWarningSettings,
} from "@workspace/api-client-react";
import { AlertTriangle, CheckCircle2, HeartPulse } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { SlackTerminalFailures } from "@/components/advanced/slack-terminal-failures";
import {
  historyDateRangeToUtcInstants,
  historyFromParam,
  historyToParam,
  historyZoneParam,
  isCalendarDate,
  readHistoryDateRange,
  type WarningHistoryDateRange,
} from "./provider-health-history-range";

const warningHistoryQueryKey = ["/api/provider-health/email/warning-settings/history"] as const;
const warningHistoryPageSize = 25;
const unsavedWarningSettingsMessage =
  "You have unsaved email warning threshold changes. Leave this page and discard them?";

let hasUnsavedEmailWarningSettings = false;
let lastKnownEmailWarningHistoryEntry: { href: string; state: unknown } | undefined =
  typeof window === "undefined"
    ? undefined
    : { href: window.location.href, state: window.history.state };

function rememberEmailWarningHistoryEntry() {
  if (typeof window === "undefined") return;
  lastKnownEmailWarningHistoryEntry = {
    href: window.location.href,
    state: window.history.state,
  };
}

function guardEmailWarningHistoryNavigation() {
  if (typeof window === "undefined") return;
  const previousEntry = lastKnownEmailWarningHistoryEntry;
  const currentUrl = new URL(window.location.href);
  if (!previousEntry) {
    rememberEmailWarningHistoryEntry();
    return;
  }

  const previousUrl = new URL(previousEntry.href);
  const staysOnCurrentPage =
    previousUrl.origin === currentUrl.origin
    && previousUrl.pathname === currentUrl.pathname;
  if (staysOnCurrentPage || !hasUnsavedEmailWarningSettings) {
    rememberEmailWarningHistoryEntry();
    return;
  }

  if (!window.confirm(unsavedWarningSettingsMessage)) {
    window.history.pushState(previousEntry.state, "", previousEntry.href);
    return;
  }
  rememberEmailWarningHistoryEntry();
}

// Keep this singleton ahead of the router's history listener: browser Back can
// otherwise unmount a dirty settings form before its confirmation handler runs.
if (typeof window !== "undefined") {
  window.addEventListener("pushState", rememberEmailWarningHistoryEntry);
  window.addEventListener("replaceState", rememberEmailWarningHistoryEntry);
  window.addEventListener("popstate", guardEmailWarningHistoryNavigation, true);
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      window.removeEventListener("pushState", rememberEmailWarningHistoryEntry);
      window.removeEventListener("replaceState", rememberEmailWarningHistoryEntry);
      window.removeEventListener("popstate", guardEmailWarningHistoryNavigation, true);
    });
  }
}

function describeWarningSettings(settings: EmailProviderWarningSettings): string {
  if (settings.mode === "default") return "Safe defaults";
  if (settings.mode === "percentage") return `${settings.value}% remaining`;
  return `${settings.value.toLocaleString()} credits remaining`;
}

function unavailableExplanation(reason: EmailProviderCapacityStatus["reason"]): string {
  if (reason === "permission_denied") {
    return "SendGrid denied access to the credit-balance check. Operational email can still be sent, but early capacity warnings are unavailable until the configured SendGrid access includes permission to read credit balances.";
  }
  if (reason === "not_configured") {
    return "SendGrid capacity monitoring is not configured. Operational email alerts remain separate from this early-warning check.";
  }
  if (reason === "provider_unavailable") {
    return "SendGrid did not return a reliable credit balance. Early capacity warnings are temporarily unavailable, and no operational incident was created.";
  }
  return "The first SendGrid credit-balance check has not completed yet. This page will update after the monitor runs.";
}

const slackFailureLabels: Record<NonNullable<SlackDeliveryHealth["activeFailure"]>["category"], string> = {
  not_configured: "Slack is not configured",
  http_error: "Slack returned an HTTP error",
  slack_error: "Slack rejected the notification",
  transport_error: "Slack could not be reached",
  timeout: "Slack delivery timed out",
};

const slackQueueFailureLabels: Record<NonNullable<SlackDeliveryHealth["queue"]["activeFailure"]>["category"], string> = {
  queue_write_failed: "Slack notifications could not be queued",
  payload_too_large: "A Slack notification was too large to queue",
};

function preserveNewestCapacityStatus(
  current: EmailProviderHealth | undefined,
  incoming: EmailProviderHealth,
): EmailProviderHealth {
  if (!current) return incoming;

  const currentCheckedAt = Date.parse(current.proactiveCapacityMonitoring.checkedAt ?? "");
  const incomingCheckedAt = Date.parse(incoming.proactiveCapacityMonitoring.checkedAt ?? "");
  const currentHasValidCheckTime = !Number.isNaN(currentCheckedAt);
  const incomingHasValidCheckTime = !Number.isNaN(incomingCheckedAt);
  if (!currentHasValidCheckTime || (
    incomingHasValidCheckTime
    && incomingCheckedAt >= currentCheckedAt
  )) {
    return incoming;
  }

  return {
    ...incoming,
    proactiveCapacityMonitoring: current.proactiveCapacityMonitoring,
  };
}

export default function ProviderHealthPage() {
  const { toast } = useToast();
  const router = useRouter();
  const [searchParams, setSearchParams] = useSearchParams();
  const { range: historyDateRange, error: historyUrlError } = readHistoryDateRange(searchParams);
  const historyFromParamValue = searchParams.get(historyFromParam) ?? "";
  const historyToParamValue = searchParams.get(historyToParam) ?? "";
  const hasHistoryDateParams = searchParams.has(historyFromParam) || searchParams.has(historyToParam) || searchParams.has(historyZoneParam);
  const viewerTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [mode, setMode] = useState<EmailProviderHealth["warningSettings"]["mode"]>("default");
  const [value, setValue] = useState("");
  const [warningSettingsDirty, setWarningSettingsDirty] = useState(false);
  useEffect(() => {
    hasUnsavedEmailWarningSettings = warningSettingsDirty;
    return () => {
      hasUnsavedEmailWarningSettings = false;
    };
  }, [warningSettingsDirty]);
  useEffect(() => {
    if (!warningSettingsDirty) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [warningSettingsDirty]);
  useEffect(() => {
    if (!warningSettingsDirty) return;

    const originalAroundNav = router.aroundNav;
    const guardedAroundNav: typeof originalAroundNav = (navigate, to, options) => {
      const destination = new URL(to, window.location.href);
      const staysOnCurrentPage =
        destination.origin === window.location.origin
        && destination.pathname === window.location.pathname;
      if (!staysOnCurrentPage && !window.confirm(unsavedWarningSettingsMessage)) return;
      originalAroundNav(navigate, to, options);
    };

    Object.assign(router, { aroundNav: guardedAroundNav });
    return () => {
      if (router.aroundNav === guardedAroundNav) {
        Object.assign(router, { aroundNav: originalAroundNav });
      }
    };
  }, [router, warningSettingsDirty]);
  const [historyFromDate, setHistoryFromDate] = useState(historyFromParamValue);
  const [historyToDate, setHistoryToDate] = useState(historyToParamValue);
  useEffect(() => {
    setHistoryFromDate(historyFromParamValue);
    setHistoryToDate(historyToParamValue);
  }, [historyFromParamValue, historyToParamValue]);
  const query = useQuery<EmailProviderHealth>({
    queryKey: ["/api/provider-health/email"],
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    structuralSharing: preserveNewestCapacityStatus,
  });
  const slackQuery = useQuery<SlackDeliveryHealth>({
    queryKey: ["/api/provider-health/slack"],
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const historyQuery = useInfiniteQuery({
    queryKey: [...warningHistoryQueryKey, historyDateRange],
    enabled: !historyUrlError,
    queryFn: ({ pageParam }) => {
      const instants = historyDateRange
        ? historyDateRangeToUtcInstants(historyDateRange)
        : undefined;
      return getEmailProviderWarningSettingsHistory({
        limit: warningHistoryPageSize,
        cursor: pageParam,
        fromDate: instants?.fromDate,
        toDate: instants?.toDate,
      });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const exportHistory = useMutation({
    mutationFn: async (range: WarningHistoryDateRange | null) => {
      const response = await apiRequest(
        "GET",
        getExportEmailProviderWarningSettingsHistoryUrl(range ? historyDateRangeToUtcInstants(range) : undefined),
      );
      return response.blob();
    },
    onSuccess: (blob, range) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = range
        ? `email-warning-changes-${range.fromDate}-to-${range.toDate}.csv`
        : "email-warning-changes.csv";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    onError: () => toast({
      title: "Warning changes could not be exported",
      description: "Try again in a moment.",
      variant: "destructive",
    }),
  });
  useEffect(() => {
    if (!query.data || warningSettingsDirty) return;
    setMode(query.data.warningSettings.mode);
    setValue(query.data.warningSettings.value == null ? "" : String(query.data.warningSettings.value));
  }, [query.data, warningSettingsDirty]);
  const saveSettings = useUpdateEmailProviderWarningSettings({
    mutation: {
      onSuccess: async (warningSettings) => {
        await queryClient.cancelQueries({ queryKey: ["/api/provider-health/email"] });
        setMode(warningSettings.mode);
        setValue(warningSettings.value == null ? "" : String(warningSettings.value));
        setWarningSettingsDirty(false);
        queryClient.setQueryData<EmailProviderHealth>(
          ["/api/provider-health/email"],
          (current) => current ? { ...current, warningSettings } : current,
        );
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["/api/provider-health/email"] }),
          queryClient.invalidateQueries({ queryKey: warningHistoryQueryKey }),
        ]);
        toast({ title: "Warning threshold saved" });
      },
      onError: () => toast({
        title: "Warning threshold could not be saved",
        description: "Your changes are still here. Try saving again or discard them.",
        variant: "destructive",
      }),
    },
  });
  const saveWarningSettings = () => {
    const data: EmailProviderWarningSettings = mode === "default"
        ? { mode, value: null }
        : { mode, value: Number(value) };
    saveSettings.mutate({ data });
  };
  const discardWarningSettings = () => {
    if (!query.data) return;
    setMode(query.data.warningSettings.mode);
    setValue(query.data.warningSettings.value == null ? "" : String(query.data.warningSettings.value));
    setWarningSettingsDirty(false);
  };
  const recheckCapacity = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/provider-health/email/recheck");
      return response.json() as Promise<EmailProviderCapacityStatus>;
    },
    onSuccess: (proactiveCapacityMonitoring) => {
      queryClient.setQueryData<EmailProviderHealth>(
        ["/api/provider-health/email"],
        (current) => current ? { ...current, proactiveCapacityMonitoring } : current,
      );
      toast({
        title: proactiveCapacityMonitoring.available
          ? "Email capacity monitoring is available"
          : "Email capacity monitoring is still unavailable",
        description: proactiveCapacityMonitoring.available
          ? "SendGrid returned a reliable credit balance."
          : unavailableExplanation(proactiveCapacityMonitoring.reason),
      });
    },
    onError: (error) => toast({
      title: "Email capacity could not be rechecked",
      description: error instanceof Error ? error.message : "Please wait, then try again.",
      variant: "destructive",
    }),
  });

  if (query.isLoading) {
    return <div className="mx-auto max-w-4xl p-6 text-sm text-muted-foreground">Loading provider health…</div>;
  }

  if (query.isError || !query.data) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <Card className="border-red-200">
          <CardHeader>
            <CardTitle>Provider health could not load</CardTitle>
            <CardDescription>Check your connection, then try again.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => query.refetch()}>Try again</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const status = query.data.proactiveCapacityMonitoring;
  const available = status.available;
  const balance = status.balance;
  const warningHistory = historyQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const invalidHistoryDateRange = Boolean(
    historyFromDate
    && historyToDate
    && isCalendarDate(historyFromDate)
    && isCalendarDate(historyToDate)
    && historyFromDate > historyToDate,
  );
  const validHistoryInput = isCalendarDate(historyFromDate)
    && isCalendarDate(historyToDate)
    && !invalidHistoryDateRange;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6" data-testid="page-provider-health">
      <div>
        <h1 className="flex items-center gap-3 text-3xl font-bold">
          <HeartPulse className="h-8 w-8 text-csd-red" />
          Provider Health
        </h1>
        <p className="mt-1 text-muted-foreground">
          Owner-only visibility into external service monitoring.
        </p>
      </div>

      <Card className={slackQuery.data?.state === "failing" || slackQuery.data?.queue.state === "failing" ? "border-red-200" : "border-emerald-200"}>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Slack notifications</CardTitle>
              <CardDescription>Queue and delivery health for ticket, lead, call, device, and emergency notifications</CardDescription>
            </div>
            {slackQuery.data && (
              <Badge variant={slackQuery.data.state === "failing" || slackQuery.data.queue.state === "failing" ? "destructive" : "secondary"}>
                {slackQuery.data.queue.state === "failing"
                  ? "Queue failing"
                  : slackQuery.data.state === "failing" ? "Delivery failing"
                  : slackQuery.data.state === "healthy" ? "Delivering" : "Waiting for first attempt"}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {slackQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading Slack notification health…</p>
          ) : slackQuery.isError || !slackQuery.data ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-red-900">Slack notification health could not load.</p>
              <Button variant="outline" size="sm" onClick={() => slackQuery.refetch()}>Try again</Button>
            </div>
          ) : (
            <div className="space-y-3">
              {slackQuery.data.queue.activeFailure ? (
                <div className="flex gap-3 rounded-lg border border-red-200 bg-red-50 p-4" data-testid="slack-queue-warning">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-700" />
                  <div>
                    <p className="font-medium text-red-950">
                      {slackQueueFailureLabels[slackQuery.data.queue.activeFailure.category]}
                    </p>
                    <p className="mt-1 text-sm text-red-800">
                      CRM work continues normally, but at least one notification was not saved for Slack delivery.
                      The latest queue failure occurred{" "}
                      {new Date(slackQuery.data.queue.activeFailure.lastFailedAt).toLocaleString()}.
                      A successful enqueue will clear this warning; it will not resend the missed notification.
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {slackQuery.data.queue.state === "healthy"
                    ? "Recent Slack notifications were queued successfully."
                    : "No Slack queue attempt has been recorded yet."}
                </p>
              )}
              {slackQuery.data.activeFailure ? (
                <div className="flex gap-3 rounded-lg border border-red-200 bg-red-50 p-4" data-testid="slack-delivery-warning">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-700" />
                  <div>
                    <p className="font-medium text-red-950">
                      {slackFailureLabels[slackQuery.data.activeFailure.category]}
                    </p>
                    <p className="mt-1 text-sm text-red-800">
                      CRM work continues normally. The latest Slack notification failed{" "}
                      {new Date(slackQuery.data.activeFailure.lastFailedAt).toLocaleString()}.
                      A successful delivery will clear this warning.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
                  <div>
                    <p className="font-medium text-emerald-950">
                      {slackQuery.data.state === "healthy"
                        ? "Recent Slack notifications are delivering"
                        : "No Slack delivery attempt has been recorded yet"}
                    </p>
                    {slackQuery.data.lastSuccessAt && (
                      <p className="mt-1 text-sm text-emerald-800">
                        Last successful delivery {new Date(slackQuery.data.lastSuccessAt).toLocaleString()}.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <SlackTerminalFailures />

      <Card className={available ? "border-emerald-200" : "border-amber-200"}>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>{query.data.provider} email capacity</CardTitle>
              <CardDescription>Proactive warning before sending credits run low</CardDescription>
            </div>
            <Badge variant={available ? "default" : "secondary"}>
              {available ? "Monitoring available" : "Monitoring unavailable"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className={`flex gap-3 rounded-lg border p-4 ${available ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
            {available
              ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
              : <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />}
            <div>
              <p className={`font-medium ${available ? "text-emerald-950" : "text-amber-950"}`}>
                {available ? "Early capacity monitoring is active" : "Early capacity monitoring is unavailable"}
              </p>
              <p className={`mt-1 text-sm ${available ? "text-emerald-800" : "text-amber-800"}`}>
                {available
                  ? "SendGrid is returning a reliable credit balance, so owners can be warned before operational email capacity is exhausted."
                  : unavailableExplanation(status.reason)}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground" data-testid="text-email-capacity-last-checked">
              {status.checkedAt
                ? `Last checked ${new Date(status.checkedAt).toLocaleString()}`
                : "Waiting for the first monitoring check"}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => recheckCapacity.mutate()}
              disabled={recheckCapacity.isPending}
              data-testid="button-recheck-email-capacity"
            >
              {recheckCapacity.isPending ? "Rechecking…" : "Recheck now"}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Monitoring availability is informational. An unavailable check does not create an operational alert.
          </p>
          <div className="space-y-4 border-t pt-4">
            <div>
              <h3 className="font-medium">Low-capacity warning threshold</h3>
              <p className="text-sm text-muted-foreground">
                This changes proactive warnings only. Exhausted-capacity incidents are always reported.
              </p>
            </div>
            <div
              className={`rounded-lg border p-4 ${balance && !balance.stale ? "border-slate-200 bg-slate-50" : "border-amber-200 bg-amber-50"}`}
              data-testid="email-capacity-balance"
            >
              {balance ? (
                <>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-medium">
                      {balance.remaining.toLocaleString()} of {balance.total.toLocaleString()} credits remaining
                    </p>
                    <Badge variant={balance.stale ? "secondary" : "outline"}>
                      {balance.percentage}% remaining
                    </Badge>
                  </div>
                  <p className={`mt-1 text-xs ${balance.stale ? "text-amber-800" : "text-muted-foreground"}`}>
                    {balance.stale ? "Stale reading" : "Current balance"} · checked{" "}
                    {new Date(balance.checkedAt).toLocaleString()}
                  </p>
                </>
              ) : (
                <>
                  <p className="font-medium text-amber-950">Balance unavailable</p>
                  <p className="mt-1 text-xs text-amber-800">
                    No reliable SendGrid credit balance has been checked yet.
                  </p>
                </>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="warning-mode">Warn me based on</Label>
                <Select
                  value={mode}
                  onValueChange={(next) => {
                    setMode(next as typeof mode);
                    setWarningSettingsDirty(true);
                  }}
                >
                  <SelectTrigger id="warning-mode"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">
                      Safe defaults ({query.data.safeDefaults.percentage}% or {query.data.safeDefaults.remainingCredits} credits)
                    </SelectItem>
                    <SelectItem value="percentage">Percentage remaining</SelectItem>
                    <SelectItem value="remainingCredits">Credits remaining</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {mode !== "default" && (
                <div className="space-y-2">
                  <Label htmlFor="warning-value">
                    {mode === "percentage" ? "Percentage remaining" : "Credits remaining"}
                  </Label>
                  <Input
                    id="warning-value"
                    type="number"
                    min={1}
                    max={mode === "percentage" ? 100 : 1_000_000_000}
                    step={1}
                    value={value}
                    onChange={(event) => {
                      setValue(event.target.value);
                      setWarningSettingsDirty(true);
                    }}
                  />
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={saveWarningSettings}
                disabled={saveSettings.isPending || (mode !== "default" && !value)}
              >
                {saveSettings.isPending ? "Saving…" : "Save warning threshold"}
              </Button>
              {warningSettingsDirty && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={discardWarningSettings}
                  disabled={saveSettings.isPending}
                  data-testid="button-discard-email-warning-settings"
                >
                  Discard changes
                </Button>
              )}
            </div>
          </div>
          <div className="space-y-4 border-t pt-4" data-testid="email-warning-history">
            <div className="space-y-3">
              <div>
                <h3 className="font-medium">Recent warning changes</h3>
                <p className="text-sm text-muted-foreground">
                  The newest organization-wide warning threshold changes are shown first.
                </p>
                  <p className="text-sm text-muted-foreground" data-testid="text-email-warning-history-time-zone">
                    Dates use {historyDateRange?.timeZone ?? viewerTimeZone}
                    {historyDateRange
                      ? searchParams.has(historyZoneParam)
                        ? " (saved with this range)."
                        : " (older link; UTC is used for consistent results)."
                      : " (your time zone)."}
                  </p>
              </div>
              <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-slate-50 p-3">
                <div className="space-y-1">
                  <Label htmlFor="warning-history-from-date">From</Label>
                  <Input
                    id="warning-history-from-date"
                    type="date"
                    value={historyFromDate}
                    onChange={(event) => setHistoryFromDate(event.target.value)}
                    className="w-auto bg-white"
                    data-testid="input-warning-history-from-date"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="warning-history-to-date">To</Label>
                  <Input
                    id="warning-history-to-date"
                    type="date"
                    value={historyToDate}
                    onChange={(event) => setHistoryToDate(event.target.value)}
                    className="w-auto bg-white"
                    data-testid="input-warning-history-to-date"
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!validHistoryInput}
                  onClick={() => setSearchParams((current) => {
                    const next = new URLSearchParams(current);
                    next.set(historyFromParam, historyFromDate);
                    next.set(historyToParam, historyToDate);
                     next.set(historyZoneParam, historyDateRange?.timeZone ?? viewerTimeZone);
                    return next;
                  })}
                  data-testid="button-apply-email-warning-history-dates"
                >
                  Show date range
                </Button>
                {hasHistoryDateParams && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setHistoryFromDate("");
                      setHistoryToDate("");
                      setSearchParams((current) => {
                        const next = new URLSearchParams(current);
                        next.delete(historyFromParam);
                        next.delete(historyToParam);
                         next.delete(historyZoneParam);
                        return next;
                      });
                    }}
                    data-testid="button-clear-email-warning-history-dates"
                  >
                    Clear dates
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={Boolean(historyUrlError) || exportHistory.isPending}
                  onClick={() => exportHistory.mutate(historyDateRange)}
                  data-testid="button-export-email-warning-history"
                >
                  {exportHistory.isPending ? "Exporting…" : "Export shown range (CSV)"}
                </Button>
              </div>
              {invalidHistoryDateRange && (
                <p className="text-sm text-red-700">The start date must be on or before the end date.</p>
              )}
              {historyUrlError && (
                <p className="text-sm text-red-700" role="alert" data-testid="text-email-warning-history-url-error">
                  {historyUrlError}
                </p>
              )}
              {historyDateRange && (
                <p className="text-sm font-medium" data-testid="text-email-warning-history-date-range">
                  Showing changes from{" "}
                  <time dateTime={historyDateRange.fromDate}>
                    {historyDateRange.fromDate}
                  </time>
                  {" "}through{" "}
                  <time dateTime={historyDateRange.toDate}>
                    {historyDateRange.toDate}
                  </time>
                  {" "}({historyDateRange.timeZone})
                </p>
              )}
            </div>
            {historyUrlError ? (
              <p className="text-sm text-muted-foreground">Correct or clear the dates to load warning changes.</p>
            ) : historyQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading warning changes…</p>
            ) : historyQuery.isError ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4">
                <p className="text-sm text-red-900">Warning change history could not load.</p>
                <Button variant="outline" size="sm" onClick={() => historyQuery.refetch()}>
                  Try again
                </Button>
              </div>
            ) : warningHistory.length === 0 ? (
              <p className="rounded-lg border bg-slate-50 p-4 text-sm text-muted-foreground">
                {historyDateRange
                  ? "No warning threshold changes were recorded in this date range."
                  : "No warning threshold changes have been recorded yet."}
              </p>
            ) : (
              <div className="divide-y rounded-lg border">
                {warningHistory.map((entry) => (
                  <div className="space-y-2 p-4" key={entry.id}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-medium">
                        {entry.actor.email || entry.actor.userId || "Unknown owner"}
                      </p>
                      <time className="text-xs text-muted-foreground" dateTime={entry.changedAt}>
                        {new Date(entry.changedAt).toLocaleString()}
                      </time>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="rounded bg-slate-100 px-2 py-1 text-slate-700">
                        {describeWarningSettings(entry.previousSettings)}
                      </span>
                      <span className="text-muted-foreground" aria-hidden="true">→</span>
                      <span className="rounded bg-slate-100 px-2 py-1 font-medium text-slate-900">
                        {describeWarningSettings(entry.newSettings)}
                      </span>
                    </div>
                  </div>
                ))}
                {historyQuery.hasNextPage && (
                  <div className="p-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => historyQuery.fetchNextPage()}
                      disabled={historyQuery.isFetchingNextPage}
                      data-testid="button-load-older-email-warning-history"
                    >
                      {historyQuery.isFetchingNextPage ? "Loading older changes…" : "Load older changes"}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}