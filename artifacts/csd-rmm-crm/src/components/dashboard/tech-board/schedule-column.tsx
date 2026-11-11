import { useMemo, useState } from "react";
import { addDays, format, isSameDay, isToday, startOfDay } from "date-fns";
import { CalendarDays, CalendarIcon, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { BoardColumn, BoardEmpty, BoardRow, BoardSkeletonRows, Pill } from "./column";
import {
  APPOINTMENT_TONE,
  JOB_STATUS_GROUPS,
  contactName,
  humanize,
  type BoardAppointment,
  type BoardJob,
  type BoardSelection,
  type ContactIndex,
} from "./types";

/** One slot on the day's timeline — either a booked appointment or a job with a scheduled time. */
type ScheduleEntry =
  | { kind: "appointment"; at: Date; endsAt: Date; item: BoardAppointment }
  | { kind: "job"; at: Date; endsAt: null; item: BoardJob };

export function ScheduleColumn({
  day,
  onDayChange,
  appointments,
  jobs,
  contacts,
  isLoading,
  onSelect,
  scheduledDays,
  className,
}: {
  day: Date;
  onDayChange: (day: Date) => void;
  appointments: BoardAppointment[];
  jobs: BoardJob[];
  contacts: ContactIndex;
  isLoading: boolean;
  onSelect: (selection: BoardSelection) => void;
  /** Days (any time) that have at least one job scheduled — dotted on the mini calendar. */
  scheduledDays: Date[];
  className?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const entries = useMemo<ScheduleEntry[]>(() => {
    const list: ScheduleEntry[] = [];
    for (const appointment of appointments) {
      const at = new Date(appointment.startsAt);
      if (isSameDay(at, day) && appointment.status !== "cancelled") {
        list.push({ kind: "appointment", at, endsAt: new Date(appointment.endsAt), item: appointment });
      }
    }
    for (const job of jobs) {
      if (!job.scheduledDateTime || job.status === "completed" || job.status === "cancelled") continue;
      const at = new Date(job.scheduledDateTime);
      if (isSameDay(at, day)) list.push({ kind: "job", at, endsAt: null, item: job });
    }
    return list.sort((a, b) => a.at.getTime() - b.at.getTime());
  }, [appointments, jobs, day]);

  const now = new Date();
  const nextUp = isToday(day) ? entries.find((entry) => (entry.endsAt ?? entry.at) >= now) : undefined;

  return (
    <BoardColumn
      icon={CalendarDays}
      title="Daily Schedule"
      subtitle={isToday(day) ? "Today" : format(day, "EEEE")}
      count={isLoading ? undefined : entries.length}
      className={className}
      testId="board-schedule"
      toolbar={
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onDayChange(addDays(day, -1))} aria-label="Previous day">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" className="h-8 flex-1 justify-center gap-2 text-sm font-medium" data-testid="board-day-picker">
                <CalendarIcon className="h-3.5 w-3.5 text-gray-500" />
                {format(day, "EEE, MMM d, yyyy")}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="center">
              <Calendar
                mode="single"
                selected={day}
                onSelect={(picked) => {
                  if (picked) onDayChange(startOfDay(picked));
                  setPickerOpen(false);
                }}
                modifiers={{ scheduled: scheduledDays }}
                modifiersClassNames={{ scheduled: "font-bold underline decoration-csd-red decoration-2 underline-offset-4" }}
              />
              <div className="border-t px-3 py-2">
                <Button variant="ghost" size="sm" className="w-full" onClick={() => { onDayChange(startOfDay(new Date())); setPickerOpen(false); }}>
                  Jump to today
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onDayChange(addDays(day, 1))} aria-label="Next day">
            <ChevronRight className="h-4 w-4" />
          </Button>
          {!isToday(day) && (
            <Button variant="outline" size="sm" className="h-8" onClick={() => onDayChange(startOfDay(new Date()))}>
              Today
            </Button>
          )}
        </div>
      }
    >
      {isLoading ? (
        <BoardSkeletonRows />
      ) : entries.length === 0 ? (
        <BoardEmpty icon={Clock} text={`Nothing scheduled for ${isToday(day) ? "today" : format(day, "MMM d")}.`} />
      ) : (
        entries.map((entry) => {
          const isNext = entry === nextUp;
          const isPast = isToday(day) && (entry.endsAt ?? entry.at) < now && !isNext;
          const key = `${entry.kind}-${entry.item.id}`;
          if (entry.kind === "appointment") {
            const appointment = entry.item;
            return (
              <BoardRow
                key={key}
                testId={`board-appointment-${appointment.id}`}
                onClick={() => onSelect({ kind: "appointment", item: appointment })}
                className={cn(isNext && "bg-red-50/40", isPast && "opacity-60")}
                leading={<TimeBlock start={entry.at} end={entry.endsAt} highlight={isNext} />}
                title={appointment.customerName}
                meta={
                  <>
                    {appointment.serviceName ?? "Appointment"} · {appointment.reference}
                  </>
                }
                trailing={<Pill tone={APPOINTMENT_TONE[appointment.status] ?? APPOINTMENT_TONE.pending}>{humanize(appointment.status)}</Pill>}
              />
            );
          }
          const job = entry.item;
          const group = JOB_STATUS_GROUPS.find((g) => g.value === job.status);
          return (
            <BoardRow
              key={key}
              testId={`board-scheduled-job-${job.id}`}
              onClick={() => onSelect({ kind: "job", item: job })}
              className={cn(isNext && "bg-red-50/40", isPast && "opacity-60")}
              leading={<TimeBlock start={entry.at} end={null} highlight={isNext} />}
              title={contactName(contacts, job.contactId)}
              meta={
                <>
                  {humanize(job.serviceType)} · {humanize(job.jobType)} · <span className="font-mono">{job.jobNumber}</span>
                </>
              }
              trailing={group ? <Pill tone={group.tone}>{group.label}</Pill> : null}
            />
          );
        })
      )}
    </BoardColumn>
  );
}

function TimeBlock({ start, end, highlight }: { start: Date; end: Date | null; highlight: boolean }) {
  return (
    <div
      className={cn(
        "w-[4.25rem] rounded-md border px-1.5 py-1 text-center leading-tight",
        highlight ? "border-csd-red/40 bg-white text-csd-red" : "border-gray-200 bg-gray-50 text-gray-700",
      )}
    >
      <div className="text-xs font-semibold tabular-nums">{format(start, "h:mm a")}</div>
      <div className="text-[10px] tabular-nums text-gray-400">{end ? `– ${format(end, "h:mm a")}` : "scheduled"}</div>
    </div>
  );
}
