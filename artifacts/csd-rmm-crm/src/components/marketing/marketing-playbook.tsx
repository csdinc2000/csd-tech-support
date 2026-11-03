import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowUpRight, CalendarCheck, CalendarRange, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { MARKETING_PLAYBOOK, monthKey, weekKey, type PlaybookTask } from "@/lib/marketing";
import { MarketingCard } from "./shared";

/**
 * Weekly and monthly marketing routine. Progress is per user, per period, in
 * this browser (same model as Training Portal progress): weekly items reset
 * each ISO week, monthly items each calendar month.
 */
function usePeriodChecklist(storageKey: string) {
  const [done, setDone] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      setDone(new Set(stored ? (JSON.parse(stored) as string[]) : []));
    } catch {
      setDone(new Set());
    }
  }, [storageKey]);
  const write = (next: Set<string>) => {
    setDone(next);
    try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* not persisted */ }
  };
  const toggle = (id: string) => {
    const next = new Set(done);
    if (next.has(id)) next.delete(id); else next.add(id);
    write(next);
  };
  return { done, toggle, reset: () => write(new Set()) };
}

export function MarketingPlaybook({ storagePrefix, can }: { storagePrefix: string; can: (feature: string) => boolean }) {
  const now = new Date();
  const weekly = usePeriodChecklist(`${storagePrefix}:${weekKey(now)}`);
  const monthly = usePeriodChecklist(`${storagePrefix}:${monthKey(now)}`);
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-testid="marketing-playbook">
      <Checklist
        icon={CalendarCheck}
        title="This week"
        description={`Resets every Monday · ${weekKey(now)}`}
        tasks={MARKETING_PLAYBOOK.filter((task) => task.cadence === "weekly")}
        state={weekly}
        can={can}
      />
      <Checklist
        icon={CalendarRange}
        title="This month"
        description={now.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        tasks={MARKETING_PLAYBOOK.filter((task) => task.cadence === "monthly")}
        state={monthly}
        can={can}
      />
    </div>
  );
}

function Checklist({
  icon,
  title,
  description,
  tasks,
  state,
  can,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  tasks: PlaybookTask[];
  state: ReturnType<typeof usePeriodChecklist>;
  can: (feature: string) => boolean;
}) {
  const complete = tasks.filter((task) => state.done.has(task.id)).length;
  return (
    <MarketingCard
      icon={icon}
      title={title}
      description={description}
      bodyClassName="p-0"
      actions={
        <Button variant="ghost" size="sm" className="h-8 text-xs text-gray-600" onClick={state.reset} disabled={complete === 0}>
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          Reset
        </Button>
      }
    >
      <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3">
        <Progress value={tasks.length ? (complete / tasks.length) * 100 : 0} className="h-2 flex-1" aria-label={`${title} progress`} />
        <span className="text-xs font-semibold tabular-nums text-gray-700">{complete}/{tasks.length}</span>
      </div>
      <ul className="divide-y divide-gray-100">
        {tasks.map((task) => {
          const checked = state.done.has(task.id);
          const linkable = task.href && (!task.feature || can(task.feature));
          return (
            <li key={task.id} className="flex items-start gap-3 px-4 py-3">
              <input
                id={`playbook-${task.id}`}
                type="checkbox"
                checked={checked}
                onChange={() => state.toggle(task.id)}
                className="mt-0.5 h-5 w-5 shrink-0 accent-csd-red"
                data-testid={`playbook-${task.id}`}
              />
              <label htmlFor={`playbook-${task.id}`} className="min-w-0 flex-1 cursor-pointer">
                <span className={cn("block text-sm font-medium", checked ? "text-gray-400 line-through" : "text-gray-900")}>{task.title}</span>
                <span className="block text-xs text-gray-500">{task.detail}</span>
              </label>
              {linkable && (
                <Link href={task.href!} className="shrink-0 rounded-md p-1.5 text-gray-400 hover:bg-red-50 hover:text-csd-red" aria-label={`Open: ${task.title}`}>
                  <ArrowUpRight className="h-4 w-4" />
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </MarketingCard>
  );
}
