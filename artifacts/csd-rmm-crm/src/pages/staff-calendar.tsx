import { useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, ExternalLink, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getQueryFn, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";

type CalendarEvent = {
  id: string;
  summary: string;
  description: string | null;
  location: string | null;
  startIso: string | null;
  endIso: string | null;
  htmlLink: string | null;
  status: string;
  reference: string | null;
  kind: "event" | "appointment";
  appointmentId: number | null;
  customerName: string | null;
  customerPhone?: string | null;
  serviceName: string | null;
  appointmentStatus: string | null;
  editable: boolean;
};
type CalendarResponse = { events: CalendarEvent[]; canManage: boolean; configured: boolean; source: string };

function mondayOf(date: Date) {
  const monday = new Date(date);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}
function localInput(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
function dateRange(start: Date) {
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { from: start.toISOString(), to: end.toISOString() };
}
function niceTime(iso: string | null) {
  if (!iso) return "All day";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(new Date(`${iso}T00:00:00`));
  }
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export default function StaffCalendarPage({ showSettingsLink = false }: { showSettingsLink?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [week, setWeek] = useState(() => mondayOf(new Date()));
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [startLocal, setStartLocal] = useState(() => localInput(new Date(Date.now() + 60 * 60_000)));
  const [endLocal, setEndLocal] = useState(() => localInput(new Date(Date.now() + 2 * 60 * 60_000)));
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const range = useMemo(() => dateRange(week), [week]);
  const queryKey = `/api/staff-calendar/events?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
  const calendar = useQuery<CalendarResponse>({ queryKey: [queryKey], queryFn: getQueryFn({ on401: "throw" }) });

  async function reload() {
    await queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith("/api/staff-calendar/events") });
  }
  function startNew() {
    const now = new Date();
    const monday = new Date(week);
    let start = new Date(monday);
    start.setHours(9, 0, 0, 0);
    if (monday.getTime() === mondayOf(now).getTime()) {
      start = new Date(now.getTime() + 60 * 60_000);
    }
    start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
    setEditing(null);
    setEditorOpen(true);
    setSummary("");
    setDescription("");
    setLocation("");
    setStartLocal(localInput(start));
    setEndLocal(localInput(new Date(start.getTime() + 60 * 60_000)));
  }
  function startEdit(item: CalendarEvent) {
    if (!item.editable || !item.startIso || !item.endIso) return;
    setEditing(item);
    setEditorOpen(true);
    setSummary(item.summary);
    setDescription(item.description || "");
    setLocation(item.location || "");
    setStartLocal(localInput(new Date(item.startIso)));
    setEndLocal(localInput(new Date(item.endIso)));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const startsAt = new Date(startLocal);
    const endsAt = new Date(endLocal);
    if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) {
      toast({ title: "Check the event time", description: "The end must be after the start.", variant: "destructive" });
      return;
    }
    const body: Record<string, unknown> = {
      startIso: startsAt.toISOString(),
      endIso: endsAt.toISOString(),
      timezone,
    };
    if (!editing || editing.kind !== "appointment") {
      body.summary = summary.trim();
      body.description = description.trim();
      body.location = location.trim();
    }
    try {
      if (editing) {
        await apiRequest("PATCH", `/api/staff-calendar/events/${encodeURIComponent(editing.id)}`, body);
        toast({ title: editing.kind === "appointment" ? "Appointment rescheduled" : "Calendar event updated" });
      } else {
        if (!summary.trim()) {
          toast({ title: "Add a title", variant: "destructive" });
          return;
        }
        await apiRequest("POST", "/api/staff-calendar/events", body);
        toast({ title: "Event added to Google Calendar" });
      }
      setEditing(null);
      setEditorOpen(false);
      await reload();
    } catch (error) {
      toast({ title: "Calendar change failed", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    }
  }
  async function deleteEvent(item: CalendarEvent) {
    if (!item.editable) return;
    const consequence = item.kind === "appointment"
      ? "This cancels the customer appointment, removes it from the shared Google Calendar, and sends calendar cancellation updates."
      : "This permanently removes the event from the shared Google Calendar and sends attendee cancellation updates.";
    if (!window.confirm(`${consequence}\n\nDelete “${item.summary}”?`)) return;
    try {
      await apiRequest("DELETE", `/api/staff-calendar/events/${encodeURIComponent(item.id)}`);
      toast({ title: item.kind === "appointment" ? "Appointment cancelled" : "Event deleted" });
      if (editing?.id === item.id) { setEditing(null); setEditorOpen(false); }
      await reload();
    } catch (error) {
      toast({ title: "Could not delete calendar item", description: error instanceof Error ? error.message : "Try again.", variant: "destructive" });
    }
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 lg:p-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="border-l-4 border-csd-red pl-4">
          <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-csd-red"><CalendarDays className="h-4 w-4" /> Shared Google Calendar</p>
          <h1 className="text-2xl font-bold tracking-tight">Team calendar</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {calendar.data?.canManage ? "View and manage shared events and customer appointments." : "You’ll see customer appointments assigned to your customers or accounts."}
          </p>
        </div>
        {calendar.data?.canManage && calendar.data.configured && (
          <Button onClick={startNew} className="bg-csd-red hover:bg-red-700"><Plus className="mr-2 h-4 w-4" /> Add event</Button>
        )}
        {calendar.data?.canManage && <Link href="/scheduling" className="text-sm font-medium underline">Calendar settings</Link>}
      </header>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div><CardTitle>This week</CardTitle><CardDescription>{new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(week)}</CardDescription></div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setWeek(mondayOf(new Date()))}>Today</Button>
            <Button variant="outline" size="icon" aria-label="Previous week" onClick={() => setWeek((date) => { const next = new Date(date); next.setDate(next.getDate() - 7); return next; })}><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="outline" size="icon" aria-label="Next week" onClick={() => setWeek((date) => { const next = new Date(date); next.setDate(next.getDate() + 7); return next; })}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {calendar.isLoading && <p className="py-8 text-center text-sm text-muted-foreground">Loading calendar…</p>}
          {calendar.isError && (
            <div className="py-8 text-center text-sm text-destructive">
              <p>Calendar could not be loaded. Check the Google Calendar connection and try again.</p>
              {showSettingsLink && <Link href="/scheduling" className="mt-2 inline-block font-semibold underline">Check or reconnect Google Calendar in settings</Link>}
            </div>
          )}
          {calendar.data?.source === "unconfigured" && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <p>Connect the shared booking calendar before viewing or editing Google events.</p>
              <Link href="/scheduling" className="mt-2 inline-block font-semibold text-csd-red underline">Open calendar settings</Link>
            </div>
          )}
          {calendar.data?.events.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">No events or assigned appointments this week.</p>}
          {calendar.data?.events.map((item) => (
            <article key={`${item.kind}-${item.id}`} className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate font-semibold">{item.summary}</h2>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${item.kind === "appointment" ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-700"}`}>
                    {item.kind === "appointment" ? "Customer appointment" : "Calendar event"}
                  </span>
                  {item.appointmentStatus && <span className="text-xs capitalize text-muted-foreground">{item.appointmentStatus.replaceAll("_", " ")}</span>}
                </div>
                <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground"><Clock3 className="h-4 w-4" />{niceTime(item.startIso)}{item.endIso && item.startIso && !/^\d{4}-\d{2}-\d{2}$/.test(item.startIso) ? ` – ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(item.endIso))}` : ""}</p>
                {item.kind === "appointment" && item.customerPhone && <p className="mt-1 text-xs text-muted-foreground">{item.customerPhone}</p>}
                {item.kind === "appointment" && item.reference && <p className="mt-1 text-xs text-muted-foreground">Ref {item.reference}</p>}
                {item.kind === "event" && item.location && <p className="mt-1 text-xs text-muted-foreground">{item.location}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                {item.htmlLink && <Button variant="outline" size="sm" asChild><a href={item.htmlLink} target="_blank" rel="noreferrer">Open in Google <ExternalLink className="ml-1 h-3 w-3" /></a></Button>}
                {item.editable && <Button variant="outline" size="sm" onClick={() => startEdit(item)}>Edit</Button>}
                {item.editable && <Button variant="outline" size="icon" aria-label={`Delete ${item.summary}`} onClick={() => void deleteEvent(item)}><Trash2 className="h-4 w-4 text-destructive" /></Button>}
              </div>
            </article>
          ))}
        </CardContent>
      </Card>

      {calendar.data?.canManage && editorOpen && (
        <Card>
          <CardHeader><CardTitle>{editing ? editing.kind === "appointment" ? "Reschedule customer appointment" : "Edit calendar event" : "Add calendar event"}</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
              {(!editing || editing.kind !== "appointment") && <>
                <label className="space-y-2 text-sm font-medium sm:col-span-2">Title<Input value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={200} required /></label>
                <label className="space-y-2 text-sm font-medium sm:col-span-2">Description<Textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={4000} rows={3} /></label>
                <label className="space-y-2 text-sm font-medium sm:col-span-2">Location<Input value={location} onChange={(event) => setLocation(event.target.value)} maxLength={500} /></label>
              </>}
              <label className="space-y-2 text-sm font-medium">Starts<Input type="datetime-local" value={startLocal} onChange={(event) => setStartLocal(event.target.value)} required /></label>
              <label className="space-y-2 text-sm font-medium">Ends<Input type="datetime-local" value={endLocal} onChange={(event) => setEndLocal(event.target.value)} required /></label>
              <p className="text-xs text-muted-foreground sm:col-span-2">Times use your device time zone: {timezone}. Google Calendar sends attendee updates when an event changes.</p>
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" className="bg-csd-red hover:bg-red-700">{editing ? "Save changes" : "Add event"}</Button>
                <Button type="button" variant="outline" onClick={() => { setEditing(null); setEditorOpen(false); setSummary(""); }}>Cancel</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
