import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import {
  CheckCircle2, Loader2, Lock, MessageSquare, PhoneIncoming, PhoneMissed, PhoneOutgoing,
  RotateCcw, Search, Send, StickyNote, Trash2, User as UserIcon, Voicemail,
} from "lucide-react";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CallViaCsdButton } from "@/components/communications/call-via-csd-button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

/** What customers see on every text and call from the team. */
export const MAIN_LINE_DISPLAY = "(954) 637-7300";

export type InboxFilter = "open" | "mine" | "unassigned" | "done" | "all";

export type InboxConversation = {
  conversationId: number | null;
  threadKey: string;
  customerNumber: string;
  contactId: number | null;
  contactName: string | null;
  status: "open" | "done";
  assignedUserId: string | null;
  assignedName: string | null;
  lastMessage: string;
  lastDirection: string;
  lastSentBy: string | null;
  lastAt: string;
  messageCount: number;
  unread: boolean;
};

type InboxResponse = {
  conversations: InboxConversation[];
  counts: Record<InboxFilter | "unread", number>;
  currentUserId: string | null;
};

type TimelineItem =
  | { kind: "message"; id: string; at: string; body: string; direction: string; status: string | null; errorCode: string | null; sentBy: string | null }
  | { kind: "note"; id: string; at: string; body: string; author: string }
  | { kind: "call"; id: string; at: string; direction: string; status: string; durationSeconds: number; hadVoicemail: boolean }
  | { kind: "voicemail"; id: string; voicemailId: number; at: string; durationSeconds: number; transcription: string | null; listened: boolean };

type TimelineResponse = {
  conversation: Omit<InboxConversation, "lastMessage" | "lastDirection" | "lastSentBy" | "lastAt" | "messageCount" | "unread">;
  items: TimelineItem[];
};

type Assignee = { id: string; name: string };

const FILTERS: { value: InboxFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "mine", label: "Mine" },
  { value: "unassigned", label: "Unassigned" },
  { value: "done", label: "Done" },
  { value: "all", label: "All" },
];

const MISSED_CALL_STATUSES = new Set(["no-answer", "busy", "failed", "canceled"]);
const UNASSIGNED = "__unassigned__";

export function formatPhone(num: string): string {
  const digits = num.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : num;
}

/** Same key the server uses: digits without the US leading 1. */
export function threadKeyFor(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
}

function formatDuration(seconds: number): string {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

function invalidateInbox(threadKey?: string | null) {
  void queryClient.invalidateQueries({ queryKey: ["/api/sms/inbox"] });
  if (threadKey) void queryClient.invalidateQueries({ queryKey: ["/api/sms/inbox/thread", threadKey] });
}

/**
 * Shared team inbox for the single CSD business line: every customer is one
 * conversation with an owner, open/done state, per-tech unread, "sent by" on
 * replies, team-only notes, and their calls/voicemails on the same timeline.
 */
export function SharedInbox({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (threadKey: string | null) => void;
}) {
  const [filter, setFilter] = useState<InboxFilter>("open");
  const [search, setSearch] = useState("");

  const inboxQuery = useQuery<InboxResponse>({
    queryKey: ["/api/sms/inbox", filter],
    queryFn: async () => (await apiRequest("GET", `/api/sms/inbox?filter=${filter}`)).json(),
    refetchInterval: 10_000,
  });
  const conversations = inboxQuery.data?.conversations ?? [];
  const counts = inboxQuery.data?.counts;
  const currentUserId = inboxQuery.data?.currentUserId ?? null;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conversations;
    const digits = q.replace(/\D/g, "");
    return conversations.filter((c) =>
      (c.contactName?.toLowerCase().includes(q) ?? false) ||
      c.lastMessage.toLowerCase().includes(q) ||
      (digits.length >= 3 && c.threadKey.includes(digits)),
    );
  }, [conversations, search]);

  return (
    <div className="grid h-[calc(100vh-220px)] min-h-[500px] grid-cols-1 gap-4 md:grid-cols-[340px_1fr]" data-testid="shared-inbox">
      <Card className={cn("flex-col overflow-hidden", selected ? "hidden md:flex" : "flex")}>
        <CardHeader className="space-y-2 pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Team inbox</CardTitle>
            {counts?.unread ? (
              <Badge className="bg-csd-red text-white hover:bg-csd-red" data-testid="inbox-unread-count">{counts.unread} unread</Badge>
            ) : null}
          </div>
          <div className="flex gap-1 overflow-x-auto pb-0.5" role="tablist" aria-label="Inbox filter">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={filter === f.value}
                onClick={() => setFilter(f.value)}
                data-testid={`inbox-filter-${f.value}`}
                className={cn(
                  "shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                  filter === f.value ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200",
                )}
              >
                {f.label}
                {counts && f.value !== "all" ? <span className="ml-1 tabular-nums opacity-70">{counts[f.value]}</span> : null}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search name, number or text…" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="input-search-threads" />
          </div>
        </CardHeader>
        <ScrollArea className="flex-1">
          <div className="space-y-1 px-2 pb-2">
            {inboxQuery.isLoading ? (
              <div className="flex items-center justify-center p-6 text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…</div>
            ) : visible.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {filter === "mine" ? "Nothing assigned to you." : filter === "open" ? "Inbox zero — no open conversations." : "No conversations."}
              </div>
            ) : (
              visible.map((c) => (
                <ConversationRow key={c.threadKey} conversation={c} active={c.threadKey === selected} currentUserId={currentUserId} onClick={() => onSelect(c.threadKey)} />
              ))
            )}
          </div>
        </ScrollArea>
      </Card>

      <Card className={cn("flex-col overflow-hidden", !selected ? "hidden md:flex" : "flex")}>
        {selected ? (
          <ConversationPane key={selected} threadKey={selected} currentUserId={currentUserId} onBack={() => onSelect(null)} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
            <MessageSquare className="h-8 w-8 text-gray-300" />
            <p>Select a conversation.</p>
            <p className="text-xs">Every reply goes out from the CSD main line {MAIN_LINE_DISPLAY}.</p>
          </div>
        )}
      </Card>
    </div>
  );
}

