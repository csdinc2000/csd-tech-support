import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIntakeAttribution,
  normalizeUtmCampaign,
  buildIntakeDeal,
  centsToAmount,
  intakePayloadFingerprint,
  mapIntakeClient,
  mapIntakeRecord,
  planIntakeDispatch,
  mergeIntakeTag,
  normalizeIntakeEmail,
  normalizeIntakePhone,
  publicIntakeResponse,
  resolveIntakeAccount,
  resolveIntakeIdentity,
} from "./intake-core.ts";

test("intake identifiers are normalized before CRM matching", () => {
  assert.equal(normalizeIntakeEmail(" Customer@Example.COM "), "customer@example.com");
  assert.equal(normalizeIntakePhone(" (954) 555-0123 "), "+19545550123");
  assert.equal(normalizeIntakePhone("+44 20 7123 4567"), "+442071234567");
  assert.equal(normalizeIntakePhone(""), null);
  assert.equal(normalizeIntakePhone("+44 20 CALL-NOW"), null);
  assert.equal(normalizeIntakePhone("+44++2071234567"), null);
});

test("intake tag merging requires exact comma-delimited equality", () => {
  assert.equal(mergeIntakeTag("Referral, Google Search", "Google"), "Referral, Google Search, Google");
  assert.equal(mergeIntakeTag("Google Search", "Google Search"), "Google Search");
});

test("intake deals start at lead with zero estimates", () => {
  assert.deepEqual(
    buildIntakeDeal({
      serviceType: "Website build",
      companyName: "Acme",
      contactName: "Jane Doe",
      deviceType: "Web app",
      problemDescription: "  A new client portal is needed. ",
      primaryContactId: 3,
      leadId: 4,
    }),
    {
      title: "Website build — Acme",
      companyName: "Acme",
      stage: "lead",
      estimatedMrr: "0",
      oneTimeFee: "0",
      primaryContactId: 3,
      leadId: 4,
      notes: "Intake: Web app. A new client portal is needed.",
    },
  );
});

test("two supplied identifiers must resolve to the same unique contact", () => {
  assert.deepEqual(
    resolveIntakeIdentity({ phoneProvided: true, emailProvided: true, phoneContactIds: [7], emailContactIds: [7] }),
    { kind: "reuse", contactId: 7 },
  );
  assert.deepEqual(
    resolveIntakeIdentity({ phoneProvided: true, emailProvided: true, phoneContactIds: [7], emailContactIds: [] }),
    { kind: "create", needsIdentityReview: true },
  );
  assert.deepEqual(
    resolveIntakeIdentity({ phoneProvided: true, emailProvided: true, phoneContactIds: [7], emailContactIds: [8] }),
    { kind: "create", needsIdentityReview: true },
  );
});

test("accounts are resolved by unique email and phone only corroborates it", () => {
  assert.deepEqual(
    resolveIntakeAccount({ emailProvided: true, phoneProvided: true, emailClientIds: [3], phoneClientIds: [3] }),
    { kind: "reuse", clientId: 3 },
  );
  assert.deepEqual(
    resolveIntakeAccount({ emailProvided: true, phoneProvided: true, emailClientIds: [3], phoneClientIds: [4] }),
    { kind: "unlinked", needsIdentityReview: true },
  );
  assert.deepEqual(
    resolveIntakeAccount({ emailProvided: true, phoneProvided: false, emailClientIds: [], phoneClientIds: [] }),
    { kind: "create" },
  );
  assert.deepEqual(
    resolveIntakeAccount({ emailProvided: false, phoneProvided: true, emailClientIds: [], phoneClientIds: [3] }),
    { kind: "unlinked", needsIdentityReview: true },
  );
});

test("client mapping uses submitted identity and never manufactures an email", () => {
  assert.deepEqual(
    mapIntakeClient({
      fullName: " Jane Doe ", companyName: " Acme ", email: "jane@example.com", phone: "+19545550123",
      address: " 1 Main St ", city: " Miami ", state: " FL ", zip: "33101 ",
    }),
    {
      name: "Acme", contactEmail: "jane@example.com", contactPhone: "+19545550123",
      address: "1 Main St", city: "Miami", state: "FL", zipCode: "33101",
    },
  );
  assert.equal(mapIntakeClient({
    fullName: "Jane Doe", companyName: null, email: null, phone: "+19545550123",
    address: null, city: null, state: null, zip: null,
  }), null);
});

