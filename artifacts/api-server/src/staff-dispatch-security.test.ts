import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  ensureStaffDispatchTables,
  getActiveCallRecipientPhones,
  handleStaffInboundSms,
  processStaffClientMessageHistory,
  registerStaffDispatchRoutes,
  sendClientMessage,
  updateStaffClientMessageAfterSend,
} from "./staff-dispatch";
import { pool } from "./db";
import { applyStaffInvitesMigration } from "./migrations/2026-09-23-staff-invites";
import { updateSmsMessageStatus } from "./twilio-tracking-storage";
import { requiredFeatureForApiPath } from "./security";
import { roleFeatureMap } from "./staff-access";
import { apiAuthenticationBoundary } from "./api-auth-boundary";

test("logged-out Dispatch Settings requests stop at the production API auth boundary", async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Clerk has already verified this request and found no active session.
    (req as any).auth = Object.assign(() => ({
      tokenType: "session_token",
      userId: null,
      sessionClaims: null,
    }), { [Symbol.for("@clerk/express.auth")]: true });
    next();
  });
  app.use(apiAuthenticationBoundary);
  registerStaffDispatchRoutes(app);
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start Dispatch auth test server");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    for (const [method, path, body] of [
      ["GET", "/api/staff-dispatch/settings"],
      ["POST", "/api/staff-dispatch/settings", "{}"],
      ["PATCH", "/api/staff-dispatch/settings/987654", "{}"],
      ["DELETE", "/api/staff-dispatch/settings/987654"],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        ...(body ? { headers: { "content-type": "application/json" }, body } : {}),
      });
      assert.equal(response.status, 401, `${method} ${path}: ${await response.text()}`);
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});

