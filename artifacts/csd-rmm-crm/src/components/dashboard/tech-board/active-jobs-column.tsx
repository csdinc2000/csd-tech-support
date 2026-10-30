import { useMemo, useState } from "react";
import { Briefcase, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { BoardColumn, BoardEmpty, BoardGroupHeader, BoardRow, BoardSkeletonRows, Pill } from "./column";
import {
  JOB_STATUS_GROUPS,
  PRIORITY_TONE,
  contactName,
  humanize,
  type BoardJob,
  type BoardSelection,
  type ContactIndex,
} from "./types";

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function ActiveJobsColumn({
  jobs,
  contacts,
  isLoading,
  onSelect,
  className,
}: {
  jobs: BoardJob[];
  contacts: ContactIndex;
  isLoading: boolean;
  onSelect: (selection: BoardSelection) => void;
  className?: string;
}) {
  const [search, setSearch] = useState("");
  const term = search.trim().toLowerCase();

  const groups = useMemo(() => {
    const active = jobs.filter((job) => JOB_STATUS_GROUPS.some((g) => g.value === job.status));
    const matching = term
      ? active.filter((job) =>
          [job.jobNumber, job.description, job.serviceType, job.assignedTo, contactName(contacts, job.contactId)]
            .some((value) => value?.toLowerCase().includes(term)))
      : active;
    return JOB_STATUS_GROUPS.map((group) => ({
      ...group,
      jobs: matching
        .filter((job) => job.status === group.value)
        .sort((a, b) => {
          const byPriority = (PRIORITY_ORDER[a.priority ?? "normal"] ?? 2) - (PRIORITY_ORDER[b.priority ?? "normal"] ?? 2);
          if (byPriority !== 0) return byPriority;
          return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
        }),
    }));
  }, [jobs, contacts, term]);

  const total = groups.reduce((sum, group) => sum + group.jobs.length, 0);

  return (
    <BoardColumn
      icon={Briefcase}
      title="Active Jobs"
      subtitle="Grouped by status, urgent first"
      count={isLoading ? undefined : total}
      className={className}
      testId="board-active-jobs"
      toolbar={
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-gray-400" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter by job #, customer, issue…"
            className="h-8 pl-8 text-sm"
            aria-label="Filter active jobs"
          />
        </div>
      }
    >
      {isLoading ? (
        <BoardSkeletonRows />
      ) : total === 0 ? (
        <BoardEmpty icon={Briefcase} text={term ? "No active jobs match that filter." : "No active jobs right now."} />
      ) : (
        groups.map((group) =>
          group.jobs.length === 0 ? null : (
            <div key={group.value}>
              <BoardGroupHeader label={group.label} count={group.jobs.length} dot={group.dot} />
              {group.jobs.map((job) => (
                <BoardRow
                  key={job.id}
                  testId={`board-job-${job.id}`}
                  onClick={() => onSelect({ kind: "job", item: job })}
                  title={
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs text-gray-500">{job.jobNumber}</span>
                      <span className="truncate">{contactName(contacts, job.contactId)}</span>
                    </span>
                  }
                  meta={
                    <>
                      {humanize(job.serviceType)} · {humanize(job.jobType)}
                      {job.assignedTo ? ` · ${job.assignedTo}` : " · Unassigned"}
                    </>
                  }
                  trailing={
                    job.priority && job.priority !== "normal" ? (
                      <Pill tone={PRIORITY_TONE[job.priority] ?? PRIORITY_TONE.normal}>{humanize(job.priority)}</Pill>
                    ) : null
                  }
                />
              ))}
            </div>
          ),
        )
      )}
    </BoardColumn>
  );
}
