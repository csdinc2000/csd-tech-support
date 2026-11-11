import { Fragment, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import ComplianceNotice from "@/components/compliance-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Phone, Plus, Search, Trash2, Workflow, BarChart3, Hash, RefreshCw, PhoneIncoming, PhoneOutgoing, Voicemail, UserRound, TicketPlus, ChevronDown, ChevronUp } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { TrackingNumber, CallFlow, Client } from "@shared/schema";
import TicketDetailDialog from "@/components/helpdesk/ticket-detail-dialog";

function fmtPhone(n?: string | null) {
  if (!n) return "—";
  const m = n.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : n;
}

export default function CallTrackingPage() {
  return (
    <div className="p-6 max-w-7xl mx-auto" data-testid="page-call-tracking">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Call Tracking</h1>
        <p className="text-muted-foreground">Multi-number tracking, call flows, and attribution analytics.</p>
      </div>
      <ComplianceNotice title="Call Recording Notice" className="mb-6">
        Calls may be recorded or monitored for quality assurance, training, security, and service
        documentation where permitted and with required consent. Florida requires all-party
        consent — ensure callers are notified before recording.
      </ComplianceNotice>
      <Tabs defaultValue="activity" className="w-full">
        <TabsList className="grid grid-cols-4 w-full max-w-2xl">
          <TabsTrigger value="activity" data-testid="tab-call-activity"><PhoneIncoming className="w-4 h-4 mr-2" />Call Activity</TabsTrigger>
          <TabsTrigger value="analytics" data-testid="tab-analytics"><BarChart3 className="w-4 h-4 mr-2" />Analytics</TabsTrigger>
          <TabsTrigger value="numbers" data-testid="tab-numbers"><Phone className="w-4 h-4 mr-2" />Numbers</TabsTrigger>
          <TabsTrigger value="flows" data-testid="tab-flows"><Workflow className="w-4 h-4 mr-2" />Call Flows</TabsTrigger>
        </TabsList>
        <TabsContent value="activity" className="mt-6"><CallActivityTab /></TabsContent>
        <TabsContent value="analytics" className="mt-6"><AnalyticsTab /></TabsContent>
        <TabsContent value="numbers" className="mt-6"><NumbersTab /></TabsContent>
        <TabsContent value="flows" className="mt-6"><FlowsTab /></TabsContent>
      </Tabs>
    </div>
  );
}

type TrackedCall = {
  id: number;
  callSid: string;
  fromNumber: string;
  toNumber: string;
  status: string;
  direction: string | null;
  durationSeconds: number;
  hadVoicemail: boolean;
  createdAt: string | null;
  sourceChannel: string | null;
  campaignName: string | null;
  trackingNumber: string | null;
  contactId: number | null;
  contactName: string | null;
  contactCompany?: string | null;
  clientId: number | null;
  clientName: string | null;
  supportTicketId: number | null;
  supportTicketNumber: string | null;
};

type ForwardingOutcome = {
  destinationNumber: string;
  attemptKey: string;
  providerStatus: string;
  providerDurationSeconds: number | null;
  providerUpdatedAt: string | null;
  humanAccepted: boolean | null;
  audibleHandsetRingingConfirmed: boolean;
};

function CallActivityTab() {
  const [search, setSearch] = useState("");
  const [expandedCallId, setExpandedCallId] = useState<number | null>(null);
  const [followUpCall, setFollowUpCall] = useState<TrackedCall | null>(null);
  const [followUpMode, setFollowUpMode] = useState<"contact" | "ticket">("contact");
  const [ticketDetailId, setTicketDetailId] = useState<number | null>(null);
  const { data: calls = [], isLoading, isError } = useQuery<TrackedCall[]>({
    queryKey: ["/api/call-tracking/calls"],
    refetchInterval: 30_000,
  });
  const term = search.trim().toLowerCase();
  const visibleCalls = term
    ? calls.filter((call) => [
        call.fromNumber,
        call.toNumber,
        call.contactName,
        call.clientName,
        call.campaignName,
        call.sourceChannel,
        call.supportTicketNumber,
      ].some((value) => value?.toLowerCase().includes(term)))
    : calls;

  return (
    <Card>
      <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>Recent Calls</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Calls are matched to CRM contacts by phone number and retain campaign attribution.
          </p>
        </div>
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search calls, contacts, or campaigns"
            className="pl-9"
            aria-label="Search call activity"
          />
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading call activity…</p>
        ) : isError ? (
          <p className="py-10 text-center text-sm text-destructive">Call activity could not be loaded.</p>
        ) : visibleCalls.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            <Phone className="mx-auto mb-3 h-10 w-10 opacity-30" />
            <p>{term ? "No calls match your search." : "No tracked calls have been received yet."}</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Caller</th>
                  <th className="px-4 py-3 font-medium">CRM match</th>
                  <th className="px-4 py-3 font-medium">Attribution</th>
                  <th className="px-4 py-3 font-medium">Outcome</th>
                  <th className="px-4 py-3 font-medium">When</th>
                  <th className="px-4 py-3 font-medium text-right">Follow-up</th>
                </tr>
              </thead>
              <tbody>
                {visibleCalls.map((call) => {
                  const outbound = call.direction === "outbound";
                  return (
                    <Fragment key={call.id}>
                    <tr className="border-t align-top hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 font-medium">
                          {outbound ? <PhoneOutgoing className="h-4 w-4 text-blue-600" /> : <PhoneIncoming className="h-4 w-4 text-emerald-600" />}
                          {fmtPhone(outbound ? call.toNumber : call.fromNumber)}
                          {!call.contactId && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2"
                              onClick={() => { setFollowUpMode("contact"); setFollowUpCall(call); }}
                              data-testid={`button-add-contact-call-${call.id}`}
                            >
                              <Plus className="mr-1 h-3.5 w-3.5" />Add contact
                            </Button>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{outbound ? "Outbound" : "Inbound"}</p>
                      </td>
                      <td className="px-4 py-3">
                        {call.contactName ? (
                          <>
                            <Link href="/crm/contacts" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                              <UserRound className="h-3.5 w-3.5" />{call.contactName}
                            </Link>
                            <p className="mt-1 text-xs text-muted-foreground">{call.clientName || "No customer account linked"}</p>
                          </>
                        ) : (
                          <span className="text-muted-foreground">Unmatched caller</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <p>{call.campaignName || call.sourceChannel || "Unattributed"}</p>
                        {call.campaignName && call.sourceChannel && <p className="mt-1 text-xs text-muted-foreground">{call.sourceChannel}</p>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={call.status === "completed" ? "secondary" : "outline"}>{call.status}</Badge>
                          {call.hadVoicemail && <Voicemail className="h-4 w-4 text-muted-foreground" aria-label="Voicemail" />}
                          {!outbound && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2"
                              aria-expanded={expandedCallId === call.id}
                              onClick={() => setExpandedCallId(expandedCallId === call.id ? null : call.id)}
                              data-testid={`button-forwarding-outcomes-${call.id}`}
                            >
                              {expandedCallId === call.id
                                ? <><ChevronUp className="mr-1 h-3.5 w-3.5" />Destinations</>
                                : <><ChevronDown className="mr-1 h-3.5 w-3.5" />Destinations</>}
                            </Button>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{call.durationSeconds}s</p>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {call.createdAt ? formatDistanceToNow(new Date(call.createdAt), { addSuffix: true }) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {call.supportTicketId ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setTicketDetailId(call.supportTicketId)}
                            data-testid={`button-open-ticket-call-${call.id}`}
                          >
                            <TicketPlus className="mr-1.5 h-4 w-4" />
                            {call.supportTicketNumber || `Ticket #${call.supportTicketId}`}
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => { setFollowUpMode("ticket"); setFollowUpCall(call); }}
                            data-testid={`button-create-ticket-call-${call.id}`}
                          >
                            <TicketPlus className="mr-1.5 h-4 w-4" />Create ticket
                          </Button>
                        )}
                      </td>
                    </tr>
                    {expandedCallId === call.id && !outbound && (
                      <tr key={`forwarding-${call.id}`} className="border-t bg-muted/20">
                        <td colSpan={6} className="px-4 py-3">
                          <CallForwardingOutcomes callId={call.id} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
      {followUpCall && (
        <CallFollowUpDialog
          call={followUpCall}
          initialMode={followUpMode}
          onClose={() => setFollowUpCall(null)}
        />
      )}
      {ticketDetailId && (
        <TicketDetailDialog
          ticketId={ticketDetailId}
          open
          onClose={() => setTicketDetailId(null)}
        />
      )}
    </Card>
  );
}

function CallForwardingOutcomes({ callId }: { callId: number }) {
  const { data, isLoading, isError } = useQuery<{
    outcomes: ForwardingOutcome[];
    interpretation: string;
  }>({
    queryKey: [`/api/call-tracking/calls/${callId}/forwarding-outcomes`],
    staleTime: 15_000,
  });

  const targetName = (key: string) => ({
    primary: "Primary",
    backup1: "Backup 1",
    backup2: "Backup 2",
    tracking: "Tracking destination",
    staff: "Staff phone",
    other: "Other destination",
  }[key] || "Other destination");
  const providerStatusText = (outcome: ForwardingOutcome) => {
    switch (outcome.providerStatus) {
      case "ringing": return "Twilio reports ringing";
      case "in-progress": return "Twilio reports connected";
      case "completed": return "Twilio reports completed";
      case "no-answer": return "No answer";
      case "busy": return "Busy";
      case "failed": return "Could not connect";
      case "canceled": return "Canceled";
      case "queued":
      case "initiated": return "Twilio call starting";
      default: return "Provider status unavailable";
    }
  };
  const acceptanceText = (outcome: ForwardingOutcome) => outcome.humanAccepted === true
    ? "Human acceptance confirmed (pressed 1)"
    : "Human acceptance not confirmed";

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading forwarding results…</p>;
  if (isError) return <p className="text-sm text-destructive">Forwarding results could not be loaded.</p>;
  if (!data?.outcomes.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Twilio has no forwarding call-leg records for this call.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="font-medium">Forwarding destinations</p>
        <p className="mt-1 text-xs text-muted-foreground">{data.interpretation}</p>
      </div>
      <div className="space-y-2">
        {data.outcomes.map((outcome, index) => (
          <div key={`${outcome.attemptKey}-${outcome.destinationNumber}-${index}`} className="flex flex-col gap-1 rounded-md border bg-background px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <span className="font-medium">{targetName(outcome.attemptKey)}</span>
              <span className="ml-2 font-mono text-sm">{fmtPhone(outcome.destinationNumber)}</span>
            </div>
            <div className="text-sm">
              <span>{providerStatusText(outcome)}</span>
              <span className="ml-2 text-xs text-muted-foreground">{acceptanceText(outcome)}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                Handset audibility not confirmed
                {outcome.providerDurationSeconds != null ? ` · ${outcome.providerDurationSeconds}s` : ""}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CallFollowUpDialog({
  call,
  initialMode,
  onClose,
}: {
  call: TrackedCall;
  initialMode: "contact" | "ticket";
  onClose: () => void;
}) {
  const { toast } = useToast();
  const callerPhone = call.direction === "outbound" ? call.toNumber : call.fromNumber;
  const needsContact = !call.contactId;
  const [fullName, setFullName] = useState(call.contactName || "");
  const [phone, setPhone] = useState(callerPhone);
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState(call.contactCompany || "");
  const [clientId, setClientId] = useState(call.clientId ? String(call.clientId) : "none");
  const [note, setNote] = useState("");
  const [createTicket, setCreateTicket] = useState(initialMode === "ticket");
  const [ticketSubject, setTicketSubject] = useState(`Follow up: ${call.contactName || fmtPhone(callerPhone)}`);
  const [serviceDeliveryType, setServiceDeliveryType] = useState("");
  const [smsConsent, setSmsConsent] = useState("unconfirmed");
  const [savedContact, setSavedContact] = useState<{ id: number; fullName: string | null; clientId: number | null } | null>(
    call.contactId ? { id: call.contactId, fullName: call.contactName, clientId: call.clientId } : null,
  );
  const { data: clients = [] } = useQuery<Client[]>({ queryKey: ["/api/clients"] });

  const save = useMutation({
    mutationFn: async () => {
      let contact = savedContact;

      if (!contact) {
        const response = await apiRequest("POST", `/api/call-tracking/calls/${call.id}/contact`, {
          fullName: fullName.trim(),
          mobilePhone: phone.trim(),
          email: email.trim() || null,
          company: company.trim() || null,
          notes: note.trim() || null,
          clientId: clientId === "none" ? null : Number(clientId),
        });
        contact = await response.json();
        setSavedContact(contact);
        queryClient.invalidateQueries({ queryKey: ["/api/call-tracking/calls"] });
        queryClient.invalidateQueries({ queryKey: ["/api/crm/contacts"] });
      }

      let ticket = null;
      if (createTicket) {
        const callContext = [
          note.trim(),
          "",
          `Call: ${call.direction === "outbound" ? "Outbound to" : "Inbound from"} ${fmtPhone(callerPhone)}`,
          `Status: ${call.status}; duration: ${call.durationSeconds}s`,
          call.campaignName || call.sourceChannel
            ? `Attribution: ${call.campaignName || call.sourceChannel}`
            : null,
          `Call SID: ${call.callSid}`,
        ].filter(Boolean).join("\n");
        const response = await apiRequest("POST", `/api/call-tracking/calls/${call.id}/ticket`, {
          subject: ticketSubject.trim(),
          description: callContext,
          priority: "medium",
          status: "open",
          source: "phone",
          clientId: contact?.clientId || (clientId === "none" ? null : Number(clientId)),
          requesterName: fullName.trim(),
          requesterEmail: email.trim() || null,
          requesterPhone: phone.trim(),
          intake: {
            customerName: fullName.trim(),
            contactPhone: phone.trim(),
            company: company.trim(),
            issueSummary: note.trim(),
            serviceDeliveryType,
            smsConsent: smsConsent === "yes",
          },
        });
        ticket = await response.json();
      }
      return { contact, ticket };
    },
    onSuccess: ({ ticket }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/call-tracking/calls"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/contacts"] });
      if (ticket) {
        queryClient.invalidateQueries({ queryKey: ["/api/tickets"] });
        queryClient.invalidateQueries({ queryKey: ["/api/tickets/open"] });
      }
      toast({
        title: ticket?.alreadyLinked
          ? "This call already has a support ticket"
          : ticket
            ? "Contact and support ticket ready"
            : "Contact created",
        description: ticket?.ticketNumber
          ? ticket.alreadyLinked
            ? `Ticket ${ticket.ticketNumber} is linked to this call.`
            : `Ticket ${ticket.ticketNumber}: ${ticket.assignedTechName ? `assigned to ${ticket.assignedTechName}` : "saved unassigned — no eligible technician"}.${
                smsConsent === "yes" && ticket.effectiveSmsConsent === false
                  ? " Text updates remain blocked; the caller must text START to opt back in."
                  : ""
              }`
          : undefined,
      });
      onClose();
    },
    onError: (error: any) => {
      toast({ title: "Follow-up could not be saved", description: error?.message, variant: "destructive" });
    },
  });

  const canSubmit =
    fullName.trim() && phone.trim() &&
    (!createTicket || (ticketSubject.trim() && note.trim() && serviceDeliveryType && smsConsent !== "unconfirmed")) &&
    !save.isPending;

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !save.isPending) onClose(); }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{needsContact ? "Create contact from call" : "Create support ticket from call"}</DialogTitle>
        </DialogHeader>
        <fieldset disabled={save.isPending} className="space-y-4">
          {!needsContact && <p className="text-xs text-muted-foreground">Intake details below are saved on the ticket; the existing contact is not changed.</p>}
          {(
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="call-contact-name">Contact name</Label>
                <Input id="call-contact-name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="call-contact-phone">Phone</Label>
                <Input id="call-contact-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="call-contact-email">Email</Label>
                <Input id="call-contact-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Optional" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="call-contact-company">Company</Label>
                <Input id="call-contact-company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Optional" />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Customer account</Label>
                <Select value={clientId} onValueChange={setClientId} disabled={!needsContact}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No customer account</SelectItem>
                    {clients.map((client) => <SelectItem key={client.id} value={String(client.id)}>{client.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="call-quick-note">{createTicket ? "Short issue summary (required)" : "Quick note"}</Label>
            <Textarea
              id="call-quick-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What did the caller need, and what should happen next?"
              rows={4}
            />
            <p className="text-xs text-muted-foreground">
              {needsContact ? "Saved on the CRM contact" : "Included in the support ticket"}.
            </p>
          </div>

          {needsContact && (
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="create-ticket-switch">Create support ticket</Label>
                <p className="text-xs text-muted-foreground">Open a follow-up ticket after saving the contact.</p>
              </div>
              <Switch id="create-ticket-switch" checked={createTicket} onCheckedChange={setCreateTicket} />
            </div>
          )}

          {createTicket && (
            <div className="space-y-4">
              <div className="space-y-2">
              <Label htmlFor="call-ticket-subject">Ticket subject</Label>
              <Input id="call-ticket-subject" value={ticketSubject} onChange={(e) => setTicketSubject(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="call-service-delivery">Service delivery (required)</Label>
                <Select value={serviceDeliveryType} onValueChange={setServiceDeliveryType}>
                  <SelectTrigger id="call-service-delivery"><SelectValue placeholder="Select service delivery" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="in-shop">In-Shop</SelectItem>
                    <SelectItem value="on-site">On-Site Mobile</SelectItem>
                    <SelectItem value="remote">Remote Support</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 rounded-lg border p-3">
                <Label htmlFor="call-sms-consent">SMS service-update consent (required)</Label>
                <p className="text-xs text-muted-foreground">Read this to the caller and record their answer:</p>
                <p className="text-sm">Do you agree to receive automated text messages from Computer Systems Depot Inc. at this mobile number regarding your service request, including repair/ticket status updates and reminders? Message and data rates may apply. You can reply STOP to unsubscribe at any time.</p>
                <Select value={smsConsent} onValueChange={setSmsConsent}>
                  <SelectTrigger id="call-sms-consent"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unconfirmed">Not yet confirmed</SelectItem>
                    <SelectItem value="yes">Caller explicitly agreed</SelectItem>
                    <SelectItem value="no">Caller declined text updates</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Service updates only, not marketing. Previous STOP requests remain blocked until the caller texts START.</p>
              </div>
              <p className="text-xs text-muted-foreground">Tickets rotate among approved, enabled, on-duty technicians with fewer than five open high-priority tickets. If none are eligible, the ticket is saved unassigned for review.</p>
            </div>
          )}
        </fieldset>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!canSubmit}>
            {save.isPending ? "Saving…" : createTicket ? "Save and create ticket" : "Create contact"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── NUMBERS TAB ────────────────────────────────────────────────────────────
function NumbersTab() {
  const { toast } = useToast();
  const { data: numbers = [], isLoading } = useQuery<TrackingNumber[]>({ queryKey: ["/api/call-tracking/numbers"] });
  const { data: flows = [] } = useQuery<CallFlow[]>({ queryKey: ["/api/call-tracking/flows"] });
  const [searchOpen, setSearchOpen] = useState(false);
  const [addManualOpen, setAddManualOpen] = useState(false);
  const [editing, setEditing] = useState<TrackingNumber | null>(null);

  // Unified sync — points the main business line AND every tracking number at
  // this app's webhooks (same action as Phone Settings → Sync all numbers).
  const sync = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/twilio/sync-webhooks", {}),
    onSuccess: () => toast({ title: "Webhooks synced", description: "Main line and all tracking numbers now point at this app." }),
    onError: (e: any) => toast({ title: "Sync failed", description: e?.message, variant: "destructive" }),
  });

  const del = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/call-tracking/numbers/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/call-tracking/numbers"] });
      toast({ title: "Number removed" });
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Tracking Numbers</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">Each number has its own campaign attribution and call flow.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => sync.mutate()} disabled={sync.isPending} data-testid="button-sync-webhooks">
            <RefreshCw className={`w-4 h-4 mr-2 ${sync.isPending ? "animate-spin" : ""}`} />Sync All Numbers
          </Button>
          <Button variant="outline" size="sm" onClick={() => setAddManualOpen(true)} data-testid="button-add-manual">
            <Plus className="w-4 h-4 mr-2" />Add Existing
          </Button>
          <Button size="sm" onClick={() => setSearchOpen(true)} data-testid="button-provision">
            <Search className="w-4 h-4 mr-2" />Provision New
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : numbers.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Phone className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No tracking numbers yet. Provision your first to start attributing calls.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {numbers.map((n) => (
              <div key={n.id} className="flex items-center justify-between p-4 border rounded-lg hover-elevate" data-testid={`number-row-${n.id}`}>
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <span className="font-mono font-semibold">{fmtPhone(n.phoneNumber)}</span>
                    <Badge variant={n.numberType === "tollfree" ? "default" : "secondary"}>{n.numberType}</Badge>
                    {!n.active && <Badge variant="outline">Inactive</Badge>}
                  </div>
                  <div className="text-sm text-muted-foreground mt-1">
                    {n.campaignName || n.friendlyName || "No campaign"}
                    {n.sourceChannel && <span> · {n.sourceChannel}</span>}
                    {n.keywords && <span> · "{n.keywords}"</span>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Forwards to: {fmtPhone(n.forwardToNumber) || "global default"}
                    {" · "}Flow: {flows.find((f) => f.id === n.callFlowId)?.name || "global default"}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(n)} data-testid={`button-edit-${n.id}`}>Edit</Button>
                  <Button variant="ghost" size="sm" onClick={() => del.mutate(n.id)} data-testid={`button-delete-${n.id}`}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} flows={flows} />
      <ManualAddDialog open={addManualOpen} onOpenChange={setAddManualOpen} flows={flows} />
      {editing && <EditNumberDialog number={editing} flows={flows} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function SearchDialog({ open, onOpenChange, flows }: { open: boolean; onOpenChange: (v: boolean) => void; flows: CallFlow[] }) {
  const { toast } = useToast();
  const [type, setType] = useState<"local" | "tollfree">("local");
  const [areaCode, setAreaCode] = useState("");
  const [contains, setContains] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [campaign, setCampaign] = useState("");
  const [channel, setChannel] = useState("");
  const [keywords, setKeywords] = useState("");
  const [callFlowId, setCallFlowId] = useState<string>("none");
  const [forwardTo, setForwardTo] = useState("");

  async function doSearch() {
    setSearching(true);
    try {
      const res = await apiRequest("POST", "/api/call-tracking/numbers/search", { type, areaCode: areaCode || undefined, contains: contains || undefined, limit: 12 });
      setResults(await res.json());
    } catch (e: any) { toast({ title: "Search failed", description: e?.message, variant: "destructive" }); }
    finally { setSearching(false); }
  }

  async function buy(phoneNumber: string) {
    try {
      await apiRequest("POST", "/api/call-tracking/numbers/purchase", {
        phoneNumber, numberType: type,
        campaignName: campaign || undefined, sourceChannel: channel || undefined, keywords: keywords || undefined,
        callFlowId: callFlowId !== "none" ? parseInt(callFlowId, 10) : undefined,
        forwardToNumber: forwardTo || undefined,
      });
      toast({ title: "Number purchased", description: `${phoneNumber} is now active.` });
      queryClient.invalidateQueries({ queryKey: ["/api/call-tracking/numbers"] });
      onOpenChange(false);
    } catch (e: any) { toast({ title: "Purchase failed", description: e?.message, variant: "destructive" }); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Provision a Tracking Number</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as any)}>
                <SelectTrigger data-testid="select-number-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">Local</SelectItem>
                  <SelectItem value="tollfree">Toll-Free</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label>Area Code</Label><Input value={areaCode} onChange={(e) => setAreaCode(e.target.value)} placeholder="e.g. 954" data-testid="input-area-code" /></div>
            <div><Label>Contains</Label><Input value={contains} onChange={(e) => setContains(e.target.value)} placeholder="digits/letters" data-testid="input-contains" /></div>
          </div>
          <Button onClick={doSearch} disabled={searching} data-testid="button-search-numbers">
            <Search className="w-4 h-4 mr-2" />{searching ? "Searching…" : "Search Available Numbers"}
          </Button>

          {results.length > 0 && (
            <>
              <div className="border-t pt-4 grid grid-cols-2 gap-3">
                <div><Label>Campaign Name</Label><Input value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="Spring Promo" /></div>
                <div><Label>Source Channel</Label><Input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="Google PPC" /></div>
                <div><Label>Keywords</Label><Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="emergency it support" /></div>
                <div><Label>Forward To (optional)</Label><Input value={forwardTo} onChange={(e) => setForwardTo(e.target.value)} placeholder="+19542533135" /></div>
                <div className="col-span-2">
                  <Label>Call Flow</Label>
                  <Select value={callFlowId} onValueChange={setCallFlowId}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— Use global default —</SelectItem>
                      {flows.map((f) => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="border-t pt-4 space-y-1">
                <p className="text-sm font-medium">Available numbers:</p>
                {results.map((r) => (
                  <div key={r.phoneNumber} className="flex items-center justify-between p-2 border rounded">
                    <div>
                      <div className="font-mono">{fmtPhone(r.phoneNumber)}</div>
                      <div className="text-xs text-muted-foreground">{r.locality || ""} {r.region || ""}</div>
                    </div>
                    <Button size="sm" onClick={() => buy(r.phoneNumber)} data-testid={`button-buy-${r.phoneNumber}`}>Purchase</Button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ManualAddDialog({ open, onOpenChange, flows }: { open: boolean; onOpenChange: (v: boolean) => void; flows: CallFlow[] }) {
  const { toast } = useToast();
  const [form, setForm] = useState({ phoneNumber: "", friendlyName: "", numberType: "local", campaignName: "", sourceChannel: "", keywords: "", forwardToNumber: "", callFlowId: "none" });
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  async function save() {
    try {
      await apiRequest("POST", "/api/call-tracking/numbers", {
        phoneNumber: form.phoneNumber, friendlyName: form.friendlyName || null,
        numberType: form.numberType, campaignName: form.campaignName || null,
        sourceChannel: form.sourceChannel || null, keywords: form.keywords || null,
        forwardToNumber: form.forwardToNumber || null,
        callFlowId: form.callFlowId !== "none" ? parseInt(form.callFlowId, 10) : null,
        smsAutoReplyEnabled: false, active: true,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/call-tracking/numbers"] });
      toast({ title: "Tracking number added" });
      onOpenChange(false);
    } catch (e: any) { toast({ title: "Add failed", description: e?.message, variant: "destructive" }); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add Existing Twilio Number</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><Label>Phone Number (E.164)</Label><Input value={form.phoneNumber} onChange={(e) => set("phoneNumber", e.target.value)} placeholder="+19546377300" /></div>
          <div><Label>Friendly Name</Label><Input value={form.friendlyName} onChange={(e) => set("friendlyName", e.target.value)} /></div>
          <div>
            <Label>Type</Label>
            <Select value={form.numberType} onValueChange={(v) => set("numberType", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="local">Local</SelectItem><SelectItem value="tollfree">Toll-Free</SelectItem></SelectContent>
            </Select>
          </div>
          <div><Label>Campaign</Label><Input value={form.campaignName} onChange={(e) => set("campaignName", e.target.value)} /></div>
          <div><Label>Source Channel</Label><Input value={form.sourceChannel} onChange={(e) => set("sourceChannel", e.target.value)} /></div>
          <div><Label>Keywords</Label><Input value={form.keywords} onChange={(e) => set("keywords", e.target.value)} /></div>
          <div><Label>Forward To</Label><Input value={form.forwardToNumber} onChange={(e) => set("forwardToNumber", e.target.value)} placeholder="+1…" /></div>
          <div className="col-span-2">
            <Label>Call Flow</Label>
            <Select value={form.callFlowId} onValueChange={(v) => set("callFlowId", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— Global default —</SelectItem>
                {flows.map((f) => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter><Button onClick={save} data-testid="button-save-manual-number">Add</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditNumberDialog({ number, flows, onClose }: { number: TrackingNumber; flows: CallFlow[]; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    friendlyName: number.friendlyName ?? "",
    campaignName: number.campaignName ?? "",
    sourceChannel: number.sourceChannel ?? "",
    keywords: number.keywords ?? "",
    forwardToNumber: number.forwardToNumber ?? "",
    callFlowId: number.callFlowId ? String(number.callFlowId) : "none",
    smsAutoReplyEnabled: number.smsAutoReplyEnabled,
    smsAutoReplyText: number.smsAutoReplyText ?? "",
    voicemailGreeting: number.voicemailGreeting ?? "",
    active: number.active,
  });
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  async function save() {
    try {
      await apiRequest("PATCH", `/api/call-tracking/numbers/${number.id}`, {
        friendlyName: form.friendlyName || null,
        campaignName: form.campaignName || null,
        sourceChannel: form.sourceChannel || null,
        keywords: form.keywords || null,
        forwardToNumber: form.forwardToNumber || null,
        callFlowId: form.callFlowId !== "none" ? parseInt(form.callFlowId, 10) : null,
        smsAutoReplyEnabled: form.smsAutoReplyEnabled,
        smsAutoReplyText: form.smsAutoReplyText || null,
        voicemailGreeting: form.voicemailGreeting || null,
        active: form.active,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/call-tracking/numbers"] });
      toast({ title: "Saved" });
      onClose();
    } catch (e: any) { toast({ title: "Save failed", description: e?.message, variant: "destructive" }); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Edit {fmtPhone(number.phoneNumber)}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Friendly Name</Label><Input value={form.friendlyName} onChange={(e) => set("friendlyName", e.target.value)} /></div>
          <div><Label>Campaign</Label><Input value={form.campaignName} onChange={(e) => set("campaignName", e.target.value)} /></div>
          <div><Label>Source Channel</Label><Input value={form.sourceChannel} onChange={(e) => set("sourceChannel", e.target.value)} /></div>
          <div><Label>Keywords</Label><Input value={form.keywords} onChange={(e) => set("keywords", e.target.value)} /></div>
          <div><Label>Forward To</Label><Input value={form.forwardToNumber} onChange={(e) => set("forwardToNumber", e.target.value)} /></div>
          <div>
            <Label>Call Flow</Label>
            <Select value={form.callFlowId} onValueChange={(v) => set("callFlowId", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— Global default —</SelectItem>
                {flows.map((f) => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2 flex items-center justify-between p-3 border rounded">
            <div><Label>Active</Label><p className="text-xs text-muted-foreground">Inactive numbers ignore inbound calls.</p></div>
            <Switch checked={form.active} onCheckedChange={(v) => set("active", v)} />
          </div>
          <div className="col-span-2 flex items-center justify-between p-3 border rounded">
            <Label>SMS Auto-Reply</Label>
            <Switch checked={form.smsAutoReplyEnabled} onCheckedChange={(v) => set("smsAutoReplyEnabled", v)} />
          </div>
          {form.smsAutoReplyEnabled && (
            <div className="col-span-2"><Label>Auto-Reply Text</Label><Textarea rows={3} value={form.smsAutoReplyText} onChange={(e) => set("smsAutoReplyText", e.target.value)} /></div>
          )}
          <div className="col-span-2"><Label>Voicemail Greeting (overrides global)</Label><Textarea rows={2} value={form.voicemailGreeting} onChange={(e) => set("voicemailGreeting", e.target.value)} /></div>
        </div>
        <DialogFooter><Button onClick={save} data-testid="button-save-edit">Save Changes</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── FLOWS TAB ──────────────────────────────────────────────────────────────
function FlowsTab() {
  const { toast } = useToast();
  const { data: flows = [] } = useQuery<CallFlow[]>({ queryKey: ["/api/call-tracking/flows"] });
  const [editing, setEditing] = useState<CallFlow | null>(null);
  const [creating, setCreating] = useState(false);

  const del = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/call-tracking/flows/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/call-tracking/flows"] }); toast({ title: "Flow deleted" }); },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Call Flows</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">Reusable multi-step routing logic. Assign to one or more tracking numbers.</p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)} data-testid="button-new-flow"><Plus className="w-4 h-4 mr-2" />New Flow</Button>
      </CardHeader>
      <CardContent>
        {flows.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Workflow className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No call flows yet. Create one to define multi-step routing.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {flows.map((f) => {
              const stepCount = Array.isArray(f.steps) ? (f.steps as any[]).length : 0;
              return (
                <div key={f.id} className="flex items-center justify-between p-4 border rounded-lg" data-testid={`flow-row-${f.id}`}>
                  <div>
                    <div className="font-semibold">{f.name}</div>
                    <div className="text-xs text-muted-foreground">{stepCount} step{stepCount === 1 ? "" : "s"} · {f.description || "No description"}</div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(f)}>Edit</Button>
                    <Button variant="ghost" size="sm" onClick={() => del.mutate(f.id)}><Trash2 className="w-4 h-4" /></Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
      {(creating || editing) && (
        <FlowEditor flow={editing} onClose={() => { setEditing(null); setCreating(false); }} />
      )}
    </Card>
  );
}

function FlowEditor({ flow, onClose }: { flow: CallFlow | null; onClose: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState(flow?.name ?? "");
  const [description, setDescription] = useState(flow?.description ?? "");
  const [steps, setSteps] = useState<any[]>(Array.isArray(flow?.steps) ? (flow!.steps as any[]) : []);

  const STEP_TEMPLATES: Record<string, any> = {
    say: { type: "say", text: "Thank you for calling.", voice: "Polly.Joanna" },
    menu: { type: "menu", prompt: "Press 1 for sales, 2 for support.", options: [{ digit: "1", goto: 1 }, { digit: "2", goto: 2 }] },
    dial: { type: "dial", to: "+19542533135", timeout: 25, whisper: true, callerId: "original" },
    voicemail: { type: "voicemail", greeting: "Please leave a message after the tone.", maxLength: 120, transcribe: true },
    sms: { type: "sms", body: "Thanks for calling — here's a link to our intake form: https://bit.ly/4tZm0g5" },
    hangup: { type: "hangup" },
    goto: { type: "goto", step: 0 },
  };

  function addStep(t: string) { setSteps([...steps, { ...STEP_TEMPLATES[t] }]); }
  function updateStep(i: number, patch: any) { setSteps(steps.map((s, idx) => idx === i ? { ...s, ...patch } : s)); }
  function removeStep(i: number) { setSteps(steps.filter((_, idx) => idx !== i)); }
  function moveStep(i: number, dir: -1 | 1) {
    const j = i + dir; if (j < 0 || j >= steps.length) return;
    const next = [...steps]; [next[i], next[j]] = [next[j], next[i]]; setSteps(next);
  }

  async function save() {
    if (!name.trim()) { toast({ title: "Name required", variant: "destructive" }); return; }
    try {
      const payload = { name, description: description || null, steps, active: true };
      if (flow) await apiRequest("PATCH", `/api/call-tracking/flows/${flow.id}`, payload);
      else await apiRequest("POST", "/api/call-tracking/flows", payload);
      queryClient.invalidateQueries({ queryKey: ["/api/call-tracking/flows"] });
      toast({ title: "Saved" }); onClose();
    } catch (e: any) { toast({ title: "Save failed", description: e?.message, variant: "destructive" }); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{flow ? "Edit Flow" : "New Call Flow"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-flow-name" /></div>
            <div><Label>Description</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          </div>

          <div className="border rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <Label>Steps</Label>
              <Select onValueChange={(v) => addStep(v)}>
                <SelectTrigger className="w-40"><SelectValue placeholder="+ Add step…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="say">Say (text)</SelectItem>
                  <SelectItem value="menu">Menu (gather digit)</SelectItem>
                  <SelectItem value="dial">Dial (forward)</SelectItem>
                  <SelectItem value="voicemail">Voicemail</SelectItem>
                  <SelectItem value="sms">Send SMS</SelectItem>
                  <SelectItem value="goto">Goto step</SelectItem>
                  <SelectItem value="hangup">Hang up</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {steps.length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">No steps. Add one above to start.</p>}
            {steps.map((s, i) => (
              <div key={i} className="border rounded p-3 space-y-2 bg-muted/30" data-testid={`step-${i}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2"><Hash className="w-4 h-4" /><span className="font-mono text-xs">step {i}</span><Badge>{s.type}</Badge></div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => moveStep(i, -1)}>↑</Button>
                    <Button size="sm" variant="ghost" onClick={() => moveStep(i, 1)}>↓</Button>
                    <Button size="sm" variant="ghost" onClick={() => removeStep(i)}><Trash2 className="w-4 h-4" /></Button>
                  </div>
                </div>
                <StepFields step={s} onChange={(p) => updateStep(i, p)} />
              </div>
            ))}
          </div>
        </div>
        <DialogFooter><Button onClick={save} data-testid="button-save-flow">Save Flow</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepFields({ step, onChange }: { step: any; onChange: (p: any) => void }) {
  switch (step.type) {
    case "say":
      return <div><Label>Text to speak</Label><Textarea rows={2} value={step.text || ""} onChange={(e) => onChange({ text: e.target.value })} /></div>;
    case "menu":
      return (
        <div className="space-y-2">
          <div><Label>Prompt</Label><Textarea rows={2} value={step.prompt || ""} onChange={(e) => onChange({ prompt: e.target.value })} /></div>
          <Label>Options (digit → goto step #)</Label>
          {(step.options || []).map((o: any, i: number) => (
            <div key={i} className="flex gap-2">
              <Input className="w-16" value={o.digit} onChange={(e) => { const opts = [...step.options]; opts[i] = { ...o, digit: e.target.value }; onChange({ options: opts }); }} />
              <Input type="number" className="w-24" value={o.goto} onChange={(e) => { const opts = [...step.options]; opts[i] = { ...o, goto: parseInt(e.target.value, 10) }; onChange({ options: opts }); }} />
              <Button size="sm" variant="ghost" onClick={() => { const opts = step.options.filter((_: any, j: number) => j !== i); onChange({ options: opts }); }}>×</Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={() => onChange({ options: [...(step.options || []), { digit: "0", goto: 0 }] })}>+ Option</Button>
        </div>
      );
    case "dial":
      return (
        <div className="grid grid-cols-2 gap-2">
          <div><Label>Forward to</Label><Input value={step.to || ""} onChange={(e) => onChange({ to: e.target.value })} placeholder="+1…" /></div>
          <div><Label>Timeout (sec)</Label><Input type="number" value={step.timeout || 25} onChange={(e) => onChange({ timeout: parseInt(e.target.value, 10) })} /></div>
          <div className="flex items-center gap-2"><Switch checked={!!step.whisper} onCheckedChange={(v) => onChange({ whisper: v })} /><Label>Whisper announcement</Label></div>
          <div>
            <Label>Caller ID</Label>
            <Select value={step.callerId || "original"} onValueChange={(v) => onChange({ callerId: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="original">Original Caller</SelectItem><SelectItem value="tracking">Tracking Number</SelectItem></SelectContent>
            </Select>
          </div>
        </div>
      );
    case "voicemail":
      return (
        <div className="space-y-2">
          <div><Label>Greeting</Label><Textarea rows={2} value={step.greeting || ""} onChange={(e) => onChange({ greeting: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>Max length (sec)</Label><Input type="number" value={step.maxLength || 120} onChange={(e) => onChange({ maxLength: parseInt(e.target.value, 10) })} /></div>
            <div className="flex items-center gap-2 mt-6"><Switch checked={!!step.transcribe} onCheckedChange={(v) => onChange({ transcribe: v })} /><Label>Transcribe</Label></div>
          </div>
        </div>
      );
    case "sms":
      return <div><Label>SMS body to send to caller</Label><Textarea rows={2} value={step.body || ""} onChange={(e) => onChange({ body: e.target.value })} /></div>;
    case "goto":
      return <div><Label>Jump to step #</Label><Input type="number" value={step.step ?? 0} onChange={(e) => onChange({ step: parseInt(e.target.value, 10) })} /></div>;
    default:
      return <p className="text-xs text-muted-foreground">No options for this step.</p>;
  }
}

// SMS lives in the unified Messages inbox (Phone & Text → Messages), which shows
// every conversation across the main line and all tracking numbers and replies
// from the number the customer contacted. The former per-number SMS tab here was
// a redundant view over the same data and has been removed.

// ── ANALYTICS TAB ──────────────────────────────────────────────────────────
function AnalyticsTab() {
  const { data: byNumber = [] } = useQuery<any[]>({ queryKey: ["/api/call-tracking/analytics/by-number"] });
  const { data: byChannel = [] } = useQuery<any[]>({ queryKey: ["/api/call-tracking/analytics/by-channel"] });
  const { data: byDay = [] } = useQuery<any[]>({ queryKey: ["/api/call-tracking/analytics/by-day"] });
  const max = Math.max(1, ...byDay.map((d) => d.count));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle>Calls by Tracking Number</CardTitle></CardHeader>
        <CardContent>
          {byNumber.length === 0 ? <p className="text-sm text-muted-foreground">No calls logged yet.</p> : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-muted-foreground border-b"><th className="py-2">Number</th><th>Campaign</th><th>Channel</th><th>Calls</th><th>Unique</th><th>Voicemails</th><th>Avg Duration</th></tr></thead>
              <tbody>
                {byNumber.map((r, i) => (
                  <tr key={i} className="border-b">
                    <td className="py-2 font-mono">{fmtPhone(r.phoneNumber) || "Unattributed"}</td>
                    <td>{r.campaignName || "—"}</td>
                    <td>{r.sourceChannel || "—"}</td>
                    <td className="font-semibold">{r.totalCalls}</td>
                    <td>{r.uniqueCallers}</td>
                    <td>{r.voicemails}</td>
                    <td>{r.avgDuration}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle>By Source Channel</CardTitle></CardHeader>
          <CardContent>
            {byChannel.length === 0 ? <p className="text-sm text-muted-foreground">No data.</p> : (
              <div className="space-y-2">
                {byChannel.map((r, i) => {
                  const m = Math.max(1, ...byChannel.map((x) => x.totalCalls));
                  return (
                    <div key={i}>
                      <div className="flex justify-between text-sm"><span>{r.sourceChannel}</span><span className="font-mono">{r.totalCalls}</span></div>
                      <div className="h-2 bg-muted rounded"><div className="h-2 bg-primary rounded" style={{ width: `${(r.totalCalls / m) * 100}%` }} /></div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Calls by Day (last 30)</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-end gap-1 h-40">
              {byDay.length === 0 && <p className="text-sm text-muted-foreground">No data.</p>}
              {byDay.map((d) => (
                <div key={d.day} className="flex-1 flex flex-col items-center justify-end" title={`${d.day}: ${d.count}`}>
                  <div className="w-full bg-primary rounded-t" style={{ height: `${(d.count / max) * 100}%` }} />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
