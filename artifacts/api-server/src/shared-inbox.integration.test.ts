import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { pool } from "./db";
import { applySharedInboxMigration } from "./migrations/2026-10-30-shared-inbox";
import {
  ensureConversation,
  mirrorReplyToTeam,
  registerSharedInboxRoutes,
  relayStaffReply,
  sendTeamReply,
  threadKeyFor,
} from "./shared-inbox";

const marker = `inbox-${process.pid}-${Date.now()}`;
const staffId = `${marker}-ana`;
const otherId = `${marker}-luis`;
const suffix = String(Math.floor(Math.random() * 90) + 10);
const customer = `+12025550${suffix}1`.slice(0, 12);
const staffPhone = `+12025550${suffix}9`.slice(0, 12);
const mainLine = "+19546377300";
const key = threadKeyFor(customer);

let server: Server | undefined;
let baseUrl = "";
const sent: Array<{ to: string; body: string; sid: string }> = [];
const mirrored: Array<Parameters<typeof mirrorReplyToTeam>[0]> = [];

// Stands in for twilio.ts sendSms(): persists the outbound row the same way.
async function fakeSendSms(to: string, body: string) {
  const sid = `SM${randomBytes(16).toString("hex")}`;
  await pool.query(
    `INSERT INTO sms_messages (message_sid, from_number, to_number, body, direction, status)
     VALUES ($1, $2, $3, $4, 'outbound', 'queued')`,
    [sid, mainLine, to, body],
  );
  sent.push({ to, body, sid });
  return { sid, from: mainLine, to, status: "queued" };
}
const recordMirror = async (input: Parameters<typeof mirrorReplyToTeam>[0]) => { mirrored.push(input); };

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}

before(async () => {
  await applySharedInboxMigration();
  await pool.query(
    `INSERT INTO auth_users (id, email, first_name, last_name) VALUES
       ($1, $2, 'Ana', 'Diaz'), ($3, $4, 'Luis', 'Reyes')`,
    [staffId, `${staffId}@example.invalid`, otherId, `${otherId}@example.invalid`],
  );
  await pool.query(
    `INSERT INTO staff_access_profiles (user_id, approval_status) VALUES ($1, 'approved'), ($2, 'pending')`,
    [staffId, otherId],
  );
  await pool.query(
    `INSERT INTO sms_messages (message_sid, from_number, to_number, body, direction, status)
     VALUES ($1, $2, $3, 'Is my laptop ready?', 'inbound', 'received')`,
    [`SM${randomBytes(16).toString("hex")}`, customer, mainLine],
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.dbUser = { id: staffId, email: `${staffId}@example.invalid`, firstName: "Ana", lastName: "Diaz" } as any;
    next();
  });
  registerSharedInboxRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server!.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await pool.query(`DELETE FROM sms_forward_deliveries WHERE target_number = $1`, [staffPhone]);
  await pool.query(`DELETE FROM sms_messages WHERE from_number = $1 OR to_number = $1`, [customer]);
  await pool.query(`DELETE FROM call_log WHERE from_number = $1`, [customer]);
  await pool.query(`DELETE FROM voicemails WHERE from_number = $1`, [customer]);
  await pool.query(`DELETE FROM sms_conversations WHERE thread_key = $1`, [key]);
  await pool.query(`DELETE FROM auth_users WHERE id = ANY($1::varchar[])`, [[staffId, otherId]]);
  await pool.end();
});

test("an inbound customer text shows as open, unassigned and unread", async () => {
  const conversation = await ensureConversation(customer, true);
  const { status, json } = await api("GET", "/api/sms/inbox?filter=unassigned");
  assert.equal(status, 200);
  const row = json.conversations.find((c: any) => c.threadKey === key);
  assert.ok(row, "customer conversation listed");
  assert.equal(row.conversationId, conversation.id);
  assert.equal(row.status, "open");
  assert.equal(row.assignedUserId, null);
  assert.equal(row.unread, true);

  await api("POST", `/api/sms/inbox/${key}/read`);
  const after = await api("GET", "/api/sms/inbox?filter=open");
  assert.equal(after.json.conversations.find((c: any) => c.threadKey === key).unread, false);
});

