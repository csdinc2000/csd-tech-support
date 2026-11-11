import { createHash } from "node:crypto";
import { toValidE164 } from "./phone-validation";

/**
 * Side-effect-free intake mapping helpers. Keeping these transformations here
 * makes the public intake route easier to reason about and test.
 */
export function normalizeIntakeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

export function normalizeIntakePhone(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return toValidE164(trimmed);
}

export function normalizedPhoneDigits(value: string | null | undefined): string | null {
  return normalizeIntakePhone(value)?.slice(1) ?? null;
}

export type IntakeIdentityDecision =
  | { kind: "reuse"; contactId: number }
  | { kind: "create"; needsIdentityReview: boolean };

/**
 * Public intake identity matching is deliberately conservative: two submitted
 * identifiers may only attach to a contact when each resolves exactly once to
 * that same record.
 */
export function resolveIntakeIdentity(input: {
  phoneProvided: boolean;
  emailProvided: boolean;
  phoneContactIds: number[];
  emailContactIds: number[];
}): IntakeIdentityDecision {
  const unique = (ids: number[]) => [...new Set(ids)];
  const phones = unique(input.phoneContactIds);
  const emails = unique(input.emailContactIds);
  if (input.phoneProvided && input.emailProvided) {
    if (phones.length === 1 && emails.length === 1 && phones[0] === emails[0]) {
      return { kind: "reuse", contactId: phones[0] };
    }
    return { kind: "create", needsIdentityReview: phones.length > 0 || emails.length > 0 };
  }
  const matches = input.phoneProvided ? phones : emails;
  return matches.length === 1
    ? { kind: "reuse", contactId: matches[0] }
    : { kind: "create", needsIdentityReview: matches.length > 1 };
}

export type IntakeAccountDecision =
  | { kind: "reuse"; clientId: number }
  | { kind: "create" }
  | { kind: "unlinked"; needsIdentityReview: true };

/**
 * Accounts are email-led. A phone number can confirm the email result, but a
 * phone-only match must never attach anonymous intake data to an account.
 */
export function resolveIntakeAccount(input: {
  emailProvided: boolean;
  phoneProvided: boolean;
  emailClientIds: number[];
  phoneClientIds: number[];
}): IntakeAccountDecision {
  const unique = (ids: number[]) => [...new Set(ids)];
  const emails = unique(input.emailClientIds);
  const phones = unique(input.phoneClientIds);
  if (!input.emailProvided) return { kind: "unlinked", needsIdentityReview: true };
  if (emails.length > 1) return { kind: "unlinked", needsIdentityReview: true };
  if (emails.length === 1) {
    if (input.phoneProvided && phones.length > 0 && (phones.length !== 1 || phones[0] !== emails[0])) {
      return { kind: "unlinked", needsIdentityReview: true };
    }
    return { kind: "reuse", clientId: emails[0] };
  }
  // A phone result without an email result is an ambiguous identity signal.
  if (input.phoneProvided && phones.length > 0) return { kind: "unlinked", needsIdentityReview: true };
  return { kind: "create" };
}

/** Maps already-normalized intake identity to the required client columns. */
export function mapIntakeClient(input: {
  fullName: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null | undefined;
  city: string | null | undefined;
  state: string | null | undefined;
  zip: string | null | undefined;
}) {
  if (!input.email) return null;
  const optional = (value: string | null | undefined) => value?.trim() || null;
  return {
    name: input.companyName?.trim() || input.fullName.trim(),
    contactEmail: input.email,
    contactPhone: input.phone,
    address: optional(input.address),
    city: optional(input.city),
    state: optional(input.state),
    zipCode: optional(input.zip),
  };
}

/** Pure dispatch resume plan: completed handoffs are never recreated. */
export function planIntakeDispatch(input: { jobId: number | null; ticketId: number | null }) {
  return {
    createJob: input.jobId === null,
    createTicket: input.ticketId === null,
    complete: input.jobId !== null && input.ticketId !== null,
  };
}

