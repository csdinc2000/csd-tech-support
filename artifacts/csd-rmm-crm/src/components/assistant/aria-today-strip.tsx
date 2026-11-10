import { Link } from "wouter";
import { CalendarClock, PhoneCall } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBriefing } from "./briefing-panel";

/** Compact "Today" summary shown on the Aria page; links to the Executive Assistant. */
export function AriaTodayStrip() {
  const { data } = useBriefing(120_000);
  if (!data) return null;
  const { tasks, speedToLead } = data.briefing;
  const due = tasks.overdue.length + tasks.today.length;
  const waiting = speedToLead?.waiting.length ?? null;
  const overdueLeads = speedToLead?.waiting.filter((l) => l.overdue).length ?? 0;

  return (
    <div
      data-testid="aria-today-strip"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-gray-200 bg-white px-4 py-2 text-sm md:px-6"
    >
      <span className="font-semibold text-gray-800">Today</span>
      <span className={cn("flex items-center gap-1", tasks.overdue.length ? "text-red-700" : "text-gray-600")}>
        <CalendarClock className="h-4 w-4" aria-hidden="true" />
        {due} task{due === 1 ? "" : "s"} due{tasks.overdue.length ? ` (${tasks.overdue.length} overdue)` : ""}
      </span>
      {waiting != null && (
        <span className={cn("flex items-center gap-1", overdueLeads ? "text-red-700" : "text-gray-600")}>
          <PhoneCall className="h-4 w-4" aria-hidden="true" />
          {waiting} lead{waiting === 1 ? "" : "s"} waiting{overdueLeads ? ` (${overdueLeads} past target)` : ""}
        </span>
      )}
      <Link href="/assistant" className="ml-auto text-sm font-medium text-red-700 hover:underline">Open Executive Assistant</Link>
    </div>
  );
}
