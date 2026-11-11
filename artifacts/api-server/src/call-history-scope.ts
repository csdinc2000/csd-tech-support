import type { StaffAssignmentScope } from "./staff-access";

type CallHistoryRow = {
  contactId: number | null;
  clientId: number | null;
  clientName: string | null;
  supportTicketId: number | null;
  supportTicketNumber: string | null;
};

/**
 * Non-admin call history is visible only for explicitly assigned contacts.
 * Customer and ticket details additionally require the customer assignment.
 */
export function filterCallHistoryForScope<T extends CallHistoryRow>(
  calls: readonly T[],
  scope: StaffAssignmentScope,
): T[] {
  if (scope.unrestricted) return [...calls];

  return calls
    .filter((call) => call.contactId != null && scope.contactIds.has(Number(call.contactId)))
    .map((call) => {
      if (call.clientId != null && scope.clientIds.has(Number(call.clientId))) return call;
      return {
        ...call,
        clientId: null,
        clientName: null,
        supportTicketId: null,
        supportTicketNumber: null,
      };
    });
}
