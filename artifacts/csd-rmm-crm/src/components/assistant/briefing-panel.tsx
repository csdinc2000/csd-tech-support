import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle, CalendarClock, CalendarDays, FileSearch, Loader2, PhoneCall, Sparkles, Square, Target, Ticket, UserPlus, Volume2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  formatBriefingDate, formatDue, formatTime, formatWaiting, narrativeSpeech,
  type AssistantTask, type BriefingNarrative, type BriefingResponse,
} from "@/lib/executive-assistant";

export const BRIEFING_QUERY_KEY = ["/api/assistant/briefing"] as const;

export function useBriefing(refetchInterval: number | false = 60_000) {
  return useQuery<BriefingResponse>({
    queryKey: BRIEFING_QUERY_KEY,
    queryFn: async () => (await apiRequest("GET", "/api/assistant/briefing")).json(),
    refetchInterval,
    staleTime: 30_000,
  });
}

function Section({ title, icon: Icon, testId, action, children }: {
  title: string; icon: typeof Sparkles; testId: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section data-testid={testId} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-800">
          <Icon className="h-4 w-4 text-red-600" aria-hidden="true" />
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function TaskLine({ task, tone }: { task: AssistantTask; tone: "overdue" | "today" | "upcoming" }) {
  return (
    <li className="flex items-start justify-between gap-3 rounded-md border bg-white px-3 py-2 text-sm">
      <span className={cn("min-w-0 break-words", tone === "overdue" && "font-medium text-red-700")}>{task.title}</span>
      {task.dueAt && (
        <span className={cn("shrink-0 text-xs", tone === "overdue" ? "text-red-600" : "text-gray-500")}>{formatDue(task.dueAt)}</span>
      )}
    </li>
  );
}

function useSpeech() {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [speaking, setSpeaking] = useState(false);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  useEffect(() => () => { if (supported) window.speechSynthesis.cancel(); }, [supported]);
  return {
    supported,
    speaking,
    speak(text: string) {
      if (!supported) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.onend = () => setSpeaking(false);
      u.onerror = () => setSpeaking(false);
      utterance.current = u;
      setSpeaking(true);
      window.speechSynthesis.speak(u);
    },
    stop() {
      if (supported) window.speechSynthesis.cancel();
      setSpeaking(false);
    },
  };
}

export function BriefingPanel() {
  const { data, isLoading, isError, refetch } = useBriefing();
  const speech = useSpeech();
  const narrative = useMutation<{ narrative: BriefingNarrative }>({
    mutationFn: async () => (await apiRequest("POST", "/api/assistant/briefing/narrative")).json(),
  });

  if (isLoading) {
    return (
      <Card><CardContent className="flex items-center gap-2 p-6 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading your briefing…
      </CardContent></Card>
    );
  }
  if (isError || !data) {
    return (
      <Card><CardContent className="space-y-3 p-6 text-sm">
        <p className="text-red-700">Your briefing could not be loaded.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>Try again</Button>
      </CardContent></Card>
    );
  }

  const { briefing, aiConfigured } = data;
  const { tasks } = briefing;
  const noTasks = tasks.overdue.length + tasks.today.length + tasks.upcoming.length === 0;
  const n = narrative.data?.narrative;

  return (
    <Card data-testid="assistant-briefing">
      <CardHeader className="space-y-1 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-lg">Daily briefing</CardTitle>
            <p className="text-sm text-gray-500" data-testid="briefing-date">{formatBriefingDate(briefing.date)}</p>
          </div>
          {aiConfigured && (
            <div className="flex gap-2">
              <Button
                size="sm"
                className="bg-red-600 hover:bg-red-700"
                onClick={() => narrative.mutate(undefined, {
                  onSuccess: (res) => speech.speak(narrativeSpeech(res.narrative)),
                })}
                disabled={narrative.isPending}
                data-testid="briefing-narrative-button"
              >
                {narrative.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                Have Aria brief me
              </Button>
              {speech.supported && n && (speech.speaking ? (
                <Button size="sm" variant="outline" onClick={speech.stop} aria-label="Stop reading">
                  <Square className="mr-2 h-4 w-4" /> Stop
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => speech.speak(narrativeSpeech(n))} aria-label="Read briefing aloud">
                  <Volume2 className="mr-2 h-4 w-4" /> Play
                </Button>
              ))}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {narrative.isError && <p className="text-sm text-red-700">Aria couldn't prepare a spoken briefing. Try again in a moment.</p>}
        {n && (
          <div data-testid="briefing-narrative" className="space-y-2 rounded-lg border border-red-100 bg-red-50/60 p-4 text-sm">
            <p className="font-medium text-gray-900">{n.greeting}</p>
            <p className="whitespace-pre-line text-gray-700">{n.narrative}</p>
            {n.topPriorities.length > 0 && (
              <ol className="list-decimal space-y-1 pl-5" data-testid="briefing-priorities">
                {n.topPriorities.map((p, i) => (
                  <li key={i}><span className="font-medium">{p.title}</span> <span className="text-gray-600">— {p.why}</span></li>
                ))}
              </ol>
            )}
          </div>
        )}

        <Section title="Your tasks" icon={CalendarClock} testId="briefing-tasks">
          {noTasks ? (
            <p className="text-sm text-gray-500">Nothing due. {tasks.someday ? `${tasks.someday} task(s) without a due date.` : ""}</p>
          ) : (
            <div className="space-y-3">
              {tasks.overdue.length > 0 && (
                <div data-testid="briefing-tasks-overdue">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-red-700">Overdue</p>
                  <ul className="space-y-1">{tasks.overdue.map((t) => <TaskLine key={t.id} task={t} tone="overdue" />)}</ul>
                </div>
              )}
              {tasks.today.length > 0 && (
                <div data-testid="briefing-tasks-today">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-600">Today</p>
                  <ul className="space-y-1">{tasks.today.map((t) => <TaskLine key={t.id} task={t} tone="today" />)}</ul>
                </div>
              )}
              {tasks.upcoming.length > 0 && (
                <div data-testid="briefing-tasks-upcoming">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-600">Upcoming</p>
                  <ul className="space-y-1">{tasks.upcoming.map((t) => <TaskLine key={t.id} task={t} tone="upcoming" />)}</ul>
                </div>
              )}
            </div>
          )}
        </Section>

        {briefing.speedToLead && (
          <Section
            title="Leads waiting for first contact"
            icon={PhoneCall}
            testId="briefing-waiting-leads"
            action={<Link href="/sales/speed-to-lead" className="text-xs font-medium text-red-700 hover:underline">Speed to Lead</Link>}
          >
            {!briefing.speedToLead.enabled && (
              <p className="text-xs text-gray-500">Speed to Lead is switched off, so new leads aren't being timed.</p>
            )}
            {briefing.speedToLead.waiting.length === 0 ? (
              <p className="text-sm text-gray-500">No one is waiting. Nice work.</p>
            ) : (
              <ul className="space-y-1">
                {briefing.speedToLead.waiting.map((lead) => (
                  <li
                    key={lead.leadId}
                    data-testid={`waiting-lead-${lead.leadId}`}
                    className={cn("flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm",
                      lead.overdue ? "border-red-200 bg-red-50" : "bg-white")}
                  >
                    <span className="min-w-0">
                      <span className={cn("font-medium", lead.overdue && "text-red-700")}>{lead.name}</span>
                      {lead.serviceType && <span className="text-gray-500"> · {lead.serviceType}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className={cn("text-xs", lead.overdue ? "font-semibold text-red-700" : "text-gray-500")}>
                        {lead.overdue && <AlertTriangle className="mr-1 inline h-3 w-3" aria-hidden="true" />}
                        {formatWaiting(lead.waitingMinutes)}
                      </span>
                      <Link href={`/sales/copilot?leadId=${lead.leadId}`} className="text-xs font-medium text-red-700 hover:underline">Research</Link>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-gray-500">
              Target {briefing.speedToLead.targetMinutes} min
              {briefing.speedToLead.metrics.medianMinutes != null && ` · median response ${briefing.speedToLead.metrics.medianMinutes} min`}
              {briefing.speedToLead.metrics.withinTargetPct != null && ` · ${briefing.speedToLead.metrics.withinTargetPct}% on target`}
            </p>
          </Section>
        )}

        {briefing.leads && (
          <>
            <Section title={`New leads (last 24 h) · ${briefing.leads.openPipeline} open in pipeline`} icon={UserPlus} testId="briefing-new-leads">
              {briefing.leads.newLast24h.length === 0 ? (
                <p className="text-sm text-gray-500">No new leads in the last 24 hours.</p>
              ) : (
                <ul className="space-y-1">
                  {briefing.leads.newLast24h.map((lead) => (
                    <li key={lead.leadId} className="flex items-center justify-between gap-3 rounded-md border bg-white px-3 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="font-medium">{lead.name}</span>
                        {lead.company && <span className="text-gray-500"> · {lead.company}</span>}
                        {lead.serviceType && <span className="text-gray-500"> · {lead.serviceType}</span>}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline" className="text-xs">{lead.status}</Badge>
                        <Link href={`/sales/copilot?leadId=${lead.leadId}`} className="text-xs font-medium text-red-700 hover:underline">Research</Link>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Prospects to review" icon={Target} testId="briefing-prospects">
              <p className="text-sm text-gray-700">
                {briefing.leads.prospectsToReview === 0
                  ? "No prospects waiting for review."
                  : `${briefing.leads.prospectsToReview} prospect${briefing.leads.prospectsToReview === 1 ? "" : "s"} from the Lead Generation Agent.`}{" "}
                <Link href="/sales/lead-gen" className="font-medium text-red-700 hover:underline">Open Lead Generation</Link>
              </p>
            </Section>

            {briefing.leads.recentBriefs.length > 0 && (
              <Section title="Recent research briefs" icon={FileSearch} testId="briefing-briefs">
                <ul className="space-y-1">
                  {briefing.leads.recentBriefs.map((b) => (
                    <li key={b.leadId} className="rounded-md border bg-white px-3 py-2 text-sm">
                      <Link href={`/sales/copilot?leadId=${b.leadId}`} className="font-medium text-red-700 hover:underline">
                        {b.name || `Lead #${b.leadId}`}
                      </Link>
                      {b.headline && <span className="text-gray-600"> — {b.headline}</span>}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </>
        )}

        {briefing.appointments && (
          <Section title="Today's appointments" icon={CalendarDays} testId="briefing-appointments">
            {briefing.appointments.length === 0 ? (
              <p className="text-sm text-gray-500">No appointments booked today.</p>
            ) : (
              <ul className="space-y-1">
                {briefing.appointments.map((a) => (
                  <li key={a.reference} className="flex items-center justify-between gap-3 rounded-md border bg-white px-3 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium">{formatTime(a.startsAt)}</span>
                      <span className="text-gray-700"> · {a.customerName || "Customer"}</span>
                      {a.service && <span className="text-gray-500"> · {a.service}</span>}
                    </span>
                    <Badge variant="outline" className="shrink-0 text-xs">{a.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        {briefing.tickets && (
          <Section title="Help desk" icon={Ticket} testId="briefing-tickets">
            <p className="text-sm text-gray-700">
              {briefing.tickets.open} open ticket{briefing.tickets.open === 1 ? "" : "s"}
              {briefing.tickets.urgent > 0 && <span className="font-semibold text-red-700"> · {briefing.tickets.urgent} urgent</span>}.{" "}
              <Link href="/tickets" className="font-medium text-red-700 hover:underline">Open Help Desk</Link>
            </p>
          </Section>
        )}
      </CardContent>
    </Card>
  );
}
