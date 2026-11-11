import type { StaffAssignmentScope } from "./staff-access";
import { toE164, toValidE164 } from "./phone-validation";

export type OutboundCallContact = {
  id: number;
  fullName?: string | null;
  company?: string | null;
  mobilePhone?: string | null;
  officePhone?: string | null;
};

export type OutboundCallAuthorization =
  | { ok: true; customerNumber: string; contactId: number | null; contact: OutboundCallContact | null }
  | { ok: false; status: number; error: string };

export async function authorizeOutboundCallTarget(input: {
  to: unknown;
  contactId?: unknown;
  isApproved: boolean;
  scope: StaffAssignmentScope;
  getContacts(): Promise<OutboundCallContact[]>;
  canSeeContact(scope: StaffAssignmentScope, contactId: number | null | undefined): boolean;
  canEditContact(scope: StaffAssignmentScope, contactId: number | null | undefined): boolean;
}): Promise<OutboundCallAuthorization> {
  const customerNumber = toValidE164(String(input.to ?? ""));
  if (!customerNumber) {
    return { ok: false, status: 400, error: "Destination phone number must be a valid E.164 number" };
  }
  if (!input.isApproved) {
    return { ok: false, status: 403, error: "Approved staff access required" };
  }

  const contacts = await input.getContacts();
  const matching = contacts.filter((contact) =>
    [contact.mobilePhone, contact.officePhone]
      .filter((phone): phone is string => Boolean(phone?.trim()))
      .some((phone) => toE164(phone) === customerNumber),
  );
  if (matching.length > 1) {
    return { ok: false, status: 409, error: "This phone number matches multiple contacts. Ask an administrator to resolve the duplicate before calling." };
  }
  if (matching.some((contact) => !input.canSeeContact(input.scope, contact.id))) {
    return { ok: false, status: 404, error: "Contact not found" };
  }
  if (matching.some((contact) => !input.canEditContact(input.scope, contact.id))) {
    return { ok: false, status: 403, error: "Contact edit assignment required" };
  }

  const rawContactId = input.contactId;
  let requestedContactId: number | null = null;
  if (rawContactId != null && rawContactId !== "") {
    requestedContactId = Number(rawContactId);
    if (!Number.isSafeInteger(requestedContactId) || requestedContactId < 1) {
      return { ok: false, status: 400, error: "contactId must be a positive integer" };
    }
    if (matching[0]?.id !== requestedContactId) {
      return { ok: false, status: 400, error: "contactId does not match the destination number" };
    }
  }

  const contact = matching[0] ?? null;
  return {
    ok: true,
    customerNumber,
    contactId: requestedContactId ?? contact?.id ?? null,
    contact,
  };
}