test("database-backed dispatch commands enforce roster, assignment, consent, and atomic claims", async () => {
  await ensureStaffDispatchTables();
  await applyStaffInvitesMigration();
  const suffix = `${process.pid}${Date.now()}`;
  const phone = (digit: string) => `+1555${suffix.slice(-6)}${digit}`.slice(0, 12);
  const ticketNumber = (name: string) => `SEC-${suffix}-${name}`;
  const ids = {
    users: [] as number[],
    authUsers: [] as string[],
    recipients: [] as number[],
    tickets: [] as number[],
    contacts: [] as number[],
    consentPhones: [] as string[],
  };

  const addUser = async (name: string) => {
    const email = `dispatch-${name}-${suffix}@example.invalid`;
    const result = await pool.query(
      `INSERT INTO users(username,password,email,role)
       VALUES($1,'not-a-real-password',$2,'user') RETURNING id`,
      [`dispatch-${name}-${suffix}`, email],
    );
    ids.users.push(result.rows[0].id);
    const authId = `dispatch-auth-${name}-${suffix}`;
    await pool.query("INSERT INTO auth_users (id,email,first_name) VALUES ($1,$2,$3)", [authId, email, name]);
    ids.authUsers.push(authId);
    await pool.query(
      `INSERT INTO staff_access_profiles (user_id,role,approval_status)
       VALUES ($1,'field_technician','approved')`,
      [authId],
    );
    await pool.query(
      "INSERT INTO staff_helpdesk_links (auth_user_id,helpdesk_user_id) VALUES ($1,$2)",
      [authId, result.rows[0].id],
    );
    return result.rows[0].id as number;
  };
  const addRecipient = async (
    name: string,
    recipientPhone: string,
    flags: { enabled?: boolean; onDuty?: boolean; linkedUserId?: number | null } = {},
  ) => {
    const result = await pool.query(
      `INSERT INTO staff_dispatch_recipients
        (display_name,phone,enabled,on_duty,receive_calls,receive_messages,can_use_commands,linked_user_id)
       VALUES($1,$2,$3,$4,FALSE,FALSE,TRUE,$5) RETURNING id`,
      [
        `Security ${name}`,
        recipientPhone,
        flags.enabled ?? true,
        flags.onDuty ?? true,
        flags.linkedUserId ?? null,
      ],
    );
    ids.recipients.push(result.rows[0].id);
    return result.rows[0].id as number;
  };
  const addTicket = async (
    name: string,
    assignedTo: number | null = null,
    requesterPhone: string | null = null,
  ) => {
    const result = await pool.query(
      `INSERT INTO tickets(subject,priority,status,ticket_number,assigned_to,requester_phone)
       VALUES($1,'medium','open',$2,$3,$4) RETURNING id`,
      [`Security test ${name}`, ticketNumber(name), assignedTo, requesterPhone],
    );
    ids.tickets.push(result.rows[0].id);
    return result.rows[0].id as number;
  };

  try {
    const firstUser = await addUser("first");
    const secondUser = await addUser("second");
    const disabledPhone = phone("1");
    const offDutyPhone = phone("2");
    const unlinkedPhone = phone("3");
    const firstPhone = phone("4");
    const secondPhone = phone("5");
    await addRecipient("disabled", disabledPhone, { enabled: false, linkedUserId: firstUser });
    await addRecipient("off-duty", offDutyPhone, { onDuty: false, linkedUserId: firstUser });
    await addRecipient("unlinked", unlinkedPhone);
    await addRecipient("first", firstPhone, { linkedUserId: firstUser });
    await addRecipient("second", secondPhone, { linkedUserId: secondUser });

    const protectedTicketId = await addTicket("PROTECTED");
    for (const sender of [phone("9"), disabledPhone, offDutyPhone]) {
      const result = await handleStaffInboundSms(sender, `CLAIM ${ticketNumber("PROTECTED")}`);
      assert.equal(result.handled, false);
    }
    const unlinked = await handleStaffInboundSms(
      unlinkedPhone,
      `CLAIM ${ticketNumber("PROTECTED")}`,
    );
    assert.equal(unlinked.handled, false);
    const protectedTicket = await pool.query(
      "SELECT assigned_to,status FROM tickets WHERE id=$1",
      [protectedTicketId],
    );
    assert.equal(protectedTicket.rows[0].assigned_to, null);
    assert.equal(protectedTicket.rows[0].status, "open");

    const claimTicketId = await addTicket("ATOMIC");
    const claimReplies = await Promise.all([
      handleStaffInboundSms(firstPhone, `CLAIM ${ticketNumber("ATOMIC")}`),
      handleStaffInboundSms(secondPhone, `CLAIM ${ticketNumber("ATOMIC")}`),
    ]);
    assert.equal(claimReplies.filter((reply) => /claimed by/i.test(reply.reply ?? "")).length, 1);
    assert.equal(claimReplies.filter((reply) => /already assigned/i.test(reply.reply ?? "")).length, 1);
    const claimed = await pool.query(
      "SELECT assigned_to,status FROM tickets WHERE id=$1",
      [claimTicketId],
    );
    assert.ok([firstUser, secondUser].includes(claimed.rows[0].assigned_to));
    assert.equal(claimed.rows[0].status, "in-progress");

    const closeTicketId = await addTicket("CLOSE", firstUser);
    const deniedClose = await handleStaffInboundSms(
      secondPhone,
      `CLOSE ${ticketNumber("CLOSE")}`,
    );
    assert.match(deniedClose.reply ?? "", /only its assigned staff member/i);
    assert.equal(
      (await pool.query("SELECT status FROM tickets WHERE id=$1", [closeTicketId])).rows[0].status,
      "open",
    );
    const allowedClose = await handleStaffInboundSms(
      firstPhone,
      `CLOSE ${ticketNumber("CLOSE")}`,
    );
    assert.match(allowedClose.reply ?? "", /closed/i);
    assert.equal(
      (await pool.query("SELECT status FROM tickets WHERE id=$1", [closeTicketId])).rows[0].status,
      "closed",
    );

    const clientPhone = phone("8");
    const clientTicketId = await addTicket("CLIENT", firstUser, clientPhone);
    const deniedClient = await handleStaffInboundSms(
      secondPhone,
      `CLIENT ${ticketNumber("CLIENT")}: forged message`,
    );
    assert.match(deniedClient.reply ?? "", /only its assigned staff member/i);

    const reassignment = await pool.connect();
    try {
      await reassignment.query("BEGIN");
      await reassignment.query("SELECT id FROM tickets WHERE id=$1 FOR UPDATE", [clientTicketId]);
      const staleAssigneeAttempt = handleStaffInboundSms(
        firstPhone,
        `CLIENT ${ticketNumber("CLIENT")}: raced message`,
      );
      await reassignment.query(
        "UPDATE tickets SET assigned_to=$2 WHERE id=$1",
        [clientTicketId, secondUser],
      );
      await reassignment.query("COMMIT");
      const racedClient = await staleAssigneeAttempt;
      assert.match(racedClient.reply ?? "", /only its assigned staff member/i);
    } catch (error) {
      await reassignment.query("ROLLBACK");
      throw error;
    } finally {
      reassignment.release();
    }
    await pool.query(
      "UPDATE tickets SET assigned_to=$2 WHERE id=$1",
      [clientTicketId, firstUser],
    );

    const contact = await pool.query(
      "INSERT INTO crm_contacts(full_name,mobile_phone) VALUES($1,$2) RETURNING id",
      [`Security contact ${suffix}`, clientPhone],
    );
    ids.contacts.push(contact.rows[0].id);
    await pool.query(
      `INSERT INTO crm_interactions(contact_id,type,summary)
       VALUES($1,'sms_consent','Historical intake consent')`,
      [contact.rows[0].id],
    );
    await pool.query(
      `INSERT INTO staff_dispatch_sms_consent(phone,consented)
       VALUES($1,FALSE)
       ON CONFLICT(phone) DO UPDATE SET consented=FALSE,updated_at=NOW()`,
      [clientPhone],
    );
    ids.consentPhones.push(clientPhone);
    const stoppedClient = await handleStaffInboundSms(
      firstPhone,
      `CLIENT ${ticketNumber("CLIENT")}: should not send`,
    );
    assert.match(stoppedClient.reply ?? "", /no requester SMS consent evidence/i);
    const messages = await pool.query(
      "SELECT COUNT(*)::int AS count FROM ticket_messages WHERE ticket_id=$1",
      [clientTicketId],
    );
    assert.equal(messages.rows[0].count, 0);

    await pool.query(
      `INSERT INTO staff_dispatch_sms_consent(phone,consented)
       VALUES($1,TRUE)
       ON CONFLICT(phone) DO UPDATE SET consented=TRUE,updated_at=NOW()`,
      [clientPhone],
    );
    let sends = 0;
    const fakeSender = async (to: string, body: string) => {
      sends++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { sid: `SM${suffix}`, to, from: "+15550000000", status: "queued" };
    };
    const staff = {
      id: ids.recipients[3],
      name: "Security first",
      displayName: "Security first",
      phone: firstPhone,
      enabled: true,
      onDuty: true,
      receiveCalls: false,
      receiveMessages: false,
      canUseCommands: true,
      linkedUserId: firstUser,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const ticket = {
      id: clientTicketId,
      ticketNumber: ticketNumber("CLIENT"),
      requesterPhone: clientPhone,
    };
    const idempotencySid = `IM${suffix}`;
    const duplicateResults = await Promise.all([
      sendClientMessage(staff, ticket, "idempotent message", idempotencySid, fakeSender),
      sendClientMessage(staff, ticket, "idempotent message", idempotencySid, fakeSender),
    ]);
    assert.equal(sends, 1);
    assert.deepEqual(duplicateResults.sort(), ["pending", "pending"]);
    const delivery = await pool.query(
      `SELECT status,provider_message_sid,history_saved
       FROM staff_dispatch_client_messages WHERE inbound_message_sid=$1`,
      [idempotencySid],
    );
    assert.equal(delivery.rowCount, 1);
    assert.equal(delivery.rows[0].status, "pending");
    assert.equal(delivery.rows[0].provider_message_sid, `SM${suffix}`);
    assert.equal(delivery.rows[0].history_saved, true);

    const historyFailureSid = `IH${suffix}`;
    const historyFailure = await sendClientMessage(
      staff,
      ticket,
      "visible after history failure",
      historyFailureSid,
      fakeSender,
      undefined,
      async () => {
        throw new Error("forced ticket history failure");
      },
    );
    assert.equal(historyFailure, "pending");
    const beforeRecovery = await pool.query(
      `SELECT id,status,history_saved FROM staff_dispatch_client_messages
       WHERE inbound_message_sid=$1`,
      [historyFailureSid],
    );
    assert.equal(beforeRecovery.rows[0].status, "pending");
    assert.equal(beforeRecovery.rows[0].history_saved, false);
    assert.equal(await processStaffClientMessageHistory(), 1);
    const afterRecovery = await pool.query(
      "SELECT history_saved,ticket_message_id FROM staff_dispatch_client_messages WHERE id=$1",
      [beforeRecovery.rows[0].id],
    );
    assert.equal(afterRecovery.rows[0].history_saved, true);
    assert.ok(afterRecovery.rows[0].ticket_message_id);

    const stateFailureSid = `IS${suffix}`;
    const stateFailureProviderSid = `SMSTATE${suffix}`;
    const stateFailure = await sendClientMessage(
      staff,
      ticket,
      "callback repairs state",
      stateFailureSid,
      async (to, body) => ({
        sid: stateFailureProviderSid,
        to,
        from: "+15550000000",
        status: "queued",
      }),
      async () => {
        throw new Error("forced post-send state failure");
      },
    );
    assert.equal(stateFailure, "pending");
    const stranded = await pool.query(
      `SELECT id,status,provider_message_sid FROM staff_dispatch_client_messages
       WHERE inbound_message_sid=$1`,
      [stateFailureSid],
    );
    assert.equal(stranded.rows[0].provider_message_sid, null);
    await updateSmsMessageStatus(
      stateFailureProviderSid,
      "delivered",
      null,
      Number(stranded.rows[0].id),
    );
    await updateStaffClientMessageAfterSend(
      Number(stranded.rows[0].id),
      "pending",
      stateFailureProviderSid,
    );
    const repaired = await pool.query(
      "SELECT status,provider_message_sid FROM staff_dispatch_client_messages WHERE id=$1",
      [stranded.rows[0].id],
    );
    assert.equal(repaired.rows[0].status, "delivered");
    assert.equal(repaired.rows[0].provider_message_sid, stateFailureProviderSid);
    await pool.query("UPDATE staff_dispatch_recipients SET receive_calls=TRUE WHERE id=$1", [ids.recipients[3]]);
    assert.ok((await getActiveCallRecipientPhones()).includes(firstPhone));
    await pool.query("UPDATE staff_access_profiles SET approval_status='suspended' WHERE user_id=$1", [ids.authUsers[0]]);
    assert.equal((await handleStaffInboundSms(firstPhone, `STATUS ${ticketNumber("ATOMIC")}`)).handled, false);
    assert.equal((await getActiveCallRecipientPhones()).includes(firstPhone), false);
  } finally {
    if (ids.tickets.length) {
      await pool.query("DELETE FROM tickets WHERE id=ANY($1::int[])", [ids.tickets]);
    }
    if (ids.contacts.length) {
      await pool.query("DELETE FROM crm_interactions WHERE contact_id=ANY($1::int[])", [ids.contacts]);
      await pool.query("DELETE FROM crm_contacts WHERE id=ANY($1::int[])", [ids.contacts]);
    }
    if (ids.consentPhones.length) {
      await pool.query(
        "DELETE FROM staff_dispatch_sms_consent WHERE phone=ANY($1::text[])",
        [ids.consentPhones],
      );
    }
    if (ids.recipients.length) {
      await pool.query("DELETE FROM staff_dispatch_audit WHERE recipient_id=ANY($1::int[])", [ids.recipients]);
      await pool.query("DELETE FROM staff_dispatch_recipients WHERE id=ANY($1::int[])", [ids.recipients]);
    }
    if (ids.users.length) {
      await pool.query("DELETE FROM users WHERE id=ANY($1::int[])", [ids.users]);
    }
    if (ids.authUsers.length) {
      await pool.query("DELETE FROM staff_helpdesk_links WHERE auth_user_id=ANY($1::text[])", [ids.authUsers]);
      await pool.query("DELETE FROM staff_access_profiles WHERE user_id=ANY($1::text[])", [ids.authUsers]);
      await pool.query("DELETE FROM auth_users WHERE id=ANY($1::text[])", [ids.authUsers]);
    }
  }
});

test("staff administrators cannot read Dispatch settings or history directly, while owners can", async () => {
  const marker = `dispatch-settings-access-${process.pid}-${Date.now()}`;
  const ownerEmail = `${marker}-owner@example.invalid`;
  const staffAdminEmail = `${marker}-staff-admin@example.invalid`;
  const previousAdminEmails = process.env.ADMIN_EMAILS;
  const previousQuery = pool.query;
  const previousConnect = pool.connect;
  const auditRows = [{ id: 987654, action: "recipient.updated", outcome: "accepted" }];
  const messageRows = [{ id: 987654, body: "isolated test message", status: "delivered" }];
  const readQueries: string[] = [];
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;

  process.env.ADMIN_EMAILS = ownerEmail;
  (pool as any).query = async (sql: string) => {
    if (sql.includes("CREATE TABLE IF NOT EXISTS staff_dispatch_recipients")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT r.*")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM staff_dispatch_audit ORDER BY")) {
      readQueries.push("audit");
      return { rows: auditRows, rowCount: auditRows.length };
    }
    if (sql.includes("FROM staff_dispatch_client_messages ORDER BY")) {
      readQueries.push("client-messages");
      return { rows: messageRows, rowCount: messageRows.length };
    }
    if (sql.includes("SELECT p.role FROM users h")) {
      return { rows: [{ role: "field_technician" }], rowCount: 1 };
    }
    throw new Error(`Unexpected Dispatch Settings query: ${sql.slice(0, 100)}`);
  };
  (pool as any).connect = async () => ({
    query: async (sql: string) => {
      if (sql.includes("INSERT INTO staff_dispatch_recipients")) {
        return {
          rows: [{
            id: 987654,
            display_name: "Regression Test Recipient",
            recipient_role: "technician",
            phone: "+15555550123",
            enabled: true,
            on_duty: true,
            receive_calls: false,
            receive_messages: true,
            can_use_commands: true,
            linked_user_id: 987654,
            created_at: new Date(),
            updated_at: new Date(),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  });

  try {
    assert.equal(roleFeatureMap("administrator").dispatchAdmin, true);
    for (const [method, path] of [
      ["GET", "/api/staff-dispatch/settings"],
      ["POST", "/api/staff-dispatch/settings"],
      ["PATCH", "/api/staff-dispatch/settings/987654"],
      ["DELETE", "/api/staff-dispatch/settings/987654"],
    ]) {
      assert.equal(requiredFeatureForApiPath(path, method), "owner", `${method} ${path}`);
    }
    assert.equal(requiredFeatureForApiPath("/api/staff-dispatch/recipients", "GET"), "dispatchAdmin");
    for (const path of ["/api/staff-dispatch/audit", "/api/staff-dispatch/client-messages"]) {
      assert.equal(requiredFeatureForApiPath(path, "GET"), "owner");
    }

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const actor = req.header("x-test-actor");
      const email = actor === "owner"
        ? ownerEmail
        : actor === "staff-admin"
          ? staffAdminEmail
          : undefined;
      (req as any).auth = Object.assign(() => ({
        tokenType: "session_token",
        userId: actor,
        sessionClaims: email ? { userId: actor, email } : undefined,
      }), { [Symbol.for("@clerk/express.auth")]: true });
      if (actor) {
        req.dbUser = { id: actor === "owner" ? 1 : 2 } as unknown as NonNullable<typeof req.dbUser>;
        req.ownerApprovalStatus = "approved";
      }
      next();
    });
    registerStaffDispatchRoutes(app);
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not start Dispatch Settings security test server");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = (actor: "owner" | "staff-admin", path: string, init?: RequestInit) =>
      fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init?.body ? { "content-type": "application/json" } : {}),
          "x-test-actor": actor,
          ...init?.headers,
        },
      });

    const staffRead = await request("staff-admin", "/api/staff-dispatch/settings");
    assert.equal(staffRead.status, 403, await staffRead.text());
    for (const path of ["/api/staff-dispatch/audit", "/api/staff-dispatch/client-messages"]) {
      const denied = await request("staff-admin", path);
      assert.equal(denied.status, 403, `${path}: ${await denied.text()}`);
    }
    assert.deepEqual(readQueries, [], "denied requests must not query sensitive history");

    const staffWrite = await request("staff-admin", "/api/staff-dispatch/settings", {
      method: "POST",
      body: JSON.stringify({
        displayName: "Regression Test Recipient",
        phone: "+15555550123",
        linkedUserId: 987654,
      }),
    });
    assert.equal(staffWrite.status, 403, await staffWrite.text());

    const staffUpdate = await request("staff-admin", "/api/staff-dispatch/settings/987654", {
      method: "PATCH",
      body: JSON.stringify({ displayName: "Unauthorized Update" }),
    });
    assert.equal(staffUpdate.status, 403, await staffUpdate.text());

    const staffDelete = await request("staff-admin", "/api/staff-dispatch/settings/987654", {
      method: "DELETE",
    });
    assert.equal(staffDelete.status, 403, await staffDelete.text());

    const ownerRead = await request("owner", "/api/staff-dispatch/settings");
    assert.equal(ownerRead.status, 200, await ownerRead.text());
    const ownerAudit = await request("owner", "/api/staff-dispatch/audit");
    assert.equal(ownerAudit.status, 200, await ownerAudit.clone().text());
    assert.deepEqual(await ownerAudit.json(), auditRows);
    const ownerMessages = await request("owner", "/api/staff-dispatch/client-messages");
    assert.equal(ownerMessages.status, 200, await ownerMessages.clone().text());
    assert.deepEqual(await ownerMessages.json(), messageRows);
    assert.deepEqual(readQueries, ["audit", "client-messages"]);

    const ownerWrite = await request("owner", "/api/staff-dispatch/settings", {
      method: "POST",
      body: JSON.stringify({
        displayName: "Regression Test Recipient",
        phone: "+15555550123",
        linkedUserId: 987654,
      }),
    });
    assert.equal(ownerWrite.status, 201, await ownerWrite.text());
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => error ? reject(error) : resolve()),
      );
    }
    (pool as any).query = previousQuery;
    (pool as any).connect = previousConnect;
    if (previousAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previousAdminEmails;
  }
});