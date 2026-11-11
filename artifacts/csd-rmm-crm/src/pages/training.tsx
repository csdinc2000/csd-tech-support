import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import { ArrowRight, CheckCircle2, Circle, Clock, GraduationCap, Lock, RotateCcw } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent, PageShell } from "@/components/layout/page-shell";
import { useAdminAccess, type StaffFeature } from "@/hooks/use-admin-access";
import { cn } from "@/lib/utils";
import { TECH_LINKS_BY_ID, canOpenLink } from "@/lib/tech-support-links";
import { TRAINING_LESSON_COUNT, TRAINING_MODULES, type TrainingLesson } from "@/lib/training-curriculum";

const FEATURE_LABEL: Record<StaffFeature, string> = {
  dashboard: "Dashboard", crm: "CRM", communications: "Communications", scheduling: "Scheduling",
  operations: "Operations", helpdesk: "Help Desk", invoices: "Invoices", reports: "Reports",
  automation: "Automation", compliance: "Compliance", helpdeskAdmin: "Helpdesk Admin",
  dispatchAdmin: "Dispatch Admin", staffAdmin: "Staff Admin", billing: "Billing", marketplace: "Marketplace",
};

/** Completed lesson ids, kept per signed-in user in this browser. */
function useTrainingProgress(storageKey: string) {
  const [done, setDone] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      setDone(new Set(stored ? (JSON.parse(stored) as string[]) : []));
    } catch {
      setDone(new Set());
    }
  }, [storageKey]);

  const save = (next: Set<string>) => {
    setDone(next);
    try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch {}
  };

  return {
    done,
    toggle: (lessonId: string) => {
      const next = new Set(done);
      if (next.has(lessonId)) next.delete(lessonId); else next.add(lessonId);
      save(next);
    },
    reset: () => save(new Set()),
  };
}

export default function TrainingPortal() {
  const { can } = useAdminAccess();
  const { userId } = useAuth();
  return <TrainingPortalView can={can} storageKey={`csd:training-progress:${userId ?? "anonymous"}`} />;
}

/** Provider-free so the browser test can render it without Clerk. */
export function TrainingPortalView({
  can,
  storageKey,
}: {
  can: (feature: StaffFeature) => boolean;
  storageKey: string;
}) {
  const { done, toggle, reset } = useTrainingProgress(storageKey);
  const [moduleId, setModuleId] = useState(TRAINING_MODULES[0].id);
  const current = TRAINING_MODULES.find((m) => m.id === moduleId) ?? TRAINING_MODULES[0];
  const moduleIndex = TRAINING_MODULES.indexOf(current);
  const nextModule = TRAINING_MODULES[moduleIndex + 1];

  const completed = TRAINING_MODULES.flatMap((m) => m.lessons).filter((l) => done.has(l.id)).length;
  const percent = Math.round((completed / TRAINING_LESSON_COUNT) * 100);
  const ModuleIcon = current.icon;

  return (
    <PageShell>
      <PageHeader
        icon={GraduationCap}
        eyebrow="New technician onboarding"
        title="Training Portal"
        description="Work through each module in order. Every lesson links to the page it covers — try it, then tick it off."
        actions={
          <Button variant="outline" className="text-sm" onClick={reset} disabled={completed === 0} data-testid="training-reset">
            <RotateCcw className="mr-1.5 h-4 w-4" />
            Reset progress
          </Button>
        }
      />

      <PageContent>
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm" data-testid="training-progress">
          <div className="mb-2 flex items-center justify-between gap-4 text-sm">
            <span className="font-semibold text-gray-900">
              {completed === TRAINING_LESSON_COUNT ? "Onboarding complete — nice work!" : "Your progress"}
            </span>
            <span className="tabular-nums text-gray-600">{completed} / {TRAINING_LESSON_COUNT} lessons · {percent}%</span>
          </div>
          <Progress value={percent} className="h-2" />
        </div>

        <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
          <nav aria-label="Training modules" className="space-y-1.5" data-testid="training-modules">
            {TRAINING_MODULES.map((m, index) => {
              const Icon = m.icon;
              const lessonsDone = m.lessons.filter((l) => done.has(l.id)).length;
              const finished = lessonsDone === m.lessons.length;
              const active = m.id === current.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setModuleId(m.id)}
                  aria-current={active ? "step" : undefined}
                  data-testid={`training-module-${m.id}`}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                    active ? "border-csd-red/40 bg-red-50/60" : "border-gray-200 bg-white hover:bg-gray-50",
                  )}
                >
                  <span className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                    finished ? "bg-emerald-100 text-emerald-700" : "bg-csd-red/10 text-csd-red",
                  )}>
                    {finished ? <CheckCircle2 className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-gray-900">{index + 1}. {m.title}</span>
                    <span className="block text-xs text-gray-500">{lessonsDone}/{m.lessons.length} lessons · {m.minutes} min</span>
                  </span>
                </button>
              );
            })}
          </nav>

          <section className="rounded-lg border border-gray-200 bg-white shadow-sm" data-testid="training-module-detail">
            <header className="flex items-start gap-3 border-b border-gray-200 px-5 py-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-csd-red text-white">
                <ModuleIcon className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Module {moduleIndex + 1} of {TRAINING_MODULES.length}</p>
                <h2 className="text-lg font-semibold text-gray-900">{current.title}</h2>
                <p className="flex items-center gap-1.5 text-sm text-gray-600">
                  {current.summary}
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-gray-400"><Clock className="h-3 w-3" />{current.minutes} min</span>
                </p>
              </div>
            </header>

            <ol className="divide-y divide-gray-100">
              {current.lessons.map((lesson) => (
                <LessonItem key={lesson.id} lesson={lesson} done={done.has(lesson.id)} onToggle={() => toggle(lesson.id)} can={can} />
              ))}
            </ol>

            {nextModule && (
              <footer className="flex justify-end border-t border-gray-200 px-5 py-3">
                <Button size="sm" onClick={() => setModuleId(nextModule.id)} data-testid="training-next-module">
                  Next: {nextModule.title}
                  <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              </footer>
            )}
          </section>
        </div>
      </PageContent>
    </PageShell>
  );
}

