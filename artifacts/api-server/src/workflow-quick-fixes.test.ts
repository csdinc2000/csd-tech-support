import assert from "node:assert/strict";
import test from "node:test";
import { requiredFeatureForApiPath } from "./security";
import { canSeeTicket, isAdministratorScope, roleFeatureMap, type StaffAssignmentScope } from "./staff-access";
import { buildCustomerConfirmationEmail } from "./csd-notifications";

const scope = (overrides: Partial<StaffAssignmentScope> = {}): StaffAssignmentScope => ({
  unrestricted: false,
  staffAdministrator: false,
  clientIds: new Set(),
  jobIds: new Set(),
  contactIds: new Set(),
  editableContactIds: new Set(),
  ...overrides,
});

test("phone forwarding and carrier setup are owner-only; reading settings and voicemails stays with communications", () => {
  assert.equal(requiredFeatureForApiPath("/api/twilio/settings", "PATCH"), "owner");
  assert.equal(requiredFeatureForApiPath("/api/twilio/settings", "GET"), "communications");
  assert.equal(requiredFeatureForApiPath("/api/twilio/a2p/register", "POST"), "owner");
  assert.equal(requiredFeatureForApiPath("/api/twilio/sync-webhooks", "POST"), "owner");
  assert.equal(requiredFeatureForApiPath("/api/twilio/voicemail-greeting/audio", "DELETE"), "owner");
  assert.equal(requiredFeatureForApiPath("/api/twilio/call-log/12", "DELETE"), "owner");
  assert.equal(requiredFeatureForApiPath("/api/twilio/call-log", "GET"), "communications");
  assert.equal(requiredFeatureForApiPath("/api/twilio/calls/outbound", "POST"), "communications");
});

test("technicians get the crm feature by default so their board loads", () => {
  assert.equal(roleFeatureMap("field_technician").crm, true);
  assert.equal(roleFeatureMap("field_technician").invoices, false);
});

test("a ticket is visible to its assignee even when the customer account isn't assigned", () => {
  const tech = scope({ helpdeskUserIds: new Set([7]) });
  assert.equal(canSeeTicket(tech, { clientId: null, assignedTo: 7 }), true);
  assert.equal(canSeeTicket(tech, { clientId: 99, assignedTo: 7 }), true);
  assert.equal(canSeeTicket(tech, { clientId: 99, assignedTo: 8 }), false);
  assert.equal(canSeeTicket(tech, { clientId: null, assignedTo: null }), false);
  assert.equal(canSeeTicket(scope({ clientIds: new Set([99]) }), { clientId: 99, assignedTo: null }), true);
});

test("front desk sees every customer but is not an administrator", () => {
  const frontDesk = scope({ unrestricted: true, frontDesk: true });
  assert.equal(canSeeTicket(frontDesk, { clientId: null, assignedTo: null }), true);
  assert.equal(isAdministratorScope(frontDesk), false);
  assert.equal(isAdministratorScope(scope({ unrestricted: true, staffAdministrator: true })), true);
  assert.equal(isAdministratorScope(scope()), false);
});

const intake = {
  id: 41,
  customerName: "Dana Lee",
  emailAddress: "dana@example.invalid",
  contactPreference: "text_email",
  serviceType: "Computer Repair",
  deviceType: "Laptop",
  deviceBrandModel: "Dell XPS 13",
} as any;

test("the confirmation email quotes the real ticket number, links to the ticket and has no placeholder text", () => {
  const email = buildCustomerConfirmationEmail(intake, {
    ticketNumber: "CSD-2026-0042",
    portalUrl: "https://example.invalid/portal/ticket?ticket=CSD-2026-0042&email=dana%40example.invalid&token=abc",
    businessPhone: "(954) 555-0100",
  });
  assert.equal(email.subject, "Service request received - CSD-2026-0042");
  // Same pattern the inbound email parser uses to thread replies into the ticket.
  assert.match(email.subject, /[A-Z]{2,5}-\d{4}-\d{4,}/);
  assert.match(email.text, /Your ticket number: CSD-2026-0042/);
  assert.match(email.text, /\/portal\/ticket\?ticket=CSD-2026-0042/);
  assert.match(email.text, /call us at \(954\) 555-0100/);
  assert.doesNotMatch(email.text, /your business phone number|CSD-41\b/);
});

test("without a ticket or phone the email still reads cleanly", () => {
  const email = buildCustomerConfirmationEmail(intake);
  assert.equal(email.subject, "Service Request Confirmation - Computer Systems Depot");
  assert.doesNotMatch(email.text, /ticket number|call us at|undefined|null/i);
});

test("customer-supplied text is escaped in the HTML version", () => {
  const email = buildCustomerConfirmationEmail({ ...intake, customerName: "<b>Dana</b>" });
  assert.match(email.html, /&lt;b&gt;Dana&lt;\/b&gt;/);
});
