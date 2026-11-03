import { createContext, useContext, useState } from "react";
import { format } from "date-fns";
import { Link } from "wouter";
import {
  Briefcase,
  CalendarDays,
  ExternalLink,
  Inbox,
  Mail,
  MapPin,
  Phone,
  PhoneCall,
  Voicemail,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ServiceRequestEmailHistory } from "./service-request-email-history";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Pill } from "./column";
import { ServiceRequestEmailDialog } from "./service-request-email-dialog";
import { CallViaCsdButtonView } from "@/components/communications/call-via-csd-button";
import type { StaffFeature } from "@/hooks/use-admin-access";
import {
  APPOINTMENT_TONE,
  CALL_TONE,
  INTAKE_TONE,
  JOB_STATUS_GROUPS,
  PRIORITY_TONE,
  contactName,
  formatCents,
  formatDollars,
  formatDuration,
  formatPhone,
  humanize,
  type BoardAppointment,
  type BoardCall,
  type BoardIntake,
  type BoardJob,
  type BoardSelection,
  type ContactIndex,
} from "./types";

function when(value: string | Date | null | undefined, pattern = "EEE, MMM d, yyyy 'at' h:mm a"): string {
  if (!value) return "—";
  return format(new Date(value), pattern);
}

/**
 * The detail window every board item opens into. All four record types share
 * the same frame (eyebrow + reference, customer name, status, labelled facts,
 * long-form issue text, footer actions) so technicians learn one layout.
 */