test("one intake identity maps once and replay resumes only missing dispatch", () => {
  const identity = {
    fullName: "Jane Doe", companyName: "Acme", email: normalizeIntakeEmail(" JANE@ACME.COM "),
    phone: normalizeIntakePhone("954-555-0123"),
  };
  assert.deepEqual(mapIntakeClient({ ...identity, address: null, city: null, state: null, zip: null }), {
    name: "Acme", contactEmail: "jane@acme.com", contactPhone: "+19545550123",
    address: null, city: null, state: null, zipCode: null,
  });
  assert.deepEqual(mapIntakeRecord({
    ...identity, contactPreference: "email", serviceType: "Repair", deviceType: "Laptop",
    brandModel: "Dell XPS", operatingSystem: "Windows", problemDescription: "Will not boot",
    source: "Referral", activeCall: false, callNotes: null,
  }), {
    customerName: "Jane Doe", phoneNumber: "+19545550123", emailAddress: "jane@acme.com",
    contactPreference: "email", serviceType: "Repair", deviceType: "Laptop", deviceBrandModel: "Dell XPS",
    operatingSystem: "Windows", problemDescription: "Will not boot", howDidYouHear: "Referral",
    isFromActiveCall: false, callNotes: null,
  });
  // The persisted submission's contact/client/lead/deal/intake IDs remain its
  // identity; only absent dispatch IDs are planned on replay.
  assert.deepEqual(planIntakeDispatch({ jobId: 11, ticketId: null }), {
    createJob: false, createTicket: true, complete: false,
  });
  assert.deepEqual(planIntakeDispatch({ jobId: 11, ticketId: 12 }), {
    createJob: false, createTicket: false, complete: true,
  });
});

test("payload fingerprints are stable and public response contains no PII", () => {
  assert.equal(
    intakePayloadFingerprint({ email: "a@example.com", service: "repair" }),
    intakePayloadFingerprint({ service: "repair", email: "a@example.com" }),
  );
  assert.notEqual(
    intakePayloadFingerprint({ email: "a@example.com", service: "repair" }),
    intakePayloadFingerprint({ email: "a@example.com", service: "website" }),
  );
  assert.deepEqual(
    publicIntakeResponse({ contactId: 1, contactStatus: "reused", clientId: 4, clientStatus: "reused", intakeRecordId: 5, leadId: 2, dealId: 3, replayed: true }),
    { success: true, contact: { id: 1, status: "reused" }, client: { id: 4, status: "reused" }, intake: { id: 5 }, lead: { id: 2 }, deal: { id: 3 }, replayed: true },
  );
});

test("intake deals carry the booked service price as their one-time fee", () => {
  const deal = buildIntakeDeal({
    serviceType: "Virus Removal",
    companyName: null,
    contactName: "Jane Doe",
    deviceType: "Laptop",
    problemDescription: "Popups everywhere.",
    primaryContactId: 3,
    leadId: 4,
    servicePriceCents: 14900,
  });
  assert.equal(deal.oneTimeFee, "149.00");
  assert.equal(deal.estimatedMrr, "0");
  assert.equal(deal.title, "Virus Removal — Jane Doe");

  // A missing, zero or nonsensical price must never invent deal value.
  assert.equal(centsToAmount(null), "0");
  assert.equal(centsToAmount(undefined), "0");
  assert.equal(centsToAmount(0), "0");
  assert.equal(centsToAmount(-500), "0");
  assert.equal(centsToAmount(Number.NaN), "0");
});

test("intake attribution separates the arrival channel from the marketing answer", () => {
  assert.deepEqual(
    buildIntakeAttribution({ fromActiveCall: false, howDidYouHear: " Google Search " }),
    { source: "website_intake", campaign: "Google Search" },
  );
  assert.deepEqual(
    buildIntakeAttribution({ fromActiveCall: true, howDidYouHear: "Referral from Friend/Family" }),
    { source: "phone_call", campaign: "Referral from Friend/Family" },
  );
  // An unanswered marketing question must not pollute the channel field.
  assert.deepEqual(
    buildIntakeAttribution({ fromActiveCall: false, howDidYouHear: "   " }),
    { source: "website_intake", campaign: null },
  );
});

test("utm campaigns are normalized and junk is dropped", () => {
  assert.equal(normalizeUtmCampaign(" Spring Tune Up "), "spring-tune-up");
  assert.equal(normalizeUtmCampaign("fall_promo.2026"), "fall_promo.2026");
  assert.equal(normalizeUtmCampaign("<script>"), "script");
  assert.equal(normalizeUtmCampaign("x".repeat(200))?.length, 80);
  assert.equal(normalizeUtmCampaign("!!!"), null);
  assert.equal(normalizeUtmCampaign(42), null);
  assert.equal(normalizeUtmCampaign(undefined), null);
});