test("a team reply goes out as the main line, records who sent it, claims and mirrors", async () => {
  const result = await sendTeamReply({
    customerNumber: customer,
    body: "Yes — ready for pickup.",
    sentBy: { userId: staffId, name: "Ana Diaz" },
    sendSms: fakeSendSms,
    mirror: recordMirror,
  });
  assert.equal(result.from, mainLine);
  const mirror = mirrored.at(-1)!;
  assert.equal(mirror.conversationId, result.conversationId);
  assert.equal(mirror.senderName, "Ana Diaz");

  const mine = await api("GET", "/api/sms/inbox?filter=mine");
  const row = mine.json.conversations.find((c: any) => c.threadKey === key);
  assert.equal(row.assignedName, "Ana Diaz");
  assert.equal(row.lastSentBy, "Ana Diaz");
});

test("the timeline merges texts, team notes, calls and voicemails", async () => {
  const note = await api("POST", `/api/sms/inbox/${key}/notes`, { body: "Customer prefers texts after 6pm." });
  assert.equal(note.status, 201);
  assert.equal((await api("POST", `/api/sms/inbox/${key}/notes`, { body: "   " })).status, 400);
  await pool.query(
    `INSERT INTO call_log (call_sid, from_number, to_number, status, direction) VALUES ($1, $2, $3, 'no-answer', 'inbound')`,
    [`CA${randomBytes(16).toString("hex")}`, customer, mainLine],
  );
  await pool.query(
    `INSERT INTO voicemails (call_sid, from_number, to_number, transcription) VALUES ('CAvm', $1, $2, 'Please call me back')`,
    [customer, mainLine],
  );

  const { status, json } = await api("GET", `/api/sms/inbox/${key}`);
  assert.equal(status, 200);
  const kinds = json.items.map((item: any) => item.kind);
  assert.ok(kinds.includes("message") && kinds.includes("note") && kinds.includes("call") && kinds.includes("voicemail"));
  const reply = json.items.find((item: any) => item.kind === "message" && item.direction === "outbound");
  assert.equal(reply.sentBy, "Ana Diaz");
  assert.equal(json.items.find((item: any) => item.kind === "note").author, "Ana Diaz");
});

test("done conversations reopen when the customer texts again; only approved staff can be assigned", async () => {
  assert.equal((await api("PATCH", `/api/sms/inbox/${key}`, { status: "done" })).json.status, "done");
  assert.ok((await api("GET", "/api/sms/inbox?filter=done")).json.conversations.some((c: any) => c.threadKey === key));
  assert.equal((await ensureConversation(customer, true)).status, "open");

  assert.equal((await api("PATCH", `/api/sms/inbox/${key}`, { assignedUserId: otherId })).status, 400);
  assert.equal((await api("PATCH", `/api/sms/inbox/${key}`, { status: "archived" })).status, 400);
  assert.equal((await api("PATCH", `/api/sms/inbox/${key}`, { assignedUserId: null })).json.assignedUserId, null);
});

test("reply-by-text relays only for a phone that was forwarded that conversation", async () => {
  const conversation = await ensureConversation(customer);
  const before = sent.length;
  const refused = await relayStaffReply(
    { staffPhone, conversationId: conversation.id, message: "On my way" },
    { sendSms: fakeSendSms, mirror: recordMirror },
  );
  assert.match(refused, /^Not sent: #\d+ wasn't forwarded to this phone/);
  assert.equal(sent.length, before, "nothing texted to the customer");

  await pool.query(
    `INSERT INTO sms_forward_deliveries (inbound_message_sid, target_number, source_number, business_number, body, status)
     VALUES ($1, $2, $3, $4, 'forward', 'sent')`,
    [`SM${randomBytes(16).toString("hex")}`, staffPhone, customer, mainLine],
  );
  const confirmation = await relayStaffReply(
    { staffPhone, conversationId: conversation.id, message: "On my way" },
    { sendSms: fakeSendSms, mirror: recordMirror },
  );
  assert.match(confirmation, /^Sent to .*\(202\) 555-0\d{3} from the CSD main line\.$/);
  assert.deepEqual(sent.at(-1)!.to, customer);
  assert.equal(sent.at(-1)!.body, "On my way");
  assert.equal(mirrored.at(-1)!.excludePhone, staffPhone, "the relaying tech doesn't get their own reply back");
});