export function BoardDetailDialog({
  selection,
  contacts,
  onClose,
  can = () => true,
}: {
  selection: BoardSelection | null;
  contacts: ContactIndex;
  onClose: () => void;
  /** Resolved by the page so the dialog stays provider-free. */
  can?: (feature: StaffFeature) => boolean;
}) {
  const [emailIntake, setEmailIntake] = useState<BoardIntake | null>(null);
  return (
    <BoardAccessContext.Provider value={can}>
      <Dialog open={selection !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
        <DialogContent className="flex max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0" data-testid="board-detail">
          {selection?.kind === "job" && <JobDetail job={selection.item} contacts={contacts} />}
          {selection?.kind === "appointment" && <AppointmentDetail appointment={selection.item} contacts={contacts} />}
          {selection?.kind === "intake" && (
            <IntakeDetail intake={selection.item} onEmail={() => { setEmailIntake(selection.item); onClose(); }} />
          )}
          {selection?.kind === "call" && <CallDetail call={selection.item} />}
        </DialogContent>
      </Dialog>
      {emailIntake && <ServiceRequestEmailDialog key={emailIntake.id} intake={emailIntake} onClose={() => setEmailIntake(null)} />}
    </BoardAccessContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Shared frame pieces
// ---------------------------------------------------------------------------

function DetailFrame({
  icon: Icon,
  eyebrow,
  reference,
  title,
  status,
  children,
  actions,
}: {
  icon: React.ComponentType<{ className?: string }>;
  eyebrow: string;
  reference?: string | null;
  title: string;
  status: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <>
      <DialogHeader className="space-y-0 border-b border-gray-200 bg-gray-50 px-6 py-5 text-left">
        <div className="flex items-start gap-3 pr-8">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-csd-red/10 text-csd-red ring-1 ring-csd-red/15">
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogDescription className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-csd-red">
              {eyebrow}
              {reference && <span className="font-mono normal-case tracking-normal text-gray-500">{reference}</span>}
            </DialogDescription>
            <DialogTitle className="mt-0.5 truncate text-xl font-bold text-gray-900" data-testid="board-detail-title">{title}</DialogTitle>
          </div>
          <div className="shrink-0 pt-1">{status}</div>
        </div>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
      {actions && (
        <DialogFooter className="flex-row flex-wrap items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-6 py-3">
          {actions}
        </DialogFooter>
      )}
    </>
  );
}

function Facts({ children, className }: { children: React.ReactNode; className?: string }) {
  return <dl className={cn("grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2", className)}>{children}</dl>;
}

function Fact({ label, value, wide, mono }: { label: string; value: React.ReactNode; wide?: boolean; mono?: boolean }) {
  return (
    <div className={cn("min-w-0", wide && "sm:col-span-2")}>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{label}</dt>
      <dd className={cn("mt-0.5 break-words text-sm text-gray-900", mono && "font-mono")}>{value ?? "—"}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5 border-t border-gray-100 pt-4 first:mt-0 first:border-t-0 first:pt-0">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">{title}</h3>
      {children}
    </section>
  );
}

function LongText({ children, emphasis }: { children: string | null | undefined; emphasis?: boolean }) {
  if (!children?.trim()) return <p className="text-sm italic text-gray-400">None recorded.</p>;
  return (
    <p
      className={cn(
        "whitespace-pre-wrap rounded-md border px-3 py-2 text-sm leading-relaxed",
        emphasis ? "border-red-100 bg-red-50/60 text-gray-900" : "border-gray-100 bg-gray-50 text-gray-800",
      )}
    >
      {children}
    </p>
  );
}

const BoardAccessContext = createContext<(feature: StaffFeature) => boolean>(() => true);

function ContactLinks({ phone, email, contactId }: { phone?: string | null; email?: string | null; contactId?: number | null }) {
  const can = useContext(BoardAccessContext);
  return (
    <>
      {phone && can("communications") && (
        <CallViaCsdButtonView phone={phone} contactId={contactId ?? undefined} label="Call from app" />
      )}
      {email && can("communications") && (
        <Button asChild variant="outline" size="sm">
          <Link href={contactId != null ? `/comms/email?contactId=${encodeURIComponent(contactId)}` : "/comms/email"}><Mail className="mr-1.5 h-3.5 w-3.5" />Email from Support</Link>
        </Button>
      )}
    </>
  );
}

function OpenRecord({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild size="sm" className="bg-csd-red hover:bg-red-700">
      <Link href={href}><ExternalLink className="mr-1.5 h-3.5 w-3.5" />{label}</Link>
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Per-record bodies
// ---------------------------------------------------------------------------

function JobDetail({ job, contacts }: { job: BoardJob; contacts: ContactIndex }) {
  const contact = job.contactId != null ? contacts.get(job.contactId) : undefined;
  const group = JOB_STATUS_GROUPS.find((g) => g.value === job.status);
  const address = contact ? [contact.address, contact.city, contact.state, contact.zipCode].filter(Boolean).join(", ") : "";
  return (
    <DetailFrame
      icon={Briefcase}
      eyebrow="Work order"
      reference={job.jobNumber}
      title={contactName(contacts, job.contactId)}
      status={<Pill tone={group?.tone ?? "bg-gray-100 text-gray-700"} className="text-xs">{group?.label ?? humanize(job.status)}</Pill>}
      actions={
        <>
          <ContactLinks phone={contact?.mobilePhone || contact?.officePhone} email={contact?.email} contactId={contact?.id} />
          {job.clientId != null && <OpenRecord href={`/crm/customers/${job.clientId}`} label="Customer record" />}
          <OpenRecord href="/crm/jobs" label="Open in Jobs" />
        </>
      }
    >
      <Facts>
        <Fact label="Service type" value={humanize(job.serviceType)} />
        <Fact label="Job type" value={humanize(job.jobType)} />
        <Fact label="Priority" value={<Pill tone={PRIORITY_TONE[job.priority ?? "normal"] ?? PRIORITY_TONE.normal}>{humanize(job.priority ?? "normal")}</Pill>} />
        <Fact label="Assigned technician" value={job.assignedTo || "Unassigned"} />
        <Fact label="Scheduled" value={when(job.scheduledDateTime)} />
        <Fact label="Created" value={when(job.createdAt)} />
        <Fact label="Estimate" value={formatDollars(job.estimatedAmount)} />
        <Fact label="Final amount" value={formatDollars(job.finalAmount)} />
      </Facts>
      <Section title="Customer">
        <Facts>
          <Fact label="Name" value={contactName(contacts, job.contactId)} />
          <Fact label="Company" value={contact?.company || "—"} />
          <Fact label="Phone" value={formatPhone(contact?.mobilePhone || contact?.officePhone)} />
          <Fact label="Email" value={contact?.email || "—"} />
          {address && <Fact label="Address" value={<span className="inline-flex items-start gap-1"><MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />{address}</span>} wide />}
        </Facts>
      </Section>
      <Section title="Reported issue">
        <LongText emphasis>{job.description}</LongText>
      </Section>
      <Section title="Technician notes">
        <LongText>{job.technicianNotes}</LongText>
      </Section>
      {job.notes && (
        <Section title="Internal notes">
          <LongText>{job.notes}</LongText>
        </Section>
      )}
    </DetailFrame>
  );
}

function AppointmentDetail({ appointment, contacts }: { appointment: BoardAppointment; contacts: ContactIndex }) {
  const contact = appointment.contactId != null ? contacts.get(appointment.contactId) : undefined;
  const balance = appointment.totalCents - appointment.amountPaidCents;
  return (
    <DetailFrame
      icon={CalendarDays}
      eyebrow="Appointment"
      reference={appointment.reference}
      title={appointment.customerName}
      status={<Pill tone={APPOINTMENT_TONE[appointment.status] ?? APPOINTMENT_TONE.pending} className="text-xs">{humanize(appointment.status)}</Pill>}
      actions={
        <>
          <ContactLinks phone={appointment.customerPhone} email={appointment.customerEmail} contactId={appointment.contactId} />
          {contact?.clientId != null && <OpenRecord href={`/crm/customers/${contact.clientId}`} label="Customer record" />}
        </>
      }
    >
      <Facts>
        <Fact label="Service" value={appointment.serviceName ?? "—"} />
        <Fact label="Duration" value={appointment.serviceDurationMinutes ? `${appointment.serviceDurationMinutes} min` : "—"} />
        <Fact label="Starts" value={when(appointment.startsAt)} />
        <Fact label="Ends" value={when(appointment.endsAt, "h:mm a")} />
        <Fact label="Booked via" value={humanize(appointment.source)} />
        <Fact label="Customer time zone" value={appointment.customerTimezone} />
      </Facts>
      <Section title="Customer">
        <Facts>
          <Fact label="Name" value={appointment.customerName} />
          <Fact label="CRM contact" value={contact ? contact.fullName : "Guest booking"} />
          <Fact label="Phone" value={formatPhone(appointment.customerPhone)} />
          <Fact label="Email" value={appointment.customerEmail} />
        </Facts>
      </Section>
      <Section title="Customer notes">
        <LongText emphasis>{appointment.customerNotes}</LongText>
      </Section>
      <Section title="Billing">
        <Facts>
          <Fact label="Total" value={formatCents(appointment.totalCents)} />
          <Fact label="Deposit required" value={formatCents(appointment.depositRequiredCents)} />
          <Fact label="Paid" value={formatCents(appointment.amountPaidCents)} />
          <Fact label="Balance due" value={<span className={cn(balance > 0 && "font-semibold text-csd-red")}>{formatCents(balance)}</span>} />
        </Facts>
      </Section>
      {appointment.internalNotes && (
        <Section title="Internal notes">
          <LongText>{appointment.internalNotes}</LongText>
        </Section>
      )}
      {appointment.cancellationReason && (
        <Section title="Cancellation reason">
          <LongText>{appointment.cancellationReason}</LongText>
        </Section>
      )}
    </DetailFrame>
  );
}

function IntakeDetail({ intake, onEmail }: { intake: BoardIntake; onEmail: () => void }) {
  const serviceType = intake.serviceType === "Other" && intake.serviceTypeOther ? intake.serviceTypeOther : humanize(intake.serviceType);
  return (
    <DetailFrame
      icon={Inbox}
      eyebrow="Service request"
      reference={`#${intake.id}`}
      title={intake.customerName}
      status={<Pill tone={INTAKE_TONE[intake.status] ?? INTAKE_TONE.new} className="text-xs">{humanize(intake.status)}</Pill>}
      actions={
        <>
          <ContactLinks phone={intake.phoneNumber} />
          {intake.emailAddress && (
            <Button type="button" variant="outline" size="sm" onClick={onEmail} data-testid="button-service-request-email">
              <Mail className="mr-1.5 h-3.5 w-3.5" />Email
            </Button>
          )}
          <OpenRecord href="/admin/intakes" label="Open in Intakes" />
        </>
      }
    >
      <Facts>
        <Fact label="Service type" value={serviceType} />
        <Fact label="Device" value={`${humanize(intake.deviceType)} · ${intake.deviceBrandModel}`} />
        <Fact label="Operating system" value={intake.operatingSystem} />
        <Fact label="Preferred contact" value={humanize(intake.contactPreference)} />
        <Fact label="Received" value={when(intake.createdAt)} />
        <Fact label="Follow up" value={when(intake.followUpDate)} />
      </Facts>
      <Section title="Reported issue">
        <LongText emphasis>{intake.problemDescription}</LongText>
      </Section>
      <Section title="Email submissions">
        <ServiceRequestEmailHistory intakeId={intake.id} />
      </Section>
      <Section title="Customer">
        <Facts>
          <Fact label="Name" value={intake.customerName} />
          <Fact label="Phone" value={formatPhone(intake.phoneNumber)} />
          <Fact label="Email" value={intake.emailAddress} />
          <Fact label="Heard about us" value={intake.howDidYouHear} />
        </Facts>
      </Section>
      {(intake.isFromActiveCall || intake.callNotes) && (
        <Section title="Call notes">
          <LongText>{intake.callNotes}</LongText>
        </Section>
      )}
      {intake.internalNotes && (
        <Section title="Internal notes">
          <LongText>{intake.internalNotes}</LongText>
        </Section>
      )}
      <Section title="Source">
        <Facts>
          <Fact label="Channel" value={intake.source} />
          <Fact label="Campaign" value={intake.campaign || "—"} />
          {intake.campaign === "voice_intake" && (
            <Fact label="Completed via" value="Voice intake assistant" />
          )}
        </Facts>
      </Section>
    </DetailFrame>
  );
}

function CallDetail({ call }: { call: BoardCall }) {
  const missed = ["no-answer", "busy", "failed", "canceled"].includes(call.status);
  return (
    <DetailFrame
      icon={PhoneCall}
      eyebrow={`${call.direction === "outbound" ? "Outbound" : "Inbound"} call`}
      reference={call.callSid}
      title={call.contactName ?? formatPhone(call.fromNumber)}
      status={<Pill tone={CALL_TONE[call.status] ?? CALL_TONE.completed} className="text-xs">{humanize(call.status)}</Pill>}
      actions={
        <>
          <ContactLinks
            phone={call.direction === "outbound" ? call.toNumber : call.fromNumber}
            contactId={call.contactId}
          />
          {call.clientId != null && <OpenRecord href={`/crm/customers/${call.clientId}`} label="Customer record" />}
          {call.supportTicketId != null && <OpenRecord href={`/tickets?ticket=${call.supportTicketId}`} label={call.supportTicketNumber ?? "Ticket"} />}
          <OpenRecord href="/admin/call-tracking" label="Open call activity" />
        </>
      }
    >
      <Facts>
        <Fact label="Caller" value={call.contactName ?? "Unknown caller"} />
        <Fact label="Customer account" value={call.clientName || "Not linked to a customer account"} />
        <Fact label="From" value={formatPhone(call.fromNumber)} mono />
        <Fact label="To" value={call.trackingNumber ? `${formatPhone(call.toNumber)} (tracking)` : formatPhone(call.toNumber)} mono />
        <Fact label="Time" value={when(call.createdAt)} />
        <Fact label="Duration" value={missed ? "Not connected" : formatDuration(call.durationSeconds)} />
        <Fact label="Source channel" value={humanize(call.sourceChannel)} />
        <Fact label="Campaign" value={call.campaignName ?? "—"} />
        <Fact
          label="Voicemail"
          value={call.hadVoicemail
            ? <span className="inline-flex items-center gap-1 text-gray-900"><Voicemail className="h-3.5 w-3.5" />Left a voicemail</span>
            : "None"}
        />
        <Fact label="Support ticket" value={call.supportTicketNumber ?? "Not linked"} />
      </Facts>
      {missed && (
        <Section title="Follow-up">
          <LongText emphasis>{`This ${call.direction === "outbound" ? "outbound" : "inbound"} call was not connected (${humanize(call.status).toLowerCase()}). Return the call or link it to a contact from Call Activity.`}</LongText>
        </Section>
      )}
    </DetailFrame>
  );
}
