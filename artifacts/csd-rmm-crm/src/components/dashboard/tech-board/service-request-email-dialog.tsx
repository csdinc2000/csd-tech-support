import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Mail, Send } from "lucide-react";
import { getGetIntakeEmailHistoryQueryKey, useSendIntakeEmail } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { BoardIntake } from "./types";
import { ServiceRequestEmailHistory, useServiceRequestEmailHistory } from "./service-request-email-history";

export function ServiceRequestEmailDialog({ intake, onClose }: { intake: BoardIntake; onClose: () => void }) {
  const [subject, setSubject] = useState(`Regarding your service request #${intake.id}`);
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [acknowledgedHistory, setAcknowledgedHistory] = useState("");
  const queryClient = useQueryClient();
  const history = useServiceRequestEmailHistory(intake.id);
  const riskyAttempts = history.data?.attempts.filter((attempt) => attempt.status !== "rejected") ?? [];
  const historyVersion = riskyAttempts.map((attempt) => `${attempt.id}:${attempt.status}`).join(",");
  const submitting = riskyAttempts.some((attempt) => attempt.status === "submitting");
  const historyReady = history.isSuccess && !history.isError;
  const needsAcknowledgment = !!historyVersion && acknowledgedHistory !== historyVersion;
  const { toast } = useToast();
  const send = useSendIntakeEmail();
  const address = intake.emailAddress?.trim() ?? "";

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (send.isPending || !historyReady || submitting || needsAcknowledgment || !address || !subject.trim() || !body.trim()) return;
    setError("");
    send.mutate(
      { id: intake.id, data: { expectedEmail: address, subject: subject.trim(), body: body.trim() } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getGetIntakeEmailHistoryQueryKey(intake.id) });
          toast({ title: "Email accepted by provider", description: "Customer delivery has not been confirmed. This submission is saved in the send history." });
          onClose();
        },
        onError: () => {
          setAcknowledgedHistory("");
          setError("Submission did not complete normally. The provider may have accepted the email. Refresh and check send history before retrying; do not assume it failed.");
          void queryClient.invalidateQueries({ queryKey: getGetIntakeEmailHistoryQueryKey(intake.id) });
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !send.isPending) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" data-testid="service-request-email-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Mail className="h-5 w-5" /> Email customer</DialogTitle>
          <DialogDescription>Compose a message about service request #{intake.id}. Sending is separate from the customer’s preferred contact method.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <ServiceRequestEmailHistory intakeId={intake.id} />
          {historyVersion && (
            <label className="flex items-start gap-2 rounded-md border border-amber-300 p-2 text-xs text-amber-800">
              <input type="checkbox" className="mt-0.5" checked={!needsAcknowledgment} disabled={send.isPending || submitting} onChange={(event) => setAcknowledgedHistory(event.target.checked ? historyVersion : "")} />
              <span>An earlier email may already have been sent. I checked the history and understand sending again may duplicate a customer email.</span>
            </label>
          )}
          <div>
            <label htmlFor="service-email-to" className="mb-1 block text-sm font-medium">To</label>
            <Input id="service-email-to" value={address} readOnly aria-readonly="true" />
            {intake.contactPreference?.toLowerCase() !== "email" && (
              <p className="mt-1 text-xs text-amber-700">This customer prefers {intake.contactPreference} contact.</p>
            )}
          </div>
          <div>
            <label htmlFor="service-email-subject" className="mb-1 block text-sm font-medium">Subject</label>
            <Input id="service-email-subject" value={subject} maxLength={200} onChange={(event) => setSubject(event.target.value)} />
          </div>
          <div>
            <label htmlFor="service-email-body" className="mb-1 block text-sm font-medium">Message</label>
            <Textarea id="service-email-body" value={body} maxLength={10000} rows={8} onChange={(event) => setBody(event.target.value)} placeholder="Write your message to the customer…" />
          </div>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" disabled={send.isPending} onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={send.isPending || !historyReady || submitting || needsAcknowledgment || !address || !subject.trim() || !body.trim()}>
              <Send className="mr-2 h-4 w-4" />{send.isPending ? "Sending…" : "Send email"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}