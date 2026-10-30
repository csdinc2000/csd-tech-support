import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { addDays, startOfDay } from "date-fns";
import { AlertCircle, GraduationCap, LayoutDashboard, Monitor, RefreshCw } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/page-header";
import { PageShell } from "@/components/layout/page-shell";
import { ActiveJobsColumn } from "./active-jobs-column";
import { ScheduleColumn } from "./schedule-column";
import { ActivityColumn } from "./activity-column";
import { BoardDetailDialog } from "./detail-dialog";
import { BoardStats } from "./board-stats";
import { BoardQuickLinks } from "./quick-links";
import type { StaffFeature } from "@/hooks/use-admin-access";
import type { BoardAppointment, BoardCall, BoardIntake, BoardJob, BoardSelection, ContactIndex } from "./types";
import type { CrmContact } from "@shared/schema";

const LIVE_QUERY_OPTIONS = {
  refetchInterval: 30_000,
  refetchOnWindowFocus: true,
  staleTime: 15_000,
} as const;

// The schedule column loads a window around the selected day so paging a day
// back or forward doesn't wait on the network.
const SCHEDULE_WINDOW_DAYS = 7;

/**
 * Technician board: three columns, one detail window.
 *   left   — active work orders grouped by status
 *   center — the selected day's appointments and scheduled jobs
 *   right  — inbound service requests and the phone call log
 *
 * Above the columns: at-a-glance counts and quick links to related support pages.
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
  const [, navigate] = useLocation();
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
        description="Active jobs, today's schedule, and what just came in — click anything for the full record."
        actions={
          <>
            <Button variant="outline" className="min-w-0 flex-1 text-sm sm:flex-none" onClick={refresh} disabled={isFetching}>
              <RefreshCw className={`mr-1.5 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
              {isFetching ? "Refreshing" : "Refresh"}
            </Button>
            <Button variant="outline" className="min-w-0 flex-1 text-sm sm:flex-none" onClick={() => navigate("/training")}>
              <GraduationCap className="mr-1.5 h-4 w-4" />
              Training
            </Button>
            <Button variant="outline" className="min-w-0 flex-1 text-sm sm:flex-none" onClick={() => navigate("/dashboard/rmm")}>
              <Monitor className="mr-1.5 h-4 w-4" />
              RMM overview
            </Button>
          </>
        }
      />

      <div className="flex flex-1 flex-col gap-3 p-4 md:p-6" data-testid="tech-board">
        {error && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            <span className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              Some board data could not be refreshed: {error.message}
            </span>
            <Button size="sm" variant="outline" onClick={refresh}>Retry</Button>
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

        <div className="grid flex-1 grid-cols-1 gap-4 lg:h-[calc(100vh-4rem-16rem)] lg:min-h-[30rem] lg:grid-cols-3">
          <ActiveJobsColumn
            jobs={jobs}
            contacts={contacts}
            isLoading={jobsQuery.isLoading}
            onSelect={setSelection}
            className="max-lg:max-h-[70vh]"
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
            className="max-lg:max-h-[70vh]"
          />
          <ActivityColumn
            intakes={intakesQuery.data?.intakes ?? []}
            intakesLoading={intakesQuery.isLoading}
            calls={callsQuery.data ?? []}
            callsLoading={canViewCalls && callsQuery.isLoading}
            canViewCalls={canViewCalls}
            onSelect={setSelection}
            className="max-lg:max-h-[70vh]"
          />
        </div>
      </div>

      <BoardDetailDialog selection={selection} contacts={contacts} onClose={() => setSelection(null)} />
    </PageShell>
  );
}
