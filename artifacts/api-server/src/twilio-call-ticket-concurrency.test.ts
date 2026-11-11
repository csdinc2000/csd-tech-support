import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { callLog, tickets } from "@workspace/db";
import { db, pool } from "./db";
import { applyCallSupportTicketMigration } from "./migrations/2026-09-07-call-support-ticket";
import { createAndAssociateCallTicket, callTicketIntakeSchema, nextCallIntakeTechnician, updateSmsMessageStatus } from "./twilio-tracking-storage";
import { PgDialect } from "drizzle-orm/pg-core";
import { enqueueStaffEventNotification, type StaffEventKind } from "./staff-dispatch";

const marker = `call-ticket-concurrency-${process.pid}-${Date.now()}`;
let callId: number | null = null;
const ticketIds: number[] = [];

after(async () => {
  if (callId) await db.delete(callLog).where(eq(callLog.id, callId));
  if (ticketIds.length) await db.delete(tickets).where(inArray(tickets.id, ticketIds));
  await pool.end();
});

test("concurrent attempts create and retain exactly one ticket for a call", async () => {
  await applyCallSupportTicketMigration();
  const [call] = await db.insert(callLog).values({
    callSid: marker,
    fromNumber: "+19545550100",
    toNumber: "+19545550101",
    status: "completed",
  }).returning();
  callId = call.id;

  const input = {
    subject: marker,
    description: "Concurrency regression test",
    priority: "medium",
    status: "open",
    source: "phone",
  };
  const results = await Promise.all([
    createAndAssociateCallTicket(call.id, input, undefined, { notifyStaffEvent: async () => undefined }),
    createAndAssociateCallTicket(call.id, input, undefined, { notifyStaffEvent: async () => undefined }),
  ]);
  ticketIds.push(...new Set(results.map((result) => result.ticket.id)));

  assert.equal(results[0].ticket.id, results[1].ticket.id);
  assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);

  const matchingTickets = await db.select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.subject, marker));
  assert.equal(matchingTickets.length, 1);

  const [linkedCall] = await db.select({ supportTicketId: callLog.supportTicketId })
    .from(callLog)
    .where(eq(callLog.id, call.id));
  assert.equal(linkedCall.supportTicketId, results[0].ticket.id);
});

const intake = {
  customerName: "Test Caller", contactPhone: "+12025550101", company: "Test Office",
  issueSummary: "Laptop will not start", serviceDeliveryType: "remote" as const, smsConsent: true,
};

test("intake requires real details, a delivery choice and an explicit consent answer", () => {
  assert.equal(callTicketIntakeSchema.safeParse(intake).success, true);
  for (const invalid of [
    { ...intake, customerName: " " },
    { ...intake, contactPhone: "anonymous" },
    { ...intake, contactPhone: "+1 CALL NOW" },
    { ...intake, issueSummary: "" },
    { ...intake, serviceDeliveryType: "" },
    { ...intake, smsConsent: undefined },
    { ...intake, smsConsent: "true" },
  ]) assert.equal(callTicketIntakeSchema.safeParse(invalid).success, false);
  assert.equal(callTicketIntakeSchema.safeParse({ ...intake, smsConsent: false }).success, true);
});

test("rotation wraps fairly and handles removed, offline and empty technicians", () => {
  const available = [{ user_id: 30 }, { user_id: 10 }, { user_id: 20 }];
  assert.equal(nextCallIntakeTechnician(available, 0)?.user_id, 10);
  assert.equal(nextCallIntakeTechnician(available, 10)?.user_id, 20);
  assert.equal(nextCallIntakeTechnician(available, 20)?.user_id, 30);
  assert.equal(nextCallIntakeTechnician(available, 30)?.user_id, 10);
  assert.equal(nextCallIntakeTechnician([{ user_id: 10 }, { user_id: 30 }], 20)?.user_id, 30);
  assert.equal(nextCallIntakeTechnician([], 20), undefined);
  assert.equal(available[0].user_id, 30, "selection must not mutate its inputs");
});

