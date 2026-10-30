import { useDeferredValue, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { getListMeetingStaffQueryKey, useCreateStaffMeeting, useListMeetingStaff } from "@workspace/api-client-react";
import type { MeetingStaff, StaffMeetingInput, StaffMeetingResult } from "@workspace/api-client-react";
import { AlertCircle, CalendarDays, CheckCircle2, ExternalLink, Link2, Search, UsersRound, Video, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getQueryFn } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { MeetingOnboardingHelp } from "./meeting-onboarding-help";

type CalendarStatus = {
  connected: boolean;
  attachedCalendarId: string | null;
};

type CreatedMeeting = {
  input: StaffMeetingInput;
  result: StaffMeetingResult;
};

type MeetingProvider = NonNullable<StaffMeetingInput["provider"]>;
type MeetingGuest = NonNullable<StaffMeetingInput["guestEmails"]>[number];
type MeetingContact = { id: number; fullName: string; email: string | null; company?: string | null };

function localDateTimeValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function initialMeetingTimes() {
  const start = new Date();
  start.setMinutes(Math.ceil((start.getMinutes() + 30) / 15) * 15, 0, 0);
  const end = new Date(start.getTime() + 60 * 60_000);
  return { start: localDateTimeValue(start), end: localDateTimeValue(end) };
}

function formattedDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }).format(new Date(iso));
}

