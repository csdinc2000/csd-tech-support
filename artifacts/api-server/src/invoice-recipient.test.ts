import assert from "node:assert/strict";
import test from "node:test";
import {
  billingAccountName,
  normalizeInvoiceEmail,
  normalizeInvoicePhone,
  normalizeInvoiceRecipient,
} from "./invoice-core.ts";

test("a bare contactId is still accepted so saved drafts keep working", () => {
  assert.deepEqual(normalizeInvoiceRecipient({ contactId: 12 }), { kind: "contact", contactId: 12 });
  assert.deepEqual(normalizeInvoiceRecipient({ contactId: "12" }), { kind: "contact", contactId: 12 });
  for (const invalid of [undefined, null, 0, -3, 1.5, "abc", {}]) {
    assert.throws(() => normalizeInvoiceRecipient({ contactId: invalid }), /contactId is required/);
  }
});

test("a client account can be billed without naming a contact first", () => {
  assert.deepEqual(normalizeInvoiceRecipient({ recipient: { kind: "client", clientId: 4 } }), {
    kind: "client",
    clientId: 4,
  });
  assert.throws(() => normalizeInvoiceRecipient({ recipient: { kind: "client", clientId: 0 } }), /clientId is required/);
});

test("a walk-in is billable by name alone, with contact details normalized", () => {
  assert.deepEqual(
    normalizeInvoiceRecipient({
      recipient: { kind: "new", name: "  Dana   Reyes ", email: " Dana@Example.COM ", phone: "(954) 555-0134", company: "" },
    }),
    { kind: "new", name: "Dana Reyes", email: "dana@example.com", phone: "(954) 555-0134", company: null },
  );
  assert.deepEqual(normalizeInvoiceRecipient({ recipient: { kind: "new", name: "Dana Reyes" } }), {
    kind: "new",
    name: "Dana Reyes",
    email: null,
    phone: null,
    company: null,
  });
});

test("unusable recipients are rejected rather than silently invoiced", () => {
  assert.throws(() => normalizeInvoiceRecipient({ recipient: { kind: "new", name: "D" } }), /recipient name/);
  assert.throws(() => normalizeInvoiceRecipient({ recipient: { kind: "new", name: "Dana Reyes", email: "nope" } }), /valid email/);
  assert.throws(() => normalizeInvoiceRecipient({ recipient: { kind: "new", name: "Dana Reyes", phone: "12" } }), /phone number/);
  assert.throws(() => normalizeInvoiceRecipient({ recipient: { kind: "new", name: "Dana Reyes", phone: "+44 20 CALL-NOW" } }), /phone number/);
  assert.throws(() => normalizeInvoiceRecipient({ recipient: { kind: "new", name: "Dana Reyes", phone: "+44++2071234567" } }), /phone number/);
  assert.throws(() => normalizeInvoiceRecipient({ recipient: { kind: "lead", leadId: 3 } }), /recipient kind/);
  assert.throws(() => normalizeInvoiceRecipient({ recipient: "contact 4" }), /recipient is invalid/);
});

test("blank contact details are absent rather than invalid", () => {
  assert.equal(normalizeInvoiceEmail(""), null);
  assert.equal(normalizeInvoiceEmail("   "), null);
  assert.equal(normalizeInvoicePhone(undefined), null);
  assert.equal(normalizeInvoicePhone("954-555-0134"), "954-555-0134");
  assert.equal(normalizeInvoicePhone("+44 20 7123 4567"), "+44 20 7123 4567");
});

test("the account is named after the business when there is one", () => {
  assert.equal(billingAccountName("Dana Reyes", "Reyes Dental"), "Reyes Dental");
  assert.equal(billingAccountName("Dana Reyes", "   "), "Dana Reyes");
  assert.equal(billingAccountName("Dana Reyes", null), "Dana Reyes");
});
