import type { CrmJob, CrmContact, CsdIntakeRecord } from "@shared/schema";
import type { Appointment } from "@shared/booking";
import { formatUsPhone, formatUsdCentsOr } from "@/lib/format";

// `/api/crm/jobs` decorates each job with the account resolved through its contact.
export type BoardJob = CrmJob & { clientId?: number | null };

// `/api/booking/appointments` joins the service name onto each row.
export type BoardAppointment = Appointment & {
  serviceName: string | null;
  serviceDurationMinutes: number | null;
};

export type BoardIntake = CsdIntakeRecord;

// Shape of `/api/call-tracking/calls` (see pages/call-tracking.tsx).
export type BoardCall = {
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
  clientId: number | null;
  clientName: string | null;
  supportTicketId: number | null;
  supportTicketNumber: string | null;
};

// Whatever the technician clicked on any column; the detail window switches on `kind`.
export type BoardSelection =
  | { kind: "job"; item: BoardJob }
  | { kind: "appointment"; item: BoardAppointment }
  | { kind: "intake"; item: BoardIntake }
  | { kind: "call"; item: BoardCall };

export type ContactIndex = Map<number, CrmContact>;

export const JOB_STATUS_GROUPS: { value: string; label: string; tone: string; dot: string }[] = [
  { value: "in_progress", label: "In Progress", tone: "bg-amber-100 text-amber-800", dot: "bg-amber-500" },
  { value: "open", label: "Open", tone: "bg-blue-100 text-blue-800", dot: "bg-blue-500" },
  { value: "waiting_parts", label: "Waiting on Parts", tone: "bg-purple-100 text-purple-800", dot: "bg-purple-500" },
  { value: "ready_pickup", label: "Ready for Pickup", tone: "bg-emerald-100 text-emerald-800", dot: "bg-emerald-500" },
];

export const PRIORITY_TONE: Record<string, string> = {
  low: "bg-gray-100 text-gray-700",
  normal: "bg-blue-50 text-blue-700",
  high: "bg-orange-100 text-orange-800",
  urgent: "bg-red-100 text-red-800",
};

export const APPOINTMENT_TONE: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  confirmed: "bg-blue-100 text-blue-800",
  in_progress: "bg-amber-100 text-amber-800",
  completed: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-gray-100 text-gray-500",
  no_show: "bg-red-100 text-red-800",
};

export const INTAKE_TONE: Record<string, string> = {
  new: "bg-red-100 text-red-800",
  contacted: "bg-blue-100 text-blue-800",
  scheduled: "bg-amber-100 text-amber-800",
  completed: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-gray-100 text-gray-500",
};

export const CALL_TONE: Record<string, string> = {
  completed: "bg-emerald-100 text-emerald-800",
  "in-progress": "bg-amber-100 text-amber-800",
  ringing: "bg-blue-100 text-blue-800",
  "no-answer": "bg-red-100 text-red-800",
  busy: "bg-red-100 text-red-800",
  failed: "bg-red-100 text-red-800",
  canceled: "bg-gray-100 text-gray-500",
};

/** "computer_repair" -> "Computer Repair". */
export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .split(/[_-]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function formatPhone(value: string | null | undefined): string {
  return formatUsPhone(value, "—");
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds) return "—";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m ${rest}s` : `${rest}s`;
}

/** Appointment and CRM job amounts are both stored in cents. */
export function formatCents(cents: number | null | undefined): string {
  return formatUsdCentsOr(cents);
}

export function contactName(contacts: ContactIndex, contactId: number | null | undefined): string {
  if (contactId == null) return "Unlinked customer";
  return contacts.get(contactId)?.fullName ?? `Contact #${contactId}`;
}
