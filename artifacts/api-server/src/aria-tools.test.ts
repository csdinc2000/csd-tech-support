import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "./db";
import { storage } from "./storage";
import { ariaScopeFingerprint, confirmAriaAction, executeAriaTool, ownsAriaConversation, type AriaToolSession } from "./aria-tools";

const adminScope = { unrestricted: true, staffAdministrator: true, clientIds: new Set<number>(), jobIds: new Set<number>(), contactIds: new Set<number>(), editableContactIds: new Set<number>() };
const staffScope = { ...adminScope, unrestricted: false, staffAdministrator: false, contactIds: new Set([1]) };
const actor: AriaToolSession = { userId: "test-user", conversationId: 1, scope: adminScope, canReadCrm: true, canCommunicate: true };

test("Aria ownership rejects another actor, legacy staff, and revoked assignments", () => {
  const conversation = { metadata: JSON.stringify({ ownerUserId: "test-user", access: "administrator" }) };
  assert.equal(ownsAriaConversation(conversation, "other-user", adminScope), false);
  assert.equal(ownsAriaConversation(conversation, "test-user", staffScope), false);
  assert.equal(ownsAriaConversation({ metadata: null }, "test-user", staffScope), false);
  assert.equal(ownsAriaConversation({ metadata: null }, "test-user", adminScope), true);
  const assigned = { metadata: JSON.stringify({ ownerUserId: "test-user", access: "assigned", assignmentScope: ariaScopeFingerprint(staffScope) }) };
  assert.equal(ownsAriaConversation(assigned, "test-user", staffScope), true);
  assert.equal(ownsAriaConversation(assigned, "test-user", { ...staffScope, contactIds: new Set() }), false);
});

test("Staff cannot use shared mailbox or outbound action tools", async () => {
  for (const name of ["list_mail_folders", "search_mail", "read_mail", "prepare_action"]) {
    await assert.rejects(executeAriaTool(name, {}, { ...actor, scope: staffScope }), /Administrator/);
  }
});

test("Scoped contact search cannot disclose unassigned identities", async () => {
  const original = storage.getCrmContacts;
  storage.getCrmContacts = async () => [
    { id: 1, fullName: "Assigned Person", email: "assigned@example.invalid" },
    { id: 2, fullName: "Private Person", email: "private@example.invalid" },
  ] as any;
  try {
    const result: any = await executeAriaTool("search_contacts", { query: "" }, { ...actor, scope: staffScope });
    assert.equal(result.totalMatches, 1);
    assert.equal(result.contacts[0].id, 1);
    await assert.rejects(executeAriaTool("contact_history", { contactId: 2 }, { ...actor, scope: staffScope }), /not found/);
  } finally { storage.getCrmContacts = original; }
});

test("Confirmation claims before I/O; repeated clicks and uncertainty never resend", async () => {
  const originalQuery = pool.query;
  const originalContact = storage.getCrmContact;
  const originalInteraction = storage.createCrmInteraction;
  let row: any = { id: "test-action", user_id: actor.userId, conversation_id: 1, contact_id: 1,
    kind: "email", recipient: "recipient@example.invalid", subject: "Review", body: "Approved message",
    status: "pending", result: null, expires_at: new Date(Date.now() + 60_000) };
  let sends = 0;
  storage.getCrmContact = async () => ({ id: 1, email: row.recipient }) as any;
  storage.createCrmInteraction = async () => ({}) as any;
  pool.query = (async (sql: string, values: any[]) => {
    if (sql.startsWith("SELECT")) {
      if (values.length > 1 && (values[1] !== row.user_id || values[2] !== row.conversation_id)) return { rows: [] };
      return { rows: [{ ...row }] };
    }
    if (sql.includes("SET status='sending'")) {
      if (row.status !== "pending" || row.expires_at < new Date()) return { rows: [] };
      row.status = "sending";
      return { rows: [{ ...row }] };
    }
    if (sql.includes("SET status=$2")) { row.status = values[1]; row.result = values[2]; return { rows: [] }; }
    throw new Error("Unexpected SQL in isolated test");
  }) as any;
  const submit = async () => {
    assert.equal(row.status, "sending");
    sends++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return "Accepted, not delivered";
  };
  try {
    await Promise.all([confirmAriaAction(row.id, actor, submit), confirmAriaAction(row.id, actor, submit)]);
    assert.equal(sends, 1);
    assert.equal(row.status, "submitted");
    await confirmAriaAction(row.id, actor, submit);
    assert.equal(sends, 1);
    row = { ...row, status: "pending" };
    await confirmAriaAction(row.id, actor, async () => { sends++; throw new Error("Timeout after provider accepted"); });
    assert.equal(row.status, "uncertain");
    await confirmAriaAction(row.id, actor, submit);
    assert.equal(sends, 2);
    await assert.rejects(confirmAriaAction(row.id, { ...actor, userId: "other-user" }, submit), /not found/);
    await assert.rejects(confirmAriaAction(row.id, { ...actor, scope: staffScope }, submit), /Administrator/);
    row = { ...row, status: "pending", expires_at: new Date(0) };
    await assert.rejects(confirmAriaAction(row.id, actor, submit), /expired/);
    assert.equal(sends, 2);
    row = { ...row, expires_at: new Date(Date.now() + 60_000), recipient: "different@example.invalid" };
    storage.getCrmContact = async () => ({ id: 1, email: "original@example.invalid" }) as any;
    await assert.rejects(confirmAriaAction(row.id, actor, submit), /does not match/);
    assert.equal(sends, 2);
  } finally {
    pool.query = originalQuery;
    storage.getCrmContact = originalContact;
    storage.createCrmInteraction = originalInteraction;
  }
});