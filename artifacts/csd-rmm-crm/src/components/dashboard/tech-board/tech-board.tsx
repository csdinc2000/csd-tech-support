import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { addDays, startOfDay } from "date-fns";
import { AlertCircle, Briefcase, CalendarDays, GraduationCap, Inbox, LayoutDashboard, Monitor, RefreshCw } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { PageShell } from "@/components/layout/page-shell";
import { ActiveJobsColumn } from "./active-jobs-column";
import { ScheduleColumn } from "./schedule-column";
import { ActivityColumn } from "./activity-column";
import { BoardDetailDialog } from "./detail-dialog";
import { BoardStats } from "./board-stats";
import { BoardQuickLinks } from "./quick-links";
import type { StaffFeature } from "@/hooks/use-admin-access";
import { JOB_STATUS_GROUPS, type BoardAppointment, type BoardCall, type BoardIntake, type BoardJob, type BoardSelection, type ContactIndex } from "./types";
import type { CrmContact } from "@shared/schema";

const LIVE_QUERY_OPTIONS = {
  refetchInterval: 30_000,
  refetchOnWindowFocus: true,
  staleTime: 15_000,
} as const;

// The schedule column loads a window around the selected day so paging a day
// back or forward doesn't wait on the network.
const SCHEDULE_WINDOW_DAYS = 7;

type BoardPane = "jobs" | "schedule" | "activity";

/**
 * Technician board: three columns, one detail window.
 *   left   — active work orders grouped by status
 *   center — the selected day's appointments and scheduled jobs
 *   right  — inbound service requests and the phone call log
 *
 * Above the columns: at-a-glance counts and quick links to related support pages.
 *
 * Layout: desktop (lg+) shows the three columns side by side at a fixed height
 * so each scrolls on its own. Phones and tablets get a segmented switcher and
 * one full-width column at a time, instead of three tall stacked lists.
 *
 * `canViewCalls` mirrors the "communications" staff feature that gates
 * /api/call-tracking, and `can` hides links the role can't open; the page
 * resolves both so this stays provider-free.
 */
