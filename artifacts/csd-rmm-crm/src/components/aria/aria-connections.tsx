import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, MessageSquare, Phone, AlertTriangle, Loader2, Search, Inbox, PenLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { apiRequest } from '@/lib/queryClient';
import type { AriaConnections as Connections, TestAriaConnections200 as TestResult, AriaOutboundAction as AriaAction } from '@workspace/api-client-react';

const EXAMPLES = [
  { icon: Inbox, text: 'Read my latest unread inbox emails and summarize them' },
  { icon: Search, text: 'Find the CRM contact for a customer and show their recent activity' },
  { icon: PenLine, text: 'Draft an email to a customer about their repair status' },
  { icon: MessageSquare, text: 'Draft a text message reminding a customer their device is ready' },
  { icon: Phone, text: 'Draft a call message for a customer about an overdue invoice' },
];

export function AriaConnections({
  conversationId,
  isStreaming,
  onPrompt,
}: {
  conversationId: number | null;
  isStreaming: boolean;
  onPrompt?: (text: string) => void;
}) {
  const qc = useQueryClient();
  const [test, setTest] = useState<TestResult | null>(null);

  const conn = useQuery<Connections>({
    queryKey: ['/api/aria/connections'],
    queryFn: async () => (await apiRequest('GET', '/api/aria/connections')).json(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const canUse = conn.data?.canUseMailbox === true;
  const actionsKey = ['/api/aria/actions', 'conversation', conversationId];
  const actions = useQuery<{ actions: AriaAction[] }>({
    queryKey: actionsKey,
    enabled: canUse && conversationId != null,
    refetchInterval: isStreaming ? 3000 : 10000,
    queryFn: async () =>
      (await apiRequest('GET', `/api/aria/actions?conversationId=${conversationId}`)).json(),
  });

  const testMut = useMutation({
    mutationFn: async () => (await apiRequest('POST', '/api/aria/connections/test', {})).json() as Promise<TestResult>,
    onSuccess: setTest,
  });

  const act = useMutation({
    mutationFn: async ({ id, op }: { id: string; op: 'confirm' | 'cancel'; conversationId: number }) =>
      (await apiRequest('POST', `/api/aria/actions/${id}/${op}`, {})).json() as Promise<{ action: AriaAction }>,
    onSuccess: ({ action }, variables) => {
      const completedKey = ['/api/aria/actions', 'conversation', variables.conversationId];
      qc.setQueryData<{ actions: AriaAction[] }>(completedKey, (old) =>
        old ? { actions: old.actions.map((a) => (a.id === action.id ? action : a)) } : old,
      );
      qc.invalidateQueries({ queryKey: completedKey });
    },
  });

  const list = canUse ? actions.data?.actions ?? [] : [];

  return (
    <div className="border-b bg-white px-4 md:px-6 py-3 space-y-3" data-testid="aria-connections">
      {conn.isLoading ? (
        <p className="text-xs text-gray-500" data-testid="text-connections-loading">Checking connections...</p>
      ) : conn.isError || !conn.data ? (
        <div className="flex items-center gap-2 text-xs text-red-600" data-testid="text-connections-error">
          Could not load connection state.
          <Button size="sm" variant="outline" onClick={() => conn.refetch()} data-testid="button-retry-connections">
            Retry
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary" className="gap-1" data-testid="status-mailbox">
            <Mail className="h-3 w-3" />
            {conn.data.mailbox.configured
              ? `Mailbox: ${conn.data.mailbox.user ?? 'configured'}${conn.data.mailbox.host ? ` @ ${conn.data.mailbox.host}` : ''}`
              : 'Mailbox not configured'}
          </Badge>
          <Badge variant="secondary" className="gap-1" data-testid="status-twilio">
            <Phone className="h-3 w-3" />
            {conn.data.twilio.configured ? 'Twilio configured' : 'Twilio not configured'}
          </Badge>
          {canUse ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => testMut.mutate()}
              disabled={testMut.isPending}
              data-testid="button-test-connections"
            >
              {testMut.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              Test mailbox (does not send)
            </Button>
          ) : (
            <span className="text-gray-500" data-testid="text-mailbox-unavailable">
              Mailbox tools and outbound actions require administrator communications access.
            </span>
          )}
        </div>
      )}

      {canUse && testMut.isError && (
        <p className="text-xs text-red-600" data-testid="text-test-error">Connection test failed to run.</p>
      )}
      {canUse && test && (
        <div className="text-xs space-y-0.5" data-testid="text-test-result">
          <p className={test.imap.ok ? 'text-green-700' : 'text-red-600'}>
            IMAP: {test.imap.ok ? 'OK' : `Failed${test.imap.error ? ` - ${test.imap.error}` : ''}`}
          </p>
          <p className={test.smtp.ok ? 'text-green-700' : 'text-red-600'}>
            SMTP: {test.smtp.ok ? 'OK' : `Failed${test.smtp.error ? ` - ${test.smtp.error}` : ''}`}
          </p>
        </div>
      )}

      {canUse && conversationId != null && actions.isLoading && (
        <p className="text-xs text-gray-500">Loading outbound actions...</p>
      )}
      {canUse && actions.isError && (
        <div className="flex items-center gap-2 text-xs text-red-600" data-testid="text-actions-error">
          Could not load outbound actions.
          <Button size="sm" variant="outline" onClick={() => actions.refetch()} data-testid="button-retry-actions">
            Retry
          </Button>
        </div>
      )}
      {act.isError && <p className="text-xs text-red-600" data-testid="text-action-error">Action request failed. Nothing was retried.</p>}

      {list.map((a) => (
        <div key={a.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm space-y-2" data-testid={`card-action-${a.id}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium uppercase text-xs text-gray-700">Review {a.kind}</span>
            <Badge variant="secondary" data-testid={`status-action-${a.id}`}>{a.status}</Badge>
          </div>
          <div className="text-xs text-gray-600">To: <span className="text-gray-900">{a.to}</span></div>
          {a.subject && <div className="text-xs text-gray-600">Subject: <span className="text-gray-900">{a.subject}</span></div>}
          <div className="whitespace-pre-wrap rounded border bg-white p-2 text-gray-900">{a.body}</div>
          {a.kind === 'call' && (
            <p className="text-xs text-amber-700 flex items-start gap-1" data-testid={`warn-call-${a.id}`}>
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              This call will speak the reviewed message above. It does not start a live AI conversation.
            </p>
          )}
          {a.status === 'uncertain' && (
            <p className="text-xs text-amber-700 flex items-start gap-1" data-testid={`warn-uncertain-${a.id}`}>
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              Outcome uncertain: it may or may not have been delivered. Verify before sending again; it will not be retried automatically.
            </p>
          )}
          {a.result && <p className="text-xs text-gray-600">{a.result}</p>}
          {a.status === 'pending' && (
            <>
              <p className="text-xs text-gray-500">Expires {new Date(a.expiresAt).toLocaleString()}</p>
              <div className="flex gap-2">
                <Button size="sm" disabled={act.isPending || new Date(a.expiresAt).getTime() <= Date.now()} onClick={() => conversationId != null && act.mutate({ id: a.id, op: 'confirm', conversationId })} data-testid={`button-confirm-${a.id}`}>
                  {a.kind === 'call' ? 'Confirm and call' : 'Confirm and send'}
                </Button>
                <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => conversationId != null && act.mutate({ id: a.id, op: 'cancel', conversationId })} data-testid={`button-cancel-${a.id}`}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      ))}

      {canUse && (
        <div className="flex flex-wrap gap-2" data-testid="aria-example-prompts">
          {EXAMPLES.map((e, i) => {
            const Icon = e.icon;
            return (
              <button
                key={i}
                type="button"
                disabled={isStreaming || !onPrompt}
                onClick={() => onPrompt?.(e.text)}
                className="flex items-center gap-1 rounded-full border border-gray-200 px-3 py-1 text-xs text-gray-700 hover:border-primary disabled:opacity-50"
                data-testid={`button-example-${i}`}
              >
                <Icon className="h-3 w-3 text-primary" />
                {e.text}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
