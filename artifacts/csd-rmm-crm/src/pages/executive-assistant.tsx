import { Briefcase } from "lucide-react";
import { BriefingPanel } from "@/components/assistant/briefing-panel";
import { TasksPanel } from "@/components/assistant/tasks-panel";
import { AskAriaCard } from "@/components/assistant/ask-aria-card";

/**
 * Executive Assistant (/assistant): daily briefing + private tasks, backed by
 * /api/assistant/*. Aria reads and writes the same data through its tools, so a
 * reminder created in chat shows up here (badged "From Aria").
 *
 * The view needs only a QueryClientProvider and a wouter Router, so tests can
 * mount it directly (tests/executive-assistant.fixture.tsx).
 */
export function ExecutiveAssistantView() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="border-b border-gray-200 bg-white px-4 py-4 md:px-6">
        <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900 md:text-2xl">
          <Briefcase className="h-6 w-6 text-red-600" aria-hidden="true" /> Executive Assistant
        </h1>
        <p className="text-sm text-gray-600">Your day at a glance, your to-do list, and Aria on call.</p>
      </div>
      <div className="grid gap-4 p-4 md:p-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <BriefingPanel />
        <div className="space-y-4">
          <TasksPanel />
          <AskAriaCard />
        </div>
      </div>
    </div>
  );
}

export default function ExecutiveAssistantPage() {
  return <ExecutiveAssistantView />;
}