export function TechBoard({
  canViewCalls,
  can = () => true,
}: {
  canViewCalls: boolean;
  can?: (feature: StaffFeature) => boolean;
}) {
  const [pane, setPane] = useState<BoardPane>("jobs");
  const [day, setDay] = useState(() => startOfDay(new Date()));
  const [selection, setSelection] = useState<BoardSelection | null>(null);

  const jobsQuery = useQuery<BoardJob[]>({ queryKey: ["/api/crm/jobs"], ...LIVE_QUERY_OPTIONS });
  const contactsQuery = useQuery<CrmContact[]>({ queryKey: ["/api/crm/contacts"], ...LIVE_QUERY_OPTIONS });

  const windowStart = addDays(day, -SCHEDULE_WINDOW_DAYS);
  const windowEnd = addDays(day, SCHEDULE_WINDOW_DAYS + 1);
  const appointmentsQuery = useQuery<BoardAppointment[]>({
    queryKey: [`/api/booking/appointments?from=${windowStart.toISOString()}&to=${windowEnd.toISOString()}`],
    ...LIVE_QUERY_OPTIONS,
  });

  const intakesQuery = useQuery<{ intakes: BoardIntake[]; total: number }>({
    queryKey: ["/api/intake?limit=25"],
    ...LIVE_QUERY_OPTIONS,
  });

  const callsQuery = useQuery<BoardCall[]>({
    queryKey: ["/api/call-tracking/calls?limit=40"],
    enabled: canViewCalls,
    ...LIVE_QUERY_OPTIONS,
  });

  const contacts = useMemo<ContactIndex>(
    () => new Map((contactsQuery.data ?? []).map((contact) => [contact.id, contact])),
    [contactsQuery.data],
  );
  const jobs = jobsQuery.data ?? [];
  const scheduledDays = useMemo(
    () => jobs.flatMap((job) =>
      job.scheduledDateTime && job.status !== "completed" && job.status !== "cancelled"
        ? [new Date(job.scheduledDateTime)]
        : []),
    [jobs],
  );

  const activeJobCount = jobs.filter((job) => JOB_STATUS_GROUPS.some((g) => g.value === job.status)).length;
  const newRequestCount = (intakesQuery.data?.intakes ?? []).filter((intake) => intake.status === "new").length;
  const panes: { id: BoardPane; label: string; icon: React.ComponentType<{ className?: string }>; count?: number }[] = [
    { id: "jobs", label: "Jobs", icon: Briefcase, count: jobsQuery.isLoading ? undefined : activeJobCount },
    { id: "schedule", label: "Schedule", icon: CalendarDays },
    { id: "activity", label: "Requests", icon: Inbox, count: newRequestCount || undefined },
  ];
  // Below lg only the selected pane renders visibly; lg+ always shows all three.
  const paneClass = (id: BoardPane) => cn("max-lg:h-[calc(100dvh-13rem)] max-lg:min-h-[26rem]", pane !== id && "max-lg:hidden");

  const queries = [jobsQuery, contactsQuery, appointmentsQuery, intakesQuery, ...(canViewCalls ? [callsQuery] : [])];
  const isFetching = queries.some((query) => query.isFetching);
  const error = queries.find((query) => query.error)?.error as Error | undefined;
  const refresh = () => { void Promise.all(queries.map((query) => query.refetch())); };

  return (
    <PageShell className="flex flex-col">
      <PageHeader
        icon={LayoutDashboard}
        eyebrow="Technician board"
        title="Operations Dashboard"
        description="Active jobs, today's schedule, and what just came in — tap anything for the full record."
        actions={
          <div className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto">
            <Button variant="outline" size="sm" onClick={refresh} disabled={isFetching} aria-label="Refresh board">
              <RefreshCw className={cn("h-4 w-4 sm:mr-1.5", isFetching && "animate-spin")} />
              <span className="max-sm:sr-only">{isFetching ? "Refreshing" : "Refresh"}</span>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/training" aria-label="Training">
                <GraduationCap className="h-4 w-4 sm:mr-1.5" />
                <span className="max-sm:sr-only">Training</span>
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/rmm" aria-label="RMM overview">
                <Monitor className="h-4 w-4 sm:mr-1.5" />
                <span className="max-sm:sr-only">RMM overview</span>
              </Link>
            </Button>
          </div>
        }
      />

      <div className="flex flex-1 flex-col gap-3 p-3 sm:p-4 md:gap-4 md:p-6" data-testid="tech-board">
        {error && (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <span className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              Some board data could not be refreshed: {error.message}
            </span>
            <Button size="sm" variant="outline" className="self-start sm:self-auto" onClick={refresh}>Retry</Button>
          </div>
        )}

        <BoardStats
          jobs={jobs}
          appointments={appointmentsQuery.data ?? []}
          intakes={intakesQuery.data?.intakes ?? []}
          calls={callsQuery.data ?? []}
          canViewCalls={canViewCalls}
          can={can}
          isLoading={jobsQuery.isLoading}
        />
        <BoardQuickLinks can={can} />

        <div
          role="tablist"
          aria-label="Board section"
          className="sticky top-16 z-10 -mx-3 grid grid-cols-3 gap-1 border-y border-gray-200 bg-gray-50/95 p-1.5 backdrop-blur sm:mx-0 sm:rounded-lg sm:border lg:hidden"
          data-testid="board-pane-switcher"
        >
          {panes.map((item) => {
            const Icon = item.icon;
            const selected = pane === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setPane(item.id)}
                className={cn(
                  "flex min-h-10 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors",
                  selected ? "bg-white text-csd-red shadow-sm ring-1 ring-gray-200" : "text-gray-600 hover:text-gray-900",
                )}
                data-testid={`board-pane-${item.id}`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
                {item.count != null && (
                  <span className={cn(
                    "rounded-full px-1.5 text-[11px] font-semibold tabular-nums",
                    selected ? "bg-red-50 text-csd-red" : "bg-gray-200 text-gray-700",
                  )}>
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="grid flex-1 grid-cols-1 gap-4 lg:h-[calc(100vh-4rem-15rem)] lg:min-h-[32rem] lg:grid-cols-3">
          <ActiveJobsColumn
            jobs={jobs}
            contacts={contacts}
            isLoading={jobsQuery.isLoading}
            onSelect={setSelection}
            className={paneClass("jobs")}
          />
          <ScheduleColumn
            day={day}
            onDayChange={setDay}
            appointments={appointmentsQuery.data ?? []}
            jobs={jobs}
            contacts={contacts}
            isLoading={appointmentsQuery.isLoading || jobsQuery.isLoading}
            onSelect={setSelection}
            scheduledDays={scheduledDays}
            className={paneClass("schedule")}
          />
          <ActivityColumn
            intakes={intakesQuery.data?.intakes ?? []}
            intakesLoading={intakesQuery.isLoading}
            calls={callsQuery.data ?? []}
            callsLoading={canViewCalls && callsQuery.isLoading}
            canViewCalls={canViewCalls}
            onSelect={setSelection}
            className={paneClass("activity")}
          />
        </div>
      </div>

      <BoardDetailDialog selection={selection} contacts={contacts} can={can} onClose={() => setSelection(null)} />
    </PageShell>
  );
}
