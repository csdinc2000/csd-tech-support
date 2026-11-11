import assert from "node:assert/strict";
import test from "node:test";
import { isPublicApiRequest } from "./api-auth-boundary";
import { isAllStaffApiPath, requiredFeatureForApiPath } from "./security";

test("catalog portal read, checkout, and inquiry routes are public API paths", () => {
  assert.equal(isPublicApiRequest("GET", "/api/portal/catalog/items"), true);
  assert.equal(isPublicApiRequest("GET", "/api/portal/catalog/items/prod_123"), true);
  assert.equal(isPublicApiRequest("POST", "/api/portal/catalog/items/prod_123/checkout"), true);
  assert.equal(isPublicApiRequest("POST", "/api/portal/catalog/items/prod_123/inquire"), true);
});

test("staff catalog routes remain behind staff authentication", () => {
  assert.equal(isPublicApiRequest("GET", "/api/catalog/items"), false);
  assert.equal(isPublicApiRequest("POST", "/api/catalog/items"), false);
  assert.equal(isPublicApiRequest("GET", "/api/catalog/orders"), false);
  assert.equal(isPublicApiRequest("GET", "/api/catalog/inquiries"), false);
  assert.equal(isPublicApiRequest("POST", "/api/catalog/inquiries/uuid/resolve"), false);
  assert.equal(requiredFeatureForApiPath("/api/catalog/items", "GET"), "invoices");
  assert.equal(requiredFeatureForApiPath("/api/catalog/orders", "GET"), "invoices");
  assert.equal(requiredFeatureForApiPath("/api/catalog/items", "POST"), "owner");
  assert.equal(requiredFeatureForApiPath("/api/catalog/items/prod_1", "PATCH"), "owner");
  assert.equal(requiredFeatureForApiPath("/api/catalog/items/prod_1", "DELETE"), "owner");
  assert.equal(requiredFeatureForApiPath("/api/catalog/inquiries/uuid/resolve", "POST"), "owner");
});

test("service-request email history is protected by the same authenticated-staff boundary as intake email", () => {
  const protectedRequests = [
    ["GET", "/api/intake/7/email-history"],
    ["POST", "/api/intake/7/email"],
    ["GET", "/api/intake/7"],
  ] as const;
  for (const [method, path] of protectedRequests) {
    assert.equal(isPublicApiRequest(method, path), false, `${method} ${path} must not be public`);
    // Intake endpoints are available to any approved staff session (or owner),
    // with no extra feature gate; the global boundary still requires auth.
    assert.equal(requiredFeatureForApiPath(path, method), null);
  }
});
test("shared SMS inbox routes require staff authentication and the communications feature", () => {
  for (const [method, path] of [
    ["GET", "/api/sms/inbox"],
    ["GET", "/api/sms/inbox/assignees"],
    ["GET", "/api/sms/inbox/9545550101"],
    ["PATCH", "/api/sms/inbox/9545550101"],
    ["POST", "/api/sms/inbox/9545550101/notes"],
    ["POST", "/api/sms/inbox/9545550101/read"],
  ] as const) {
    assert.equal(isPublicApiRequest(method, path), false, `${method} ${path} must not be public`);
    assert.equal(requiredFeatureForApiPath(path, method), "communications");
  }
});

test("customer and CRM APIs require the admin-controlled CRM feature", () => {
  for (const path of [
    "/api/clients",
    "/api/clients/12",
    "/api/clients/12/overview",
    "/api/crm/jobs",
    "/api/crm/contacts",
    "/api/crm/leads",
  ]) {
    assert.equal(requiredFeatureForApiPath(path, "GET"), "crm", `${path} must require CRM access`);
  }
});

test("reading or deleting SMS history needs communications; texting one customer stays open to staff", () => {
  for (const [method, path] of [
    ["DELETE", "/api/sms/threads/9545550101"],
    ["DELETE", "/api/sms/messages/12"],
    ["GET", "/api/sms/bulk-recipients"],
    ["POST", "/api/sms/bulk-send"],
  ] as const) {
    assert.equal(requiredFeatureForApiPath(path, method), "communications", `${method} ${path}`);
  }
  assert.equal(requiredFeatureForApiPath("/api/sms/send", "POST"), null);
  assert.equal(isAllStaffApiPath("/api/sms/send", "POST"), true);
});

test("the customer's invoice page can record a view without signing in", () => {
  assert.equal(isPublicApiRequest("POST", "/api/public/invoices/abc123/view"), true);
  assert.equal(isPublicApiRequest("POST", "/api/public/invoices/abc123/void"), false);
});

test("unclassified API paths are not open to staff (fail closed)", () => {
  const path = "/api/some-new-feature/records";
  assert.equal(isPublicApiRequest("GET", path), false);
  assert.equal(requiredFeatureForApiPath(path, "GET"), null);
  assert.equal(isAllStaffApiPath(path, "GET"), false);
  // Method-limited entries don't leak to other verbs.
  assert.equal(isAllStaffApiPath("/api/helpdesk/departments", "GET"), true);
  assert.equal(isAllStaffApiPath("/api/helpdesk/departments", "POST"), false);
});

test("single-feature tool APIs follow the gate on their page", () => {
  assert.equal(requiredFeatureForApiPath("/api/automation-scripts/4/execute", "POST"), "automation");
  assert.equal(requiredFeatureForApiPath("/api/patches/install", "POST"), "operations");
  assert.equal(requiredFeatureForApiPath("/api/network", "GET"), "operations");
  assert.equal(requiredFeatureForApiPath("/api/network-scans", "GET"), "operations");
  assert.equal(requiredFeatureForApiPath("/api/contact-import/import", "POST"), "crm");
  assert.equal(requiredFeatureForApiPath("/api/paypal-import/import", "POST"), "invoices");
  assert.equal(requiredFeatureForApiPath("/api/helpdesk/email/inbound", "POST"), "helpdeskAdmin");
});

test("HEAD follows the GET classification for all-staff paths", () => {
  assert.equal(isAllStaffApiPath("/api/helpdesk/departments", "HEAD"), true);
});
