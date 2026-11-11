import assert from "node:assert/strict";
import test from "node:test";
import type { DispatchRecipient, EligibleAssignee } from "@/hooks/use-staff-dispatch";
import {
  accountAlreadyInStaffAccess,
  dispatchDraftForAssignee,
  invitePrefillEmail,
  resolveDispatchAssigneeHandoff,
  type StaffAccountDirectoryEntry,
} from "./staff-dispatch-handoff.ts";

const account: StaffAccountDirectoryEntry = {
  clerkUserId: "clerk-user-1",
  email: "person@example.invalid",
  firstName: null,
  lastName: null,
  emailVerified: true,
  staffUserId: null,
  approvalStatus: null,
  invitationStatus: null,
};

const recipient: DispatchRecipient = {
  id: 25,
  name: "Configured staff",
  role: "staff",
  phone: "+19555550123",
  enabled: true,
  onDuty: true,
  receiveCalls: true,
  receiveMessages: true,
  canUseCommands: false,
  linkedUserId: 123,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const approvedAssignee: EligibleAssignee = {
  id: 123,
  name: "Taylor Technician",
  email: "taylor@example.invalid",
  staffRole: "field_technician",
  approvalStatus: "approved",
};

test("directory selection prefills an existing email without inventing a name", () => {
  assert.equal(invitePrefillEmail(account), "person@example.invalid");
  assert.equal(invitePrefillEmail({ ...account, email: "  " }), null);
});

test("already-managed staff cannot be invited again but non-accepted pending profiles remain invit-able", () => {
  const approved = { ...account, staffUserId: "staff-1", approvalStatus: "approved" as const };
  const suspended = { ...account, staffUserId: "staff-2", approvalStatus: "suspended" as const };
  const acceptedPending = {
    ...account,
    staffUserId: "staff-3",
    approvalStatus: "pending" as const,
    invitationStatus: "accepted" as const,
  };
  const manualPending = {
    ...account,
    staffUserId: "staff-4",
    approvalStatus: "pending" as const,
    invitationStatus: null,
  };

  for (const staffAccount of [approved, suspended, acceptedPending]) {
    assert.equal(accountAlreadyInStaffAccess(staffAccount), true);
    assert.equal(invitePrefillEmail(staffAccount), null);
  }
  assert.equal(accountAlreadyInStaffAccess(manualPending), false);
  assert.equal(invitePrefillEmail(manualPending), "person@example.invalid");
});

test("dispatch handoff edits a configured recipient before considering assignee eligibility", () => {
  assert.deepEqual(
    resolveDispatchAssigneeHandoff(123, [recipient], [{ ...approvedAssignee, approvalStatus: "suspended" }]),
    { kind: "edit", recipient },
  );
});

test("approved new assignee handoff derives identity and starts with routing off", () => {
  const handoff = resolveDispatchAssigneeHandoff(123, [], [approvedAssignee]);
  assert.deepEqual(handoff, { kind: "add", assignee: approvedAssignee });
  assert.deepEqual(dispatchDraftForAssignee(approvedAssignee), {
    name: "Taylor Technician",
    role: "technician",
    phone: "",
    enabled: false,
    onDuty: false,
    receiveCalls: false,
    receiveMessages: false,
    canUseCommands: false,
    linkedUserId: 123,
  });
});

test("invalid and unapproved assignee handoffs cannot create a dispatch draft", () => {
  assert.deepEqual(resolveDispatchAssigneeHandoff(124, [], [approvedAssignee]), {
    kind: "invalid",
    reason: "not-found",
  });
  assert.deepEqual(resolveDispatchAssigneeHandoff(123, [], [{ ...approvedAssignee, approvalStatus: "suspended" }]), {
    kind: "invalid",
    reason: "not-approved",
  });
});