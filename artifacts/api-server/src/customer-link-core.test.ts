import assert from "node:assert/strict";
import test from "node:test";
import { deterministicClientMatch, normalizeOptionalClientId, normalizeOptionalRefId } from "./customer-link-core.ts";

test("customer links use exactly one normalized account email", () => {
  const accounts = [{ id: 7, contactEmail: " Billing@Example.com " }];
  assert.equal(deterministicClientMatch({ id: 1, email: "billing@example.com", clientId: null }, accounts), 7);
  assert.equal(deterministicClientMatch({ id: 1, email: "billing@example.com", clientId: null }, [...accounts, { id: 8, contactEmail: "BILLING@example.com" }]), null);
});

test("legacy empty client IDs normalize to no account link", () => {
  assert.deepEqual(normalizeOptionalClientId(undefined, false), { kind: "omitted" });
  assert.deepEqual(normalizeOptionalClientId(null, true), { kind: "unlink" });
  assert.deepEqual(normalizeOptionalClientId("", true), { kind: "unlink" });
  assert.deepEqual(normalizeOptionalClientId("0", true), { kind: "unlink" });
  assert.deepEqual(normalizeOptionalClientId(0, true), { kind: "unlink" });
});

test("client IDs accept only positive integers and preserve omitted patches", () => {
  assert.deepEqual(normalizeOptionalClientId(12, true), { kind: "id", clientId: 12 });
  assert.deepEqual(normalizeOptionalClientId("12", true), { kind: "id", clientId: 12 });
  assert.deepEqual(normalizeOptionalClientId(undefined, false), { kind: "omitted" });
  for (const invalid of [-1, 1.5, true, {}, [], "abc", "-1", "1.5"]) {
    assert.equal(normalizeOptionalClientId(invalid, true).kind, "invalid");
  }
});

test("an unselected optional reference unlinks instead of reaching the foreign key", () => {
  // The CRM lead form's contact <Select> reports "nothing selected" as 0, and
  // crm_leads.contact_id references crm_contacts(id) — so a 0 that survives to
  // the UPDATE fails the constraint and the edit dialog reports a bare failure.
  assert.deepEqual(normalizeOptionalRefId(0, true, "contactId"), { kind: "unlink" });
  assert.deepEqual(normalizeOptionalRefId(null, true, "contactId"), { kind: "unlink" });
  assert.deepEqual(normalizeOptionalRefId(undefined, false, "contactId"), { kind: "omitted" });
  assert.deepEqual(normalizeOptionalRefId(5, true, "contactId"), { kind: "id", id: 5 });
  assert.deepEqual(normalizeOptionalRefId("5", true, "contactId"), { kind: "id", id: 5 });
});

test("an invalid optional reference names its own field", () => {
  const result = normalizeOptionalRefId(-1, true, "contactId");
  assert.equal(result.kind, "invalid");
  assert.equal(result.kind === "invalid" && result.message, "contactId must be a positive integer");
  for (const invalid of [1.5, true, {}, [], "abc", "-1", "1.5"]) {
    assert.equal(normalizeOptionalRefId(invalid, true, "contactId").kind, "invalid");
  }
});
