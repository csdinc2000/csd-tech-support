import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  BUCKET_LABELS, formatDue, groupTasks, isoToLocalInput, localInputToIso,
  type AssistantTask, type TaskPriority,
} from "@/lib/executive-assistant";
import { BRIEFING_QUERY_KEY } from "./briefing-panel";

const selectClass = "h-9 rounded-md border border-input bg-background px-2 text-sm";

function useTaskList(status: "open" | "done") {
  return useQuery<{ tasks: AssistantTask[] }>({
    queryKey: ["/api/assistant/tasks", status],
    queryFn: async () => (await apiRequest("GET", `/api/assistant/tasks?status=${status}`)).json(),
    staleTime: 15_000,
  });
}

function TaskRow({ task, onSave, onToggle, onDelete, busy }: {
  task: AssistantTask;
  busy: boolean;
  onToggle: (task: AssistantTask) => void;
  onSave: (task: AssistantTask, patch: Partial<{ title: string; notes: string | null; dueAt: string | null }>) => void;
  onDelete: (task: AssistantTask) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [due, setDue] = useState(isoToLocalInput(task.dueAt));
  const done = task.status === "done";

  if (editing) {
    return (
      <li className="space-y-2 rounded-md border bg-white p-3" data-testid={`task-${task.id}`}>
        <Input aria-label="Task title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        <Textarea aria-label="Task notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000} placeholder="Notes" />
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="Due date" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className="w-auto" />
          <Button
            size="sm"
            disabled={!title.trim() || busy}
            onClick={() => {
              onSave(task, { title: title.trim(), notes: notes.trim() || null, dueAt: localInputToIso(due) });
              setEditing(false);
            }}
          >
            <Check className="mr-1 h-4 w-4" /> Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}><X className="mr-1 h-4 w-4" /> Cancel</Button>
        </div>
      </li>
    );
  }

  return (
    <li
      className={cn("flex items-start gap-3 rounded-md border bg-white px-3 py-2", task.bucket === "overdue" && "border-red-200 bg-red-50/60")}
      data-testid={`task-${task.id}`}
    >
      <Checkbox
        className="mt-0.5"
        checked={done}
        disabled={busy}
        onCheckedChange={() => onToggle(task)}
        aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("break-words text-sm", done && "text-gray-400 line-through", task.bucket === "overdue" && "font-medium text-red-700")}>
            {task.title}
          </span>
          {task.priority === "high" && <Badge className="bg-red-600 text-xs hover:bg-red-600">High</Badge>}
          {task.priority === "low" && <Badge variant="outline" className="text-xs">Low</Badge>}
          {task.createdVia === "aria" && (
            <Badge variant="secondary" className="gap-1 text-xs" data-testid={`task-${task.id}-aria`}>
              <Bot className="h-3 w-3" aria-hidden="true" /> From Aria
            </Badge>
          )}
          {task.leadId && <span className="text-xs text-gray-500">Lead #{task.leadId}</span>}
        </div>
        {task.notes && <p className="mt-0.5 whitespace-pre-line text-xs text-gray-600">{task.notes}</p>}
        {task.dueAt && (
          <p className={cn("mt-0.5 text-xs", task.bucket === "overdue" ? "text-red-600" : "text-gray-500")}>Due {formatDue(task.dueAt)}</p>
        )}
      </div>
      {!done && (
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditing(true)} aria-label={`Edit ${task.title}`}>
          <Pencil className="h-4 w-4" />
        </Button>
      )}
      <Button size="icon" variant="ghost" className="h-8 w-8" disabled={busy} onClick={() => onDelete(task)} aria-label={`Delete ${task.title}`}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}

export function TasksPanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showCompleted, setShowCompleted] = useState(false);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");

  const open = useTaskList("open");
  const done = useTaskList("done");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/assistant/tasks"] });
    void queryClient.invalidateQueries({ queryKey: BRIEFING_QUERY_KEY });
  };
  const onError = (error: Error) => toast({ title: "Task not saved", description: error.message.replace(/^\d+:\s*/, ""), variant: "destructive" });

  const create = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/assistant/tasks", {
      title: title.trim(), priority, dueAt: localInputToIso(due),
    })).json(),
    onSuccess: () => { setTitle(""); setDue(""); setPriority("normal"); invalidate(); },
    onError,
  });
  const patch = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      (await apiRequest("PATCH", `/api/assistant/tasks/${id}`, body)).json(),
    onSuccess: invalidate,
    onError,
  });
  const remove = useMutation({
    mutationFn: async (id: number) => (await apiRequest("DELETE", `/api/assistant/tasks/${id}`)).json(),
    onSuccess: invalidate,
    onError,
  });

  const tasks = [...(open.data?.tasks ?? []), ...(showCompleted ? done.data?.tasks ?? [] : [])];
  const groups = groupTasks(tasks);
  const busy = patch.isPending || remove.isPending;

  return (
    <Card data-testid="assistant-tasks">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-lg">Tasks &amp; reminders</CardTitle>
          <div className="flex items-center gap-2">
            <Switch id="assistant-show-completed" checked={showCompleted} onCheckedChange={setShowCompleted} />
            <Label htmlFor="assistant-show-completed" className="text-sm text-gray-600">Show completed</Label>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-col gap-2 sm:flex-row sm:flex-wrap"
          onSubmit={(e) => { e.preventDefault(); if (title.trim()) create.mutate(); }}
          data-testid="task-quick-add"
        >
          <Input
            aria-label="New task"
            placeholder="Add a task or reminder…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            className="sm:min-w-[14rem] sm:flex-1"
          />
          <Input aria-label="New task due date" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className="sm:w-auto" />
          <select aria-label="New task priority" className={selectClass} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
          <Button type="submit" disabled={!title.trim() || create.isPending} className="bg-red-600 hover:bg-red-700">
            {create.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
            Add
          </Button>
        </form>

        {open.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading tasks…</p>
        ) : open.isError ? (
          <p className="text-sm text-red-700">Tasks could not be loaded.</p>
        ) : groups.length === 0 ? (
          <p className="text-sm text-gray-500">No tasks yet. Add one above, or ask Aria to remind you about something.</p>
        ) : (
          groups.map((group) => (
            <div key={group.bucket} data-testid={`task-group-${group.bucket}`}>
              <p className={cn("mb-1 text-xs font-semibold uppercase tracking-wide", group.bucket === "overdue" ? "text-red-700" : "text-gray-600")}>
                {BUCKET_LABELS[group.bucket]} ({group.tasks.length})
              </p>
              <ul className="space-y-1">
                {group.tasks.map((task) => (
                  <TaskRow
                    key={`${task.id}-${task.status}-${task.dueAt}-${task.title}`}
                    task={task}
                    busy={busy}
                    onToggle={(t) => patch.mutate({ id: t.id, body: { status: t.status === "done" ? "open" : "done" } })}
                    onSave={(t, body) => patch.mutate({ id: t.id, body })}
                    onDelete={(t) => remove.mutate(t.id)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