test("intake, consent, assignment and linkage share one transaction without notification side effects", async t => {
  // Exercise the storage callback with mocked persistence. No roster changes,
  // provider calls, consent changes or extra real tickets are made here.
  const dialect = new PgDialect();
  let eligible = true;
  let existing = false;
  let granted = true;
  const statements: string[] = [];
  const inserts: Array<{ table: unknown; value: any }> = [];
  const tx = {
    execute: async (statement: any) => {
      const query = dialect.sqlToQuery(statement).sql;
      statements.push(query);
      if (query.includes("AS user_id")) return { rows: eligible ? [{ user_id: 20, display_name: "Test Technician" }] : [] };
      if (query.includes("SELECT after_summary")) return { rows: [{ after_summary: { assignedTo: 10 } }] };
      if (query.includes("RETURNING consented")) return { rows: [{ consented: granted }] };
      return { rows: [] };
    },
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => table === callLog
            ? { for: async () => [{ id: 999, supportTicketId: existing ? 1000 : null }] }
            : Promise.resolve([{ id: 1000, assignedTo: 20 }]),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (value: any) => {
        inserts.push({ table, value });
        return table === tickets ? { returning: async () => [{ ...value, id: 1000 }] } : Promise.resolve();
      },
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  };
  t.mock.method(pool, "query", async () => ({ rows: [] }));
  t.mock.method(db, "transaction", async (callback: any) => callback(tx));

  const input = { subject: "Test call intake", priority: "medium", status: "open", assignedTo: 9999 };
  const result = await createAndAssociateCallTicket(999, input, intake);
  assert.equal(result.ticket.assignedTo, 20, "the server, not the request, selects the technician");
  assert.equal(result.assignedTechName, "Test Technician");
  assert.equal(result.effectiveSmsConsent, true);
  assert.match(result.ticket.description!, /Remote Support/);
  assert.match(result.ticket.description!, /Test Office/);
  const audit = inserts.find(entry => entry.value.action === "note")!.value;
  const details = JSON.parse(audit.details);
  assert.equal(details.smsConsentMethod, "staff_recorded_verbal");
  assert.equal(details.smsConsentGranted, true);
  assert.ok(!Number.isNaN(Date.parse(details.smsConsentTimestamp)));
  assert.match(details.disclosure, /STOP to unsubscribe/);
  assert.ok(statements[0].includes("pg_advisory_xact_lock"));
  assert.ok(statements.find(query => query.includes("AS user_id"))!.includes("FOR UPDATE OF r"));
  assert.ok(statements.find(query => query.includes("AS user_id"))!.includes("approval_status = 'approved'"));
  assert.ok(statements.find(query => query.includes("RETURNING consented"))!.includes("staff_dispatch_sms_consent.consented AND EXCLUDED.consented"));

  statements.length = 0;
  inserts.length = 0;
  existing = true;
  const repeat = await createAndAssociateCallTicket(999, input, intake);
  assert.equal(repeat.created, false);
  assert.equal(statements.length, 0, "retries do not advance rotation or alter consent");
  assert.equal(inserts.length, 0);

  existing = false;
  eligible = false;
  granted = false;
  const noTechnician = await createAndAssociateCallTicket(999, input, intake);
  assert.equal(noTechnician.ticket.assignedTo, null);
  assert.equal(noTechnician.assignedTechName, null);
  assert.equal(noTechnician.effectiveSmsConsent, false, "previous STOP remains effective despite a new verbal yes");
  assert.match(noTechnician.ticket.description!, /Unassigned/);
  assert.equal(inserts.filter(entry => entry.value.action === "assigned").length, 0);
});

test("all event types queue SMS for off-duty approved technicians with durable per-event deduplication", async () => {
  const dialect = new PgDialect();
  for (const kind of ["intake", "call", "missed-call", "ticket", "appointment"] as StaffEventKind[]) {
    const queries: Array<{ sql: string; params: any[] }> = [];
    const executor = { execute: async (statement: any) => {
      const query = dialect.sqlToQuery(statement);
      queries.push(query);
      return query.sql.includes("SELECT r.id")
        ? { rows: [{ id: 1, phone: "+12025550101" }, { id: 2, phone: "+12025550102" }, { id: 3, phone: "+12025550101" }] }
        : { rows: [] };
    } };
    await enqueueStaffEventNotification({ kind, id: 12345, businessNumber: "+19546377300" }, executor);
    const selection = queries[0];
    assert.match(selection.sql, /r.enabled=TRUE AND r.receive_messages=TRUE/);
    assert.match(selection.sql, /approval_status = 'approved'/);
    assert.match(selection.sql, /recipient_role='technician'/);
    assert.match(selection.sql, /staff_dispatch_sms_consent c WHERE c.phone=r.phone AND c.consented=FALSE/);
    assert.ok(selection.params.includes(false), "off-duty techs must not require the on-duty staff alternative");
    const insert = queries.find(query => query.sql.includes("INSERT INTO sms_forward_deliveries"))!;
    assert.match(insert.sql, /ON CONFLICT\(inbound_message_sid,target_number\) DO NOTHING/);
    assert.equal(insert.params.filter(value => value === `staff:${kind}:12345`).length, 2);
    assert.equal(insert.params.filter(value => value === "+12025550101").length, 1);
    assert.equal(insert.params.filter(value => value === "+12025550102").length, 1);
    assert.ok(insert.params.includes("pending") || insert.sql.includes("'pending'"));
    assert.equal(queries.filter(query => query.sql.includes("INSERT INTO staff_dispatch_correlations")).length, kind === "ticket" ? 3 : 0);
  }
  let inserts = 0;
  await enqueueStaffEventNotification({ kind: "call", id: "no-recipients" }, {
    execute: async () => { inserts++; return { rows: [] }; },
  });
  assert.equal(inserts, 1, "empty eligible rosters never send messages to arbitrary fallback phones");
});

test("SMS callbacks cannot confuse staff-notice delivery IDs with customer-message delivery IDs", async t => {
  const dialect = new PgDialect();
  const predicates: Array<{ sql: string; params: any[] }> = [];
  const history: Array<{ sql: string; params: any[] }> = [];
  t.mock.method(db, "update", () => ({
    set: () => ({ where: async (condition: any) => { predicates.push(dialect.sqlToQuery(condition)); } }),
  }) as any);
  t.mock.method(db, "execute", async (statement: any) => { history.push(dialect.sqlToQuery(statement)); return { rows: [] }; });
  await updateSmsMessageStatus("SM-notice", "delivered", null, 987654, "sms-forward");
  assert.ok(predicates[1].params.includes(987654));
  assert.ok(!history[0].params.includes(987654), "notice IDs cannot resolve an unrelated customer-message row");
  predicates.length = 0;
  history.length = 0;
  await updateSmsMessageStatus("SM-client", "delivered", null, 987654, "staff-client");
  assert.ok(!predicates[1].params.includes(987654), "customer-message IDs cannot update unrelated staff notices");
  assert.ok(history[0].params.includes(987654));
  predicates.length = 0;
  history.length = 0;
  await updateSmsMessageStatus("SM-legacy", "delivered", null, 987654);
  assert.ok(!predicates[1].params.includes(987654));
  assert.ok(!history[0].params.includes(987654), "legacy callbacks match provider SID, never an ambiguous numeric ID");
});