export default function StaffMeetingsPage() {
  const { toast } = useToast();
  const access = useAdminAccess();
  const times = initialMeetingTimes();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [provider, setProvider] = useState<MeetingProvider>("google_meet");
  const [startLocal, setStartLocal] = useState(times.start);
  const [endLocal, setEndLocal] = useState(times.end);
  const [inviteAllStaff, setInviteAllStaff] = useState(false);
  const [selectedStaffIds, setSelectedStaffIds] = useState<Set<string>>(new Set());
  const [selectedGuests, setSelectedGuests] = useState<Map<string, MeetingGuest>>(new Map());
  const [inviteeSearch, setInviteeSearch] = useState("");
  const deferredInviteeSearch = useDeferredValue(inviteeSearch.trim());
  const [manualGuestEmail, setManualGuestEmail] = useState("");
  const [createdMeeting, setCreatedMeeting] = useState<CreatedMeeting | null>(null);

  const staffQuery = useListMeetingStaff({
    query: { queryKey: getListMeetingStaffQueryKey(), staleTime: 30_000, refetchOnWindowFocus: true },
  });
  const calendarQuery = useQuery<CalendarStatus>({
    queryKey: ["/api/calendar/status"],
    queryFn: getQueryFn({ on401: "throw" }),
    staleTime: 30_000,
  });
  const contactsQuery = useQuery<MeetingContact[]>({
    queryKey: [`/api/crm/contacts?search=${encodeURIComponent(deferredInviteeSearch)}`],
    enabled: deferredInviteeSearch.length >= 2,
    staleTime: 10_000,
  });

  const createMeeting = useCreateStaffMeeting({
    mutation: {
      onSuccess: (result, variables) => {
        setCreatedMeeting({ input: variables.data, result });
        toast({ title: "Meeting scheduled", description: "Calendar invitations were sent to the selected people." });
      },
      onError: (error) => toast({
        title: "Meeting was not confirmed",
        description: error.message,
        variant: "destructive",
      }),
    },
  });

  const staff = staffQuery.data?.staff ?? [];
  const filteredStaff = deferredInviteeSearch.length >= 2
    ? staff.filter((person) => `${person.name} ${person.email}`.toLowerCase().includes(deferredInviteeSearch.toLowerCase()))
    : [];
  const toggleStaff = (person: MeetingStaff, checked: boolean | "indeterminate") => {
    setSelectedStaffIds((current) => {
      const next = new Set(current);
      if (checked) next.add(person.id);
      else next.delete(person.id);
      return next;
    });
  };
  const toggleGuest = (person: MeetingContact, checked: boolean) => {
    const email = person.email?.trim().toLowerCase();
    if (!email) return;
    setSelectedGuests((current) => {
      const next = new Map(current);
      if (checked) {
        if (next.size >= 20 && !next.has(email)) return current;
        next.set(email, { name: person.fullName.trim() || email, email });
      } else {
        next.delete(email);
      }
      return next;
    });
  };
  const addManualGuest = () => {
    const email = manualGuestEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast({ title: "Enter a valid email address", variant: "destructive" });
      return;
    }
    if (selectedGuests.size >= 20 && !selectedGuests.has(email)) {
      toast({ title: "Choose up to 20 external guests", variant: "destructive" });
      return;
    }
    setSelectedGuests((current) => new Map(current).set(email, { name: email, email }));
    setManualGuestEmail("");
  };

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!summary.trim()) {
      toast({ title: "Add a meeting title", variant: "destructive" });
      return;
    }
    if (!inviteAllStaff && selectedStaffIds.size === 0 && selectedGuests.size === 0) {
      toast({ title: "Choose meeting invitees", description: "Select staff, customer contacts, or add an email address.", variant: "destructive" });
      return;
    }
    const startsAt = new Date(startLocal);
    const endsAt = new Date(endLocal);
    if (!startLocal || !endLocal || !Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) {
      toast({ title: "Check the meeting time", description: "The end time must be after the start time.", variant: "destructive" });
      return;
    }

    const input: StaffMeetingInput = {
      summary: summary.trim(),
      description: description.trim() || undefined,
      startIso: startsAt.toISOString(),
      endIso: endsAt.toISOString(),
      timezone,
      provider,
      inviteAllStaff,
      staffIds: inviteAllStaff ? [] : [...selectedStaffIds],
      guestEmails: [...selectedGuests.values()],
    };
    setCreatedMeeting(null);
    createMeeting.mutate({ data: input });
  }

  const calendarReady = calendarQuery.data?.connected && calendarQuery.data.attachedCalendarId;
  const createdMeetingUrl = createdMeeting?.result.provider === "zoom"
    ? createdMeeting.result.zoomUrl
    : createdMeeting?.result.meetUrl;

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 lg:p-8">
      <header className="border-l-4 border-csd-red pl-4">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-csd-red">
          <Video className="h-4 w-4" /> Google Meet or Zoom + Slack
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">Schedule a staff meeting</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Create a Google Calendar invitation with a Google Meet or Zoom link. Invite everyone or choose staff, then share the details in the CSD notifications channel.
        </p>
      </header>

      {!calendarReady && !calendarQuery.isLoading && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">Connect a calendar before scheduling</p>
            <p className="mt-1">Choose the calendar used for staff meetings in Scheduling settings.</p>
            <Link href="/scheduling" className="mt-2 inline-flex items-center gap-1 font-semibold underline">
              Open calendar settings <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      )}

      {createdMeeting && (
        <Card className="border-emerald-200 bg-emerald-50/60">
          <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
              <div>
                <h2 className="font-semibold text-emerald-950">Meeting scheduled: {createdMeeting.input.summary}</h2>
                <p className="mt-1 text-sm text-emerald-900">
                  {formattedDate(createdMeeting.input.startIso)} · {createdMeeting.result.staffInvited} staff and {createdMeeting.result.guestInvited} guests invited
                </p>
                <p className="mt-2 text-sm text-emerald-900">
                  {createdMeeting.result.slackQueued
                    ? "Meeting details queued for the CSD notifications channel."
                    : "Calendar invitations were created, but the Slack announcement could not be queued."}
                </p>
                {createdMeeting.result.provider === "google_meet" && !createdMeeting.result.meetUrl && (
                  <p className="mt-2 text-sm text-amber-800">Google is still preparing the Meet link. Check the Calendar event for updates.</p>
                )}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2 pl-8 sm:pl-0">
              {createdMeetingUrl && (
                <Button asChild className="bg-csd-red hover:bg-red-700">
                  <a href={createdMeetingUrl} target="_blank" rel="noreferrer">
                    <Video className="mr-2 h-4 w-4" />
                    {createdMeeting.result.provider === "zoom" ? "Join Zoom" : "Join Meet"}
                  </a>
                </Button>
              )}
              {createdMeeting.result.eventUrl && (
                <Button asChild variant="outline">
                  <a href={createdMeeting.result.eventUrl} target="_blank" rel="noreferrer">
                    <CalendarDays className="mr-2 h-4 w-4" /> Open event
                  </a>
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <Card>
          <CardHeader>
            <CardTitle>Meeting details</CardTitle>
            <CardDescription>
              Calendar invitations are emailed to selected staff. Zoom meetings are hosted by the signed-in account; Google Meet uses the attached calendar.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2 text-sm font-medium sm:col-span-2">
                  Meeting title
                  <Input value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={200} required placeholder="Weekly operations review" />
                </label>
                <label className="space-y-2 text-sm font-medium sm:col-span-2">
                  Video meeting provider
                  <select
                    value={provider}
                    onChange={(event) => setProvider(event.target.value as MeetingProvider)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    aria-label="Video meeting provider"
                  >
                    <option value="google_meet">Google Meet</option>
                    <option value="zoom">Zoom</option>
                  </select>
                  {provider === "zoom" && (
                    <span className="block text-xs font-normal text-muted-foreground">
                      The signed-in account will host. It must be enabled as a Zoom user with meeting-host permission.
                    </span>
                  )}
                </label>
                <label className="space-y-2 text-sm font-medium">
                  Starts
                  <Input type="datetime-local" value={startLocal} onChange={(event) => setStartLocal(event.target.value)} required />
                </label>
                <label className="space-y-2 text-sm font-medium">
                  Ends
                  <Input type="datetime-local" value={endLocal} onChange={(event) => setEndLocal(event.target.value)} required />
                </label>
                <div className="flex items-center gap-2 text-xs text-muted-foreground sm:col-span-2">
                  <CalendarDays className="h-4 w-4" />
                  Times use your device time zone: <span className="font-medium text-foreground">{timezone}</span>
                </div>
                <label className="space-y-2 text-sm font-medium sm:col-span-2">
                  Agenda or notes <span className="font-normal text-muted-foreground">(optional)</span>
                  <Textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={4000} rows={4} placeholder="Topics to cover, preparation, or other details" />
                </label>
              </div>

              <fieldset className="space-y-3">
                <legend className="mb-2 text-sm font-semibold">Who should receive a Calendar invitation?</legend>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/40">
                  <input
                    type="radio"
                    name="invitees"
                    checked={!inviteAllStaff}
                    onChange={() => setInviteAllStaff(false)}
                    className="mt-1 accent-red-600"
                  />
                  <span>
                    <span className="block text-sm font-medium">Choose staff</span>
                    <span className="block text-xs text-muted-foreground">Search for approved staff or customer contacts below.</span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/40">
                  <input
                    type="radio"
                    name="invitees"
                    checked={inviteAllStaff}
                    onChange={() => setInviteAllStaff(true)}
                    className="mt-1 accent-red-600"
                  />
                  <span>
                    <span className="block text-sm font-medium">Invite all approved staff</span>
                    <span className="block text-xs text-muted-foreground">Send a Calendar invitation to every active staff member with an email address.</span>
                  </span>
                </label>

                <label className="relative block">
                  <span className="sr-only">Search staff and CRM customer contacts</span>
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={inviteeSearch}
                    onChange={(event) => setInviteeSearch(event.target.value)}
                    className="pl-9"
                    placeholder="Search by name or email"
                    autoComplete="off"
                    data-testid="meeting-invitee-search"
                  />
                  {inviteeSearch && <button type="button" aria-label="Clear invitee search" className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setInviteeSearch("")}><X className="h-4 w-4" /></button>}
                </label>
                {deferredInviteeSearch.length < 2 && (
                  <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">Type at least two characters to search staff and visible CRM contacts.</p>
                )}
                {access.role === "owner" && access.approvalStatus === "approved" && (
                  <MeetingOnboardingHelp search={deferredInviteeSearch} />
                )}

                {!inviteAllStaff && deferredInviteeSearch.length >= 2 && (
                  <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-2">
                    {staffQuery.isLoading && <p className="p-3 text-sm text-muted-foreground">Loading staff…</p>}
                    {staffQuery.isError && <p className="p-3 text-sm text-destructive">Could not load staff. Refresh the page and try again.</p>}
                    {!staffQuery.isLoading && !staffQuery.isError && filteredStaff.length === 0 && (
                      <p className="p-3 text-sm text-muted-foreground">No matching approved staff.</p>
                    )}
                    {filteredStaff.map((person) => (
                      <label key={person.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50">
                        <Checkbox
                          checked={selectedStaffIds.has(person.id)}
                          onCheckedChange={(checked) => toggleStaff(person, checked)}
                          aria-label={`Invite ${person.name}`}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{person.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">{person.email}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                {deferredInviteeSearch.length >= 2 && (
                  <div className="max-h-56 overflow-y-auto rounded-lg border p-2" aria-label="Customer contacts matching your search">
                    {contactsQuery.isFetching && <p className="p-3 text-sm text-muted-foreground">Searching customer contacts…</p>}
                    {contactsQuery.isError && <p className="p-3 text-sm text-destructive">Could not load customer contacts. You can still add an email address manually.</p>}
                    {!contactsQuery.isFetching && !contactsQuery.isError && (contactsQuery.data?.length ?? 0) === 0 && <p className="p-3 text-sm text-muted-foreground">No matching customer contacts.</p>}
                    {contactsQuery.data?.map((person) => {
                      const email = person.email?.trim().toLowerCase();
                      const checked = Boolean(email && selectedGuests.has(email));
                      return (
                        <label key={person.id} className={`flex items-center gap-3 rounded-md px-2 py-2 ${email ? "cursor-pointer hover:bg-muted/50" : "opacity-60"}`}>
                          <Checkbox
                            checked={checked}
                            disabled={!email || (selectedGuests.size >= 20 && !checked)}
                            onCheckedChange={(value) => toggleGuest(person, Boolean(value))}
                            aria-label={email ? `Invite ${person.fullName}` : `${person.fullName} has no email`}
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{person.fullName}</span>
                            <span className="block truncate text-xs text-muted-foreground">{person.email || "No email address on file"}{person.company ? ` · ${person.company}` : ""}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <Input
                    type="email"
                    value={manualGuestEmail}
                    onChange={(event) => setManualGuestEmail(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addManualGuest(); } }}
                    placeholder="Add a guest by email"
                    aria-label="Add an external meeting guest by email"
                    data-testid="meeting-manual-guest"
                  />
                  <Button type="button" variant="outline" onClick={addManualGuest} disabled={!manualGuestEmail.trim() || selectedGuests.size >= 20}>Add guest</Button>
                </div>
                {selectedGuests.size > 0 && (
                  <div className="flex flex-wrap gap-2" data-testid="meeting-selected-guests">
                    {[...selectedGuests.values()].map((guest) => (
                      <span key={guest.email} className="inline-flex items-center gap-1.5 rounded-full border bg-white px-2.5 py-1 text-xs">
                        <span className="max-w-56 truncate">{guest.name} · {guest.email}</span>
                        <button type="button" aria-label={`Remove ${guest.email}`} onClick={() => setSelectedGuests((current) => {
                          const next = new Map(current);
                          next.delete(guest.email);
                          return next;
                        })}><X className="h-3.5 w-3.5" /></button>
                      </span>
                    ))}
                  </div>
                )}
              </fieldset>

              <div className="flex flex-col gap-3 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <UsersRound className="h-4 w-4 shrink-0" />
                  {inviteAllStaff
                    ? `${staff.length} active staff and ${selectedGuests.size} guests will be invited.`
                    : `${selectedStaffIds.size} staff and ${selectedGuests.size} guests selected.`}
                </p>
                <Button
                  type="submit"
                  disabled={createMeeting.isPending || !calendarReady
                    || (inviteAllStaff && (staffQuery.isLoading || staffQuery.isError || staff.length === 0))
                    || (!inviteAllStaff && selectedStaffIds.size === 0 && selectedGuests.size === 0)
                    || (!inviteAllStaff && selectedStaffIds.size > 0 && (staffQuery.isLoading || staffQuery.isError))}
                  className="bg-csd-red hover:bg-red-700"
                >
                  <Video className="mr-2 h-4 w-4" />
                  {createMeeting.isPending ? "Scheduling…" : `Schedule ${provider === "zoom" ? "Zoom" : "Google Meet"}`}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <aside className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base"><Link2 className="h-4 w-4 text-csd-red" /> Connected services</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div>
                <p className="font-medium">Google Calendar + Meet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {calendarReady ? `Using ${calendarQuery.data?.attachedCalendarId}` : "A calendar must be attached in Scheduling settings."}
                </p>
              </div>
              <div className="border-t pt-3">
                <p className="font-medium">Zoom</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Zoom meeting links are created server-side and included in Calendar and Slack invitations.
                </p>
              </div>
              <div className="border-t pt-3">
                <p className="font-medium">Slack</p>
                <p className="mt-1 text-xs text-muted-foreground">Meeting details are queued to the existing CSD notifications channel after the Calendar event is created.</p>
              </div>
              <Link href="/scheduling" className="inline-flex items-center gap-1 text-xs font-semibold text-csd-red hover:underline">
                Calendar settings <ExternalLink className="h-3 w-3" />
              </Link>
            </CardContent>
          </Card>
          <div className="rounded-xl border bg-muted/30 p-4 text-xs leading-relaxed text-muted-foreground">
            Google Calendar sends the invitations. If the confirmation is uncertain, check the calendar before trying again to avoid duplicate invitations.
          </div>
        </aside>
      </div>
    </main>
  );
}