function LessonItem({
  lesson,
  done,
  onToggle,
  can,
}: {
  lesson: TrainingLesson;
  done: boolean;
  onToggle: () => void;
  can: (feature: StaffFeature) => boolean;
}) {
  const links = (lesson.links ?? []).map((id) => TECH_LINKS_BY_ID[id]).filter(Boolean);
  const checkboxId = `lesson-${lesson.id}`;
  return (
    <li className="px-5 py-4" data-testid={`training-lesson-${lesson.id}`}>
      <div className="flex items-start gap-3">
        {done
          ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
          : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-gray-300" />}
        <div className="min-w-0 flex-1">
          <h3 className={cn("text-sm font-semibold", done ? "text-gray-500" : "text-gray-900")}>{lesson.title}</h3>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-sm text-gray-700">
            {lesson.points.map((point) => <li key={point}>{point}</li>)}
          </ul>
          {lesson.practice && (
            <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <span className="font-semibold">Try it: </span>{lesson.practice}
            </p>
          )}
          {links.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {links.map((link) => {
                const Icon = link.icon;
                return canOpenLink(link, can) ? (
                  <Link
                    key={link.id}
                    href={link.href}
                    className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1 text-xs font-medium text-gray-700 transition-colors hover:border-csd-red/40 hover:text-csd-red"
                  >
                    <Icon className="h-3.5 w-3.5" />
                    Open {link.label}
                  </Link>
                ) : (
                  <span
                    key={link.id}
                    title={`Ask the owner to enable ${FEATURE_LABEL[link.feature!]} access`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-gray-200 px-3 py-1 text-xs text-gray-400"
                  >
                    <Lock className="h-3 w-3" />
                    {link.label} · needs {FEATURE_LABEL[link.feature!]} access
                  </span>
                );
              })}
            </div>
          )}
          <label htmlFor={checkboxId} className="mt-3 inline-flex cursor-pointer items-center gap-2 text-sm text-gray-700">
            <Checkbox id={checkboxId} checked={done} onCheckedChange={onToggle} />
            Mark lesson complete
          </label>
        </div>
      </div>
    </li>
  );
}
