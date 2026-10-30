import { useMemo } from "react";
import { isToday } from "date-fns";
import { AlertTriangle, Briefcase, CalendarClock, Inbox, PackageCheck, PhoneMissed, UserX } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import type { StaffFeature } from "@/hooks/use-admin-access";
import { MISSED_CALL_STATUSES } from "./activity-column";
import type { BoardAppointment, BoardCall, BoardIntake, BoardJob } from "./types";

const CLOSED_JOB_STATUSES = new Set(["completed", "cancelled"]);

type Stat = {
  id: string;
  label: string;
  hint: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  feature: StaffFeature;
  /** Highlight the tile when the number needs attention. */
  alert?: boolean;
};

/**
 * At-a-glance counts across the board's data. Every tile links to the page
 * where the technician would act on it.
 */
export function BoardStats({
  jobs,
  appointments,
  intakes,
  calls,
  canViewCalls,
  can,
  isLoading,
}: {
  jobs: BoardJob[];
  appointments: BoardAppointment[];
  intakes: BoardIntake[];
  calls: BoardCall[];
  canViewCalls: boolean;
  can: (feature: StaffFeature) => boolean;
  isLoading: boolean;
}) {
  const stats = useMemo<Stat[]>(() => {
    const active = jobs.filter((job) => !CLOSED_JOB_STATUSES.has(job.status));
    const urgent = active.filter((job) => job.priority === "urgent" || job.priority === "high").length;
    const unassigned = active.filter((job) => !job.assignedTo).length;
    const readyPickup = active.filter((job) => job.status === "ready_pickup").length;
    const todaysSchedule =
      appointments.filter((a) => a.status !== "cancelled" && isToday(new Date(a.startsAt))).length +
      active.filter((job) => job.scheduledDateTime && isToday(new Date(job.scheduledDateTime))).length;
    const newRequests = intakes.filter((intake) => intake.status === "new").length;
    const missedCalls = calls.filter((call) => MISSED_CALL_STATUSES.has(call.status)).length;

    const list: Stat[] = [
      { id: "active", label: "Active jobs", hint: "Not completed or cancelled", value: active.length, icon: Briefcase, href: "/crm/jobs", feature: "crm" },
      { id: "urgent", label: "Urgent / high", hint: "Priority work first", value: urgent, icon: AlertTriangle, href: "/crm/jobs", feature: "crm", alert: urgent > 0 },
      { id: "unassigned", label: "Unassigned", hint: "Jobs with no technician", value: unassigned, icon: UserX, href: "/crm/jobs", feature: "crm", alert: unassigned > 0 },
      { id: "ready", label: "Ready for pickup", hint: "Call the customer", value: readyPickup, icon: PackageCheck, href: "/crm/jobs", feature: "crm" },
      { id: "today", label: "On today's schedule", hint: "Appointments + scheduled jobs", value: todaysSchedule, icon: CalendarClock, href: "/staff-calendar", feature: "operations" },
      { id: "requests", label: "New requests", hint: "Intakes not yet contacted", value: newRequests, icon: Inbox, href: "/admin/intakes", feature: "crm", alert: newRequests > 0 },
    ];
    if (canViewCalls) {
      list.push({ id: "missed", label: "Missed calls", hint: "In the recent call log", value: missedCalls, icon: PhoneMissed, href: "/comms", feature: "communications", alert: missedCalls > 0 });
    }
    return list;
  }, [jobs, appointments, intakes, calls, canViewCalls]);

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7" data-testid="board-stats">
      {stats.map((stat) => {
        const Icon = stat.icon;
        const body = (
          <>
            <span
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                stat.alert ? "bg-csd-red/10 text-csd-red" : "bg-gray-100 text-gray-500",
              )}
            >
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className={cn("block text-xl font-bold tabular-nums leading-tight", stat.alert ? "text-csd-red" : "text-gray-900")}>
                {isLoading ? "–" : stat.value}
              </span>
              <span className="block truncate text-xs font-medium text-gray-700">{stat.label}</span>
              <span className="block truncate text-[11px] text-gray-400">{stat.hint}</span>
            </span>
          </>
        );
        const tileClass = "flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2.5 shadow-sm";
        return can(stat.feature) ? (
          <Link
            key={stat.id}
            href={stat.href}
            className={cn(tileClass, "transition-colors hover:border-csd-red/40 hover:bg-red-50/40")}
            data-testid={`board-stat-${stat.id}`}
          >
            {body}
          </Link>
        ) : (
          <div key={stat.id} className={tileClass} data-testid={`board-stat-${stat.id}`}>{body}</div>
        );
      })}
    </div>
  );
}
