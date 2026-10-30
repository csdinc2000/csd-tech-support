import {
  getListSlackTerminalFailuresQueryKey,
  useListSlackTerminalFailures,
  useRetrySlackTerminalFailure,
  type SlackTerminalFailure,
} from "@workspace/api-client-react";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const eventLabels: Record<SlackTerminalFailure["type"], string> = {
  ticket: "Ticket",
  intake: "Service request",
  call: "Call",
  device_alert: "Device alert",
  emergency: "Emergency alert",
};

const failureLabels: Record<SlackTerminalFailure["category"], string> = {
  not_configured: "Slack is not configured",
  http_error: "HTTP error",
  slack_error: "Slack rejected the notice",
  transport_error: "Connection error",
  timeout: "Timed out",
};

export function SlackTerminalFailures() {
  const { toast } = useToast();
  const failures = useListSlackTerminalFailures({
    query: { queryKey: getListSlackTerminalFailuresQueryKey(), refetchInterval: 60_000, refetchOnWindowFocus: true },
  });
  const retry = useRetrySlackTerminalFailure({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListSlackTerminalFailuresQueryKey() });
        toast({ title: "Recovery notice queued", description: "The original message was cleared and cannot be resent. Only event metadata will be sent." });
      },
      onError: () => toast({
        title: "Could not queue recovery notice",
        description: "Refresh the list and try again.",
        variant: "destructive",
      }),
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Slack notices needing attention</CardTitle>
        <CardDescription>
          Last 50 notices that exhausted automatic attempts. Recovery sends only the event type and failure time, not the original message.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {failures.isLoading ? <p className="text-sm text-muted-foreground">Loading failures…</p>
          : failures.isError ? (
            <div className="flex items-center justify-between gap-3 text-sm">
              <span>Could not load Slack failures.</span>
              <Button size="sm" variant="outline" onClick={() => failures.refetch()}>Try again</Button>
            </div>
          ) : failures.data?.length === 0 ? (
            <p className="text-sm text-muted-foreground">No terminal Slack failures.</p>
          ) : failures.data?.map((failure) => (
            <div key={failure.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
              <div>
                <p className="font-medium">{eventLabels[failure.type]} · {failureLabels[failure.category]}</p>
                <p className="text-muted-foreground">
                  Failed {new Date(failure.failedAt).toLocaleString()}
                  {failure.retryRequestedAt && ` · Recovery requested ${new Date(failure.retryRequestedAt).toLocaleString()}`}
                </p>
              </div>
              {failure.retryId == null ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={retry.isPending}
                  onClick={() => retry.mutate({ id: failure.id })}
                >
                  Request recovery
                </Button>
              ) : <span className="text-muted-foreground">Recovery requested</span>}
            </div>
          ))}
      </CardContent>
    </Card>
  );
}