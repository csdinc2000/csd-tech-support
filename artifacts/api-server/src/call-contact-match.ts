import { toValidE164 } from "./phone-validation";

export type CallContactCandidate = {
  id: number;
  fullName?: string | null;
  company?: string | null;
  clientId?: number | null;
  clientName?: string | null;
  mobilePhone?: string | null;
  officePhone?: string | null;
};

/**
 * Resolve a call to a CRM contact only when the complete canonical number
 * belongs to one contact. A shared or malformed number stays unlinked.
 */
export function matchUniqueCallContact(
  phone: string | null | undefined,
  contacts: readonly CallContactCandidate[],
): CallContactCandidate | null {
  const canonicalPhone = phone ? toValidE164(phone) : null;
  if (!canonicalPhone) return null;

  const matches = new Map<number, CallContactCandidate>();
  for (const contact of contacts) {
    const matchesNumber = [contact.mobilePhone, contact.officePhone]
      .some((candidate) => candidate != null && toValidE164(candidate) === canonicalPhone);
    if (matchesNumber) matches.set(contact.id, contact);
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}