/** Shared, lossless projection for the Intake Requests record. */
export function mapIntakeRecord(input: {
  fullName: string; phone: string | null; email: string | null; contactPreference: string | null | undefined;
  serviceType: string; deviceType: string; brandModel: string | null; operatingSystem: string | null;
  problemDescription: string; source: string | null | undefined; activeCall: boolean; callNotes: string | null | undefined;
}) {
  return {
    customerName: input.fullName.trim(), phoneNumber: input.phone || "", emailAddress: input.email || "",
    contactPreference: input.contactPreference || "text_email", serviceType: input.serviceType,
    deviceType: input.deviceType, deviceBrandModel: input.brandModel || "", operatingSystem: input.operatingSystem || "",
    problemDescription: input.problemDescription, howDidYouHear: input.source || "website_intake",
    isFromActiveCall: input.activeCall, callNotes: input.callNotes || null,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function intakePayloadFingerprint(payload: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

export function publicIntakeResponse(input: {
  contactId: number;
  contactStatus: "created" | "reused" | "identity_review";
  clientId: number | null;
  clientStatus: "created" | "reused" | "identity_review" | "unlinked";
  intakeRecordId?: number | null;
  leadId: number;
  dealId: number;
  replayed: boolean;
}) {
  return {
    success: true,
    contact: { id: input.contactId, status: input.contactStatus },
    client: { id: input.clientId, status: input.clientStatus },
    intake: { id: input.intakeRecordId ?? null },
    lead: { id: input.leadId },
    deal: { id: input.dealId },
    replayed: input.replayed,
  };
}

/**
 * Splits intake attribution into the two distinct things the CRM tracks:
 * `source` is the channel the request arrived through (a closed set the Leads
 * filters can rely on), and `campaign` is the customer's free-text answer to
 * "how did you hear about us". Mixing them made every Leads source filter miss.
 */
export const INTAKE_LEAD_SOURCES = ["website_intake", "phone_call"] as const;
export type IntakeLeadSource = (typeof INTAKE_LEAD_SOURCES)[number];

export function buildIntakeAttribution(input: {
  fromActiveCall: boolean;
  howDidYouHear: string | null | undefined;
}): { source: IntakeLeadSource; campaign: string | null } {
  return {
    source: input.fromActiveCall ? "phone_call" : "website_intake",
    campaign: input.howDidYouHear?.trim() || null,
  };
}

/**
 * The `utm_campaign` a public visitor arrived with, cleaned for storage in
 * `csd_intake_records.campaign`. Anything unusable becomes null — a bad
 * tracking parameter must never block a service request.
 */
export function normalizeUtmCampaign(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 80);
  return clean || null;
}

/** Adds a comma-delimited tag only when that exact tag is not already present. */
export function mergeIntakeTag(existing: string | null | undefined, incoming: string | null | undefined): string | null {
  const tag = incoming?.trim();
  if (!tag) return existing?.trim() || null;

  const tags = (existing ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return tags.includes(tag) ? tags.join(", ") : [...tags, tag].join(", ");
}

export function buildIntakeDeal(input: {
  serviceType: string;
  companyName: string | null;
  contactName: string;
  deviceType: string;
  problemDescription: string;
  primaryContactId: number;
  leadId: number;
  /** Catalog price of the booked service, in cents. Becomes the deal's one-time fee. */
  servicePriceCents?: number | null;
}) {
  const companyName = input.companyName?.trim() || input.contactName.trim();
  const title = `${input.serviceType.trim()} — ${companyName}`;
  const summary = input.problemDescription.trim().replace(/\s+/g, " ");
  return {
    title,
    companyName,
    stage: "lead" as const,
    estimatedMrr: "0",
    oneTimeFee: centsToAmount(input.servicePriceCents),
    primaryContactId: input.primaryContactId,
    leadId: input.leadId,
    notes: `Intake: ${input.deviceType.trim()}. ${summary.slice(0, 400)}`,
  };
}

/**
 * Renders a cents amount as the fixed-scale decimal string the numeric deal
 * columns expect. Anything non-finite or negative is treated as no value.
 */
export function centsToAmount(cents: number | null | undefined): string {
  return Number.isFinite(cents) && (cents as number) > 0 ? ((cents as number) / 100).toFixed(2) : "0";
}