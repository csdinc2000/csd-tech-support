import type { DispatchRecipient, EligibleAssignee } from "@/hooks/use-staff-dispatch";

export type StaffAccountDirectoryEntry = {
  clerkUserId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  emailVerified: boolean;
  staffUserId: string | null;
  approvalStatus: "approved" | "pending" | "suspended" | null;
  invitationStatus: "pending" | "expired" | "accepted" | "revoked" | null;
};

export type DispatchAssigneeHandoff =
  | { kind: "edit"; recipient: DispatchRecipient }
  | { kind: "add"; assignee: EligibleAssignee }
  | { kind: "invalid"; reason: "not-found" | "not-approved" };

export function accountAlreadyInStaffAccess(account: StaffAccountDirectoryEntry): boolean {
  if (!account.staffUserId) return false;
  return account.approvalStatus === "approved"
    || account.approvalStatus === "suspended"
    || (account.approvalStatus === "pending" && account.invitationStatus === "accepted");
}

export function invitePrefillEmail(account: StaffAccountDirectoryEntry): string | null {
  if (accountAlreadyInStaffAccess(account)) return null;
  return account.email?.trim() || null;
}

export function resolveDispatchAssigneeHandoff(
  assigneeId: number,
  recipients: readonly DispatchRecipient[],
  assignees: readonly EligibleAssignee[],
): DispatchAssigneeHandoff {
  const configuredRecipient = recipients.find((recipient) => recipient.linkedUserId === assigneeId);
  if (configuredRecipient) return { kind: "edit", recipient: configuredRecipient };

  const assignee = assignees.find((candidate) => candidate.id === assigneeId);
  if (!assignee) return { kind: "invalid", reason: "not-found" };
  if (assignee.approvalStatus !== "approved") return { kind: "invalid", reason: "not-approved" };
  return { kind: "add", assignee };
}

export function dispatchDraftForAssignee(assignee: EligibleAssignee) {
  const staffRole = assignee.staffRole;
  return {
    name: assignee.name || assignee.email || "",
    role: staffRole === "field_technician" ? "technician" as const : "staff" as const,
    phone: "",
    enabled: false,
    onDuty: false,
    receiveCalls: false,
    receiveMessages: false,
    canUseCommands: false,
    linkedUserId: assignee.id,
  };
}