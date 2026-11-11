import { getGetIntakeEmailHistoryQueryKey, useGetIntakeEmailHistory } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

export function useServiceRequestEmailHistory(intakeId: number) {
  return useGetIntakeEmailHistory(intakeId, {
    query: { queryKey: getGetIntakeEmailHistoryQueryKey(intakeId), staleTime: 0, refetchOnMount: "always", refetchInterval: 5000, retry: false },
  });
}

const labels = {
  submitting: "Submission in progress",
  accepted: "Accepted by provider — delivery unconfirmed",
  rejected: "Not accepted by provider",
  unknown: "Submission outcome unknown — check before retrying",
};

export function ServiceRequestEmailHistory({ intakeId }: { intakeId: number }) {
  const history = useServiceRequestEmailHistory(intakeId);
  return (
    <div className="space-y-2 text-sm" data-testid="service-request-email-history">
      <p className="font-medium">Email send history</p>
      <p className="text-xs text-muted-foreground">Provider acceptance does not confirm the customer received the email. History starts when send tracking was enabled; earlier emails are not recorded.</p>
      {history.isPending ? <p role="status">Loading send history…</p> : history.isError ? (
        <div role="alert">
          <p>Send history is unavailable. Check it before retrying an email.</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void history.refetch()}>Refresh history</Button>
        </div>
      ) : !history.data?.attempts.length ? (
        <p className="text-muted-foreground">No tracked email attempts for this request.</p>
      ) : (
        <ol className="max-h-48 space-y-2 overflow-y-auto" aria-label="Email submission attempts">
          {history.data.attempts.map((attempt) => (
            <li key={attempt.id} className="rounded-md border p-2">
              <p className={attempt.status === "unknown" || attempt.status === "submitting" ? "font-medium text-amber-700" : "font-medium"}>{labels[attempt.status]}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(attempt.createdAt).toLocaleString()} · {attempt.senderName} · {attempt.provider}
              </p>
              <p className="text-xs">{attempt.outcome}</p>
              {attempt.messageId && <p className="break-all text-xs text-muted-foreground">Provider message ID: {attempt.messageId}</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}