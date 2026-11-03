import assert from "node:assert/strict";
import test from "node:test";
import { isPublicApiRequest } from "./api-auth-boundary";
import { requiredFeatureForApiPath } from "./security";

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