function ConversationRow({
  conversation: c,
  active,
  currentUserId,
  onClick,
}: {
  conversation: InboxConversation;
  active: boolean;
  currentUserId: string | null;
  onClick: () => void;
}) {
  const preview = c.lastDirection === "outbound" ? `${c.lastSentBy ?? "CSD"}: ${c.lastMessage}` : c.lastMessage;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`thread-${c.threadKey}`}
      className={cn("w-full rounded-md p-2 text-left transition-colors hover:bg-muted", active && "bg-muted")}
    >
      <div className="flex items-center justify-between gap-2">
        <div className={cn("flex min-w-0 items-center gap-1.5", c.unread ? "font-semibold text-gray-900" : "font-medium")}>
          {c.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-csd-red" aria-label="Unread" />}
          {c.contactName && <UserIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <span className="truncate">{c.contactName || formatPhone(c.customerNumber)}</span>
        </div>
        <span className="whitespace-nowrap text-[10px] text-muted-foreground">{formatDistanceToNow(new Date(c.lastAt))}</span>
      </div>
      <div className={cn("truncate text-xs", c.unread ? "text-gray-800" : "text-muted-foreground")}>{preview}</div>
      <div className="mt-1 flex items-center gap-1.5 text-[10px]">
        {c.status === "done" ? (
          <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-700">Done</span>
        ) : null}
        <span className={cn(
          "rounded px-1.5 py-0.5 font-medium",
          !c.assignedUserId ? "bg-amber-50 text-amber-800" : c.assignedUserId === currentUserId ? "bg-blue-50 text-blue-700" : "bg-gray-100 text-gray-600",
        )}>
          {!c.assignedUserId ? "Unassigned" : c.assignedUserId === currentUserId ? "You" : c.assignedName}
        </span>
        {c.contactName && <span className="truncate text-muted-foreground">{formatPhone(c.customerNumber)}</span>}
      </div>
    </button>
  );
}

