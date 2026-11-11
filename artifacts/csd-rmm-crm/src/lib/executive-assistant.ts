/**
 * Types and pure helpers for the Executive Assistant page (/assistant).
 * Shapes mirror api-server/src/executive-assistant.ts.
 */

export const BUSINESS_TIMEZONE = "America/New_York";

export type TaskBucket = "overdue" | "today" | "upcoming" | "someday" | "done";
export type TaskPriority = "low" | "normal" | "high";

export type AssistantTask = {
  id: number;
  title: string;
  notes: string | null;
  dueAt: string | null;
  priority: TaskPriority;
  status: "open" | "done";
  leadId: number | null;
  contactId: number | null;
  createdVia: string;
  completedAt: string | null;
  createdAt: string;
  bucket: TaskBucket;
};

export type WaitingLead = {
  leadId: number;
  name: string;
  serviceType: string | null;
  waitingMinutes: number | null;
  overdue: boolean;
};

export type Briefing = {
  date: string;
  generatedAt: string;
  timezone: string;
  tasks: { overdue: AssistantTask[]; today: AssistantTask[]; upcoming: AssistantTask[]; someday: number };
  speedToLead?: {
    enabled: boolean;
    targetMinutes: number;
    waiting: WaitingLead[];
    metrics: { medianMinutes: number | null; withinTargetPct: number | null; waiting: number; contacted: number };
  };
  leads?: {
    newLast24h: Array<{ leadId: number; name: string; company: string | null; serviceType: string | null; source: string | null; status: string; createdAt: string }>;
    openPipeline: number;
    prospectsToReview: number;
    recentBriefs: Array<{ leadId: number; name: string | null; headline: string | null }>;
  };
  appointments?: Array<{ reference: string; customerName: string | null; service: string | null; startsAt: string; endsAt: string | null; status: string }>;
  tickets?: { open: number; urgent: number };
};

export type BriefingResponse = { briefing: Briefing; aiConfigured: boolean };

export type BriefingNarrative = {
  greeting: string;
  narrative: string;
  topPriorities: Array<{ title: string; why: string }>;
};

export const BUCKET_LABELS: Record<TaskBucket, string> = {
  overdue: "Overdue",
  today: "Today",
  upcoming: "Upcoming",
  someday: "No due date",
  done: "Completed",
};

export const BUCKET_ORDER: TaskBucket[] = ["overdue", "today", "upcoming", "someday", "done"];

export function groupTasks(tasks: AssistantTask[]): Array<{ bucket: TaskBucket; tasks: AssistantTask[] }> {
  return BUCKET_ORDER
    .map((bucket) => ({ bucket, tasks: tasks.filter((t) => t.bucket === bucket) }))
    .filter((g) => g.tasks.length > 0);
}

export function formatTime(iso: string, timeZone = BUSINESS_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function formatDue(iso: string | null, timeZone = BUSINESS_TIMEZONE): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function formatBriefingDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" })
    .format(new Date(Date.UTC(y, m - 1, d, 12)));
}

export function formatWaiting(minutes: number | null): string {
  if (minutes == null) return "";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days`;
}

/** `<input type="datetime-local">` value (browser-local) → ISO with offset, or null. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** ISO → `<input type="datetime-local">` value in the browser's zone. */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function narrativeSpeech(n: BriefingNarrative): string {
  const priorities = n.topPriorities.map((p, i) => `${i + 1}. ${p.title}. ${p.why}`).join(" ");
  return [n.greeting, n.narrative, priorities ? `Your top priorities: ${priorities}` : ""].filter(Boolean).join(" ");
}

export function ariaPromptHref(prompt: string): string {
  return `/aria?prompt=${encodeURIComponent(prompt)}`;
}

export const ARIA_EXAMPLE_PROMPTS = [
  "Brief me on today",
  "Remind me to call the Lauderhill dental office tomorrow at 10",
  "Research lead 42 before my call",
  "Find 10 law firms in Plantation that might need managed IT",
];
