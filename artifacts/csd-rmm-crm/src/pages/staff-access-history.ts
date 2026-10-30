import type { ApprovalStatus, StaffFeature, StaffRole } from "@/hooks/use-admin-access";

type EditableRole = Exclude<StaffRole, "owner">;

export type AccessSnapshot = {
  role?: EditableRole;
  approval_status?: ApprovalStatus;
  can_view_voicemails?: boolean;
  feature_permissions?: Partial<Record<StaffFeature, boolean>>;
  clientIds?: number[];
  jobIds?: number[];
};

export type AccessAuditEntry = {
  id: string;
  action: string;
  previousAccess: AccessSnapshot;
  newAccess: AccessSnapshot;
  createdAt: string;
  targetEmail: string | null;
  actorEmail: string | null;
};

export function isRecoveryAuditAction(action: string) {
  return action === "conflict_recovery_succeeded" || action === "conflict_recovery_failed";
}

const ROLE_LABELS: Record<EditableRole, string> = {
  administrator: "Administrator",
  field_technician: "Field Technicians",
  software_developer: "Software Developer",
  accounting: "Accounting",
  it_manager: "IT Manager",
  legal_team: "Legal Team",
  secretary: "Secretary",
};

const STATUS_LABELS: Record<ApprovalStatus, string> = {
  approved: "Approved",
  pending: "Pending approval",
  suspended: "Suspended",
};

const FEATURE_LABELS: Partial<Record<StaffFeature, string>> = {
  dashboard: "Dashboard",
  crm: "Customers & CRM",
  communications: "Communications",
  scheduling: "Scheduling",
  operations: "Devices & operations",
  helpdesk: "Help desk",
  invoices: "Invoices",
  reports: "Reports",
  automation: "Automation",
  compliance: "Compliance",
  helpdeskAdmin: "Helpdesk configuration",
  dispatchAdmin: "Dispatch configuration",
  marketplace: "Community marketplace",
};

function listDifference(previous: number[] = [], next: number[] = []) {
  return {
    added: next.filter((id) => !previous.includes(id)),
    removed: previous.filter((id) => !next.includes(id)),
  };
}

export function describeAuditChange(entry: AccessAuditEntry): string[] {
  if (entry.action === "conflict_recovery_succeeded") {
    return ["Conflict recovery succeeded: current settings were reloaded; no access change was made."];
  }
  if (entry.action === "conflict_recovery_failed") {
    return ["Conflict recovery failed: current settings could not be reloaded; no access change was made."];
  }

  const changes: string[] = [];
  const previous = entry.previousAccess ?? {};
  const next = entry.newAccess ?? {};

  if (previous.role !== next.role && next.role) {
    changes.push(`Role: ${previous.role ? ROLE_LABELS[previous.role] : "Not set"} → ${ROLE_LABELS[next.role]}`);
  }
  if (previous.approval_status !== next.approval_status && next.approval_status) {
    changes.push(`Status: ${previous.approval_status ? STATUS_LABELS[previous.approval_status] : "Not set"} → ${STATUS_LABELS[next.approval_status]}`);
  }
  if (previous.can_view_voicemails !== next.can_view_voicemails && typeof next.can_view_voicemails === "boolean") {
    changes.push(`View voicemails: ${previous.can_view_voicemails ? "On" : "Off"} → ${next.can_view_voicemails ? "On" : "Off"}`);
  }

  const featureKeys = new Set([
    ...Object.keys(previous.feature_permissions ?? {}),
    ...Object.keys(next.feature_permissions ?? {}),
  ] as StaffFeature[]);
  for (const key of featureKeys) {
    const before = previous.feature_permissions?.[key] ?? false;
    const after = next.feature_permissions?.[key] ?? false;
    if (before !== after) {
      changes.push(`${FEATURE_LABELS[key] ?? key}: ${before ? "On" : "Off"} → ${after ? "On" : "Off"}`);
    }
  }

  if (entry.action === "assignments_updated") {
    const clients = listDifference(previous.clientIds, next.clientIds);
    const jobs = listDifference(previous.jobIds, next.jobIds);
    if (clients.added.length) changes.push(`Customers added: ${clients.added.join(", ")}`);
    if (clients.removed.length) changes.push(`Customers removed: ${clients.removed.join(", ")}`);
    if (jobs.added.length) changes.push(`Jobs added: ${jobs.added.join(", ")}`);
    if (jobs.removed.length) changes.push(`Jobs removed: ${jobs.removed.join(", ")}`);
  }

  return changes.length ? changes : ["Access settings were saved with no effective change."];
}

export type AuditHistoryViewState = "loading" | "error" | "empty" | "populated";

export function getAuditHistoryViewState(input: {
  isLoading: boolean;
  isError: boolean;
  data?: AccessAuditEntry[];
}): AuditHistoryViewState {
  if (input.isLoading) return "loading";
  if (input.isError) return "error";
  return input.data?.length ? "populated" : "empty";
}