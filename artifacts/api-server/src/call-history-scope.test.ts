import assert from "node:assert/strict";
import test from "node:test";
import { filterCallHistoryForScope } from "./call-history-scope";

const scope = {
  unrestricted: false,
  staffAdministrator: false,
  clientIds: new Set([20]),
  jobIds: new Set<number>(),
  contactIds: new Set([7, 8]),
  editableContactIds: new Set<number>(),
};

const call = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  contactId: 7,
  clientId: 20,
  clientName: "Assigned Customer",
  supportTicketId: 90,
  supportTicketNumber: "T-90",
  ...overrides,
});

test("shows assigned contact calls and account details only for assigned customers", () => {
  const rows = filterCallHistoryForScope([
    call(),
    call({ id: 2, contactId: 8, clientId: 30, clientName: "Other Customer" }),
    call({ id: 3, contactId: 99 }),
  ], scope);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].clientName, "Assigned Customer");
  assert.equal(rows[0].supportTicketId, 90);
  assert.equal(rows[1].clientId, null);
  assert.equal(rows[1].clientName, null);
  assert.equal(rows[1].supportTicketId, null);
});

test("leaves administrator call history unchanged", () => {
  const rows = [call({ contactId: 99 })];
  assert.deepEqual(filterCallHistoryForScope(rows, { ...scope, unrestricted: true }), rows);
});