function ConversationPane({
  threadKey,
  currentUserId,
  onBack,
}: {
  threadKey: string;
  currentUserId: string | null;
  onBack: () => void;
}) {
  const { toast } = useToast();
  const [mode, setMode] = useState<"text" | "note">("text");
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  const timelineQuery = useQuery<TimelineResponse>({
    queryKey: ["/api/sms/inbox/thread", threadKey],
    queryFn: async () => (await apiRequest("GET", `/api/sms/inbox/${encodeURIComponent(threadKey)}`)).json(),
    refetchInterval: 8_000,
  });
  const assigneesQuery = useQuery<Assignee[]>({ queryKey: ["/api/sms/inbox/assignees"], staleTime: 60_000 });
  const conversation = timelineQuery.data?.conversation;
  const items = timelineQuery.data?.items ?? [];
  const lastInboundAt = [...items].reverse().find((i) => i.kind === "message" && i.direction === "inbound")?.at;

  // Opening a conversation (or a new customer text arriving while it's open) marks it read for me.
  useEffect(() => {
    if (!conversation) return;
    void apiRequest("POST", `/api/sms/inbox/${encodeURIComponent(threadKey)}/read`)
      .then(() => queryClient.invalidateQueries({ queryKey: ["/api/sms/inbox"] }))
      .catch(() => {});
  }, [threadKey, conversation?.conversationId, lastInboundAt]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items.length]);

  const update = useMutation({
    mutationFn: async (patch: { status?: "open" | "done"; assignedUserId?: string | null }) =>
      apiRequest("PATCH", `/api/sms/inbox/${encodeURIComponent(threadKey)}`, patch),
    onSuccess: () => invalidateInbox(threadKey),
    onError: (e: Error) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const send = useMutation({
    mutationFn: async () => {
      const body = draft.trim();
      if (mode === "note") return apiRequest("POST", `/api/sms/inbox/${encodeURIComponent(threadKey)}/notes`, { body });
      return apiRequest("POST", "/api/sms/send", { to: conversation!.customerNumber, body });
    },
    onSuccess: () => {
      setDraft("");
      invalidateInbox(threadKey);
      if (mode === "text") toast({ title: "Text sent from the CSD main line" });
    },
    onError: (e: Error) => toast({ title: mode === "note" ? "Note not saved" : "Send failed", description: e.message, variant: "destructive" }),
  });

  const deleteThread = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/sms/threads/${encodeURIComponent(conversation!.customerNumber)}`),
    onSuccess: () => { invalidateInbox(threadKey); onBack(); toast({ title: "Conversation deleted" }); },
    onError: (e: Error) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  if (timelineQuery.isLoading || !conversation) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        {timelineQuery.error ? "Conversation not found." : <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…</>}
      </div>
    );
  }

  const submit = () => { if (draft.trim() && !send.isPending) send.mutate(); };
  const assignees = assigneesQuery.data ?? [];

  return (
    <>
      <CardHeader className="space-y-2 border-b py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Button type="button" variant="ghost" size="sm" className="-ml-2 h-8 px-2 md:hidden" onClick={onBack} aria-label="Back to conversations">‹ Back</Button>
            <div className="min-w-0">
              <CardTitle className="truncate text-base" data-testid="conversation-title">
                {conversation.contactName || formatPhone(conversation.customerNumber)}
              </CardTitle>
              <div className="truncate text-xs text-muted-foreground">{formatPhone(conversation.customerNumber)}</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <CallViaCsdButton phone={conversation.customerNumber} contactId={conversation.contactId ?? undefined} size="sm" />
            {conversation.status === "open" ? (
              <Button size="sm" variant="outline" className="h-8" onClick={() => update.mutate({ status: "done" })} disabled={update.isPending} data-testid="button-mark-done">
                <CheckCircle2 className="mr-1 h-4 w-4" /> Done
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="h-8" onClick={() => update.mutate({ status: "open" })} disabled={update.isPending} data-testid="button-reopen">
                <RotateCcw className="mr-1 h-4 w-4" /> Reopen
              </Button>
            )}
            <Button
              type="button" variant="ghost" size="sm" className="h-8 px-2 text-red-600 hover:bg-red-50 hover:text-red-700"
              onClick={() => { if (window.confirm("Delete this entire conversation? This cannot be undone.")) deleteThread.mutate(); }}
              disabled={deleteThread.isPending} aria-label="Delete conversation" data-testid="button-delete-thread"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Owner</span>
          <Select
            value={conversation.assignedUserId ?? UNASSIGNED}
            onValueChange={(value) => update.mutate({ assignedUserId: value === UNASSIGNED ? null : value })}
          >
            <SelectTrigger className="h-7 w-44 text-xs" data-testid="select-assignee"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
              {assignees.map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.id === currentUserId ? `${a.name} (me)` : a.name}</SelectItem>
              ))}
              {conversation.assignedUserId && !assignees.some((a) => a.id === conversation.assignedUserId) && (
                <SelectItem value={conversation.assignedUserId}>{conversation.assignedName ?? "Former staff"}</SelectItem>
              )}
            </SelectContent>
          </Select>
          {currentUserId && conversation.assignedUserId !== currentUserId && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => update.mutate({ assignedUserId: currentUserId })} data-testid="button-assign-me">
              Assign to me
            </Button>
          )}
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600" title="Customers only ever see the main business number">
            <Lock className="h-3 w-3" /> Customer sees {MAIN_LINE_DISPLAY}
          </span>
        </div>
      </CardHeader>

      <ScrollArea className="flex-1 px-4 py-3">
        <div className="space-y-2" data-testid="conversation-timeline">
          {items.map((item) => <TimelineEntry key={item.id} item={item} />)}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      <div className={cn("border-t p-3", mode === "note" && "bg-amber-50/60")}>
        <div className="mb-2 flex items-center gap-1" role="tablist" aria-label="Reply type">
          <button type="button" role="tab" aria-selected={mode === "text"} onClick={() => setMode("text")} data-testid="composer-mode-text"
            className={cn("whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium", mode === "text" ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100")}>
            <MessageSquare className="mr-1 inline h-3.5 w-3.5" /> Text customer
          </button>
          <button type="button" role="tab" aria-selected={mode === "note"} onClick={() => setMode("note")} data-testid="composer-mode-note"
            className={cn("whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium", mode === "note" ? "bg-amber-500 text-white" : "text-gray-600 hover:bg-gray-100")}>
            <StickyNote className="mr-1 inline h-3.5 w-3.5" /> Team note
          </button>
          <span className="ml-auto hidden text-[11px] text-muted-foreground sm:inline">
            {mode === "text" ? `Sends from ${MAIN_LINE_DISPLAY} · signed by you in the inbox` : "Only your team sees notes"}
          </span>
        </div>
        <div className="flex items-end gap-2">
          <Textarea
            placeholder={mode === "text" ? "Text the customer…" : "Add a note for the team (never sent to the customer)…"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
            rows={2}
            maxLength={mode === "text" ? 1600 : 2000}
            className="flex-1 resize-none bg-white"
            data-testid="input-reply-body"
          />
          <Button onClick={submit} disabled={send.isPending || !draft.trim()} className={cn(mode === "note" && "bg-amber-500 hover:bg-amber-600")} data-testid="button-send-reply">
            {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === "note" ? <StickyNote className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </>
  );
}

function TimelineEntry({ item }: { item: TimelineItem }) {
  const time = format(new Date(item.at), "MMM d, h:mm a");
  if (item.kind === "message") {
    const out = item.direction === "outbound";
    return (
      <div className={cn("flex", out ? "justify-end" : "justify-start")}>
        <div
          className={cn("max-w-[75%] rounded-2xl px-3 py-2 text-sm", out ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm bg-muted")}
          data-testid={`msg-${item.id}`}
        >
          <div className="whitespace-pre-wrap break-words">{item.body}</div>
          <div className={cn("mt-1 text-[10px]", out ? "text-primary-foreground/70" : "text-muted-foreground")}>
            {out ? `${item.sentBy ?? "CSD (automated)"} · ` : ""}{time}
            {out && item.status ? ` · ${item.status}` : ""}
            {out && item.errorCode ? (
              <span className="font-medium text-red-300" title={item.errorCode === "30034" ? "Error 30034 — sender not registered for A2P 10DLC." : `Twilio carrier error ${item.errorCode}`}>
                {` · err ${item.errorCode}`}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    );
  }
  if (item.kind === "note") {
    return (
      <div className="mx-auto max-w-[85%] rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950" data-testid={`note-${item.id}`}>
        <div className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold text-amber-800">
          <StickyNote className="h-3 w-3" /> Team note · {item.author} · {time}
        </div>
        <div className="whitespace-pre-wrap break-words">{item.body}</div>
      </div>
    );
  }
  if (item.kind === "call") {
    const missed = MISSED_CALL_STATUSES.has(item.status);
    const Icon = missed ? PhoneMissed : item.direction === "outbound" ? PhoneOutgoing : PhoneIncoming;
    const label = missed
      ? `Missed ${item.direction === "outbound" ? "outgoing " : ""}call`
      : `${item.direction === "outbound" ? "Outgoing" : "Incoming"} call${item.durationSeconds ? ` · ${formatDuration(item.durationSeconds)}` : ""}`;
    return (
      <div className="flex justify-center" data-testid={`call-${item.id}`}>
        <span className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs", missed ? "bg-red-50 text-red-700" : "bg-gray-100 text-gray-600")}>
          <Icon className="h-3.5 w-3.5" /> {label} · {time}
        </span>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-[85%] rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-950" data-testid={`voicemail-${item.id}`}>
      <div className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold text-blue-800">
        <Voicemail className="h-3 w-3" /> Voicemail{item.durationSeconds ? ` · ${formatDuration(item.durationSeconds)}` : ""} · {time}
        {!item.listened && <span className="ml-1 rounded bg-blue-600 px-1 text-[10px] text-white">New</span>}
      </div>
      <div className="whitespace-pre-wrap break-words">{item.transcription || "No transcription."}</div>
      <Link href="/comms/voicemails" className="mt-1 inline-block text-xs font-medium text-blue-700 hover:underline">Listen in Voicemails</Link>
    </div>
  );
}
