export type LinkCandidate = { id: number; contactEmail: string | null };
export type UnlinkedContact = { id: number; email: string | null; clientId: number | null };

export function normalizeCustomerEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized || null;
}

/** Returns a match only when exactly one account has the normalized email. */
export function deterministicClientMatch(contact: UnlinkedContact, clients: LinkCandidate[]): number | null {
  if (contact.clientId != null) return contact.clientId;
  const email = normalizeCustomerEmail(contact.email);
  if (!email) return null;
  const matches = clients.filter((client) => normalizeCustomerEmail(client.contactEmail) === email);
  return matches.length === 1 ? matches[0].id : null;
}

export type OptionalRefNormalization =
  | { kind: "omitted" }
  | { kind: "unlink" }
  | { kind: "id"; id: number }
  | { kind: "invalid"; message: string };

export type ClientIdNormalization =
  | { kind: "omitted" }
  | { kind: "unlink" }
  | { kind: "id"; clientId: number }
  | { kind: "invalid"; message: string };

/**
 * Normalizes an optional foreign key sent from a form. Distinguishes a field
 * absent from a PATCH from an explicit unlink, and treats the 0 that a
 * "nothing selected" <Select> produces as an unlink rather than letting it
 * reach the database as a row id that cannot exist. Invalid values are never
 * silently converted into an unlink.
 */
export function normalizeOptionalRefId(value: unknown, supplied: boolean, field: string): OptionalRefNormalization {
  const invalid = { kind: "invalid", message: `${field} must be a positive integer` } as const;
  if (!supplied || value === undefined) return { kind: "omitted" };
  if (value === null || value === "") return { kind: "unlink" };
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return invalid;
    return value === 0 ? { kind: "unlink" } : value > 0 ? { kind: "id", id: value } : invalid;
  }
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) return invalid;
    const id = Number(value);
    if (!Number.isSafeInteger(id)) return invalid;
    return id === 0 ? { kind: "unlink" } : { kind: "id", id };
  }
  return invalid;
}

export function normalizeOptionalClientId(value: unknown, supplied: boolean): ClientIdNormalization {
  const normalized = normalizeOptionalRefId(value, supplied, "clientId");
  return normalized.kind === "id" ? { kind: "id", clientId: normalized.id } : normalized;
}
