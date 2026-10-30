import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays } from "lucide-react";
import type { TwilioSettings } from "@shared/schema";
import { CalendarPanel } from "@/pages/phone-settings";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export default function SchedulingPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery<TwilioSettings>({ queryKey: ["/api/twilio/settings"] });
  const [draft, setDraft] = useState<Partial<TwilioSettings>>({});

  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  const save = useMutation({
    mutationFn: (patch: Partial<TwilioSettings>) => apiRequest("PATCH", "/api/twilio/settings", patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/twilio/settings"] });
      toast({ title: "Calendar settings saved" });
    },
    onError: (error: Error) => toast({ title: "Save failed", description: error.message, variant: "destructive" }),
  });

  if (isLoading || !settings) {
    return <div className="space-y-4 p-4 lg:p-6"><div className="h-8 w-56 animate-pulse rounded bg-muted" /><div className="h-72 animate-pulse rounded-xl bg-muted" /></div>;
  }

  return (
    <div className="mx-auto max-w-5xl p-4 lg:p-6">
      <header className="mb-6 border-l-4 border-csd-red pl-4">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-csd-red"><CalendarDays className="h-4 w-4" /> Operations calendar</div>
        <h1 className="text-2xl font-bold tracking-tight">Scheduling</h1>
        <p className="mt-1 text-sm text-muted-foreground">Control which calendar governs appointment availability and confirmed service bookings.</p>
      </header>
      <CalendarPanel
        currentId={draft.schedulingCalendarId || ""}
        blockBusy={!!draft.schedulingCalendarBlockBusy}
        pushEvents={!!draft.schedulingCalendarPushEvents}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        onSave={() => save.mutate({
          schedulingCalendarId: draft.schedulingCalendarId,
          schedulingCalendarBlockBusy: draft.schedulingCalendarBlockBusy,
          schedulingCalendarPushEvents: draft.schedulingCalendarPushEvents,
        })}
        saving={save.isPending}
      />
    </div>
  );
}