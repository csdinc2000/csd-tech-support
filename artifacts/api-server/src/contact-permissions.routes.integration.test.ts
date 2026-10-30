import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import { createServer, type Server } from "node:http";
import { pool } from "./db";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";
import { registerContactCrmRoutes } from "./routes/contact-crm-routes";
import { registerContactOverviewRoute } from "./routes/contact-overview-route";
import { registerGoogleContactRoutes } from "./routes/google-contact-routes";
import { registerContactSmsRoutes } from "./routes/contact-sms-routes";
import { registerContactImportRoutes } from "./contact-import";
import { registerInvoiceRoutes } from "./invoice-routes";

const marker = `contact-route-access-${process.pid}-${Date.now()}`;
const ids = {
  unassigned: `${marker}-unassigned`,
  viewer: `${marker}-viewer`,
  editor: `${marker}-editor`,
  suspended: `${marker}-suspended`,
  administrator: `${marker}-administrator`,
  owner: `${marker}-owner`,
};
const ownerEmail = `${marker}-owner@example.invalid`;
const phoneSeed = Date.now() % 10_000_000;
const mobileNumbers = [0, 1, 2].map(
  (offset) => `+1555${String((phoneSeed + offset) % 10_000_000).padStart(7, "0")}`,
);
let oldAdminEmails: string | undefined;
let server: Server;
let baseUrl = "";
let clientId = 0;
let contactIds: number[] = [];
let interactionIds: number[] = [];
let googleCalls = 0;
let twilioCalls = 0;
let consentEligibilityCalls = 0;

function request(path: string, actor: keyof typeof ids, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-test-actor": ids[actor],
      ...init?.headers,
    },
  });
}

async function json(path: string, actor: keyof typeof ids, init?: RequestInit) {
  const response = await request(path, actor, init);
  return { response, body: await response.json() as any };
}

before(async () => {
  oldAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = ownerEmail;
  await applyStaffAccessMigration();

  for (const [actor, id] of Object.entries(ids)) {
    await pool.query(
      `INSERT INTO auth_users(id,email,first_name,last_name)
       VALUES($1,$2,$3,'Route Test') ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email`,
      [id, actor === "owner" ? ownerEmail : `${id}@example.invalid`, actor],
    );
  }
  await pool.query(
    `INSERT INTO staff_access_profiles(user_id,role,approval_status,can_view_voicemails,feature_permissions)
     VALUES
       ($1,'accounting','approved',TRUE,'{}'),
       ($2,'accounting','approved',TRUE,'{}'),
       ($3,'accounting','approved',TRUE,'{}'),
       ($4,'accounting','suspended',TRUE,'{}'),
       ($5,'administrator','approved',TRUE,'{}'),
       ($6,'administrator','approved',TRUE,'{}')
     ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role,approval_status=EXCLUDED.approval_status,
       can_view_voicemails=EXCLUDED.can_view_voicemails,feature_permissions=EXCLUDED.feature_permissions`,
    [ids.unassigned, ids.viewer, ids.editor, ids.suspended, ids.administrator, ids.owner],
  );

  const client = await pool.query(
    "INSERT INTO clients(name,contact_email) VALUES($1,$2) RETURNING id",
    [marker, `${marker}@example.invalid`],
  );
  clientId = Number(client.rows[0].id);
  const contacts = await pool.query(
    `INSERT INTO crm_contacts(full_name,email,mobile_phone,client_id)
     VALUES($1,$2,$3,$4),($5,$6,$7,$4),($8,$9,$10,$4) RETURNING id`,
    [
      `${marker}-view`, `${marker}-view@example.invalid`, mobileNumbers[0], clientId,
      `${marker}-edit`, `${marker}-edit@example.invalid`, mobileNumbers[1],
      `${marker}-hidden`, `${marker}-hidden@example.invalid`, mobileNumbers[2],
    ],
  );
  contactIds = contacts.rows.map((row) => Number(row.id));
  const interactions = await pool.query(
    `INSERT INTO crm_interactions(contact_id,type,summary)
     VALUES($1,'note',$2),($3,'note',$4),($5,'note',$6) RETURNING id`,
    [
      contactIds[0], `${marker}-view-interaction`,
      contactIds[1], `${marker}-edit-interaction`,
      contactIds[2], `${marker}-hidden-interaction`,
    ],
  );
  interactionIds = interactions.rows.map((row) => Number(row.id));

  await pool.query(
    `INSERT INTO staff_client_assignments(user_id,client_id)
     VALUES($1,$3),($2,$3)`,
    [ids.viewer, ids.editor, clientId],
  );
  await pool.query(
    `INSERT INTO staff_contact_assignments(user_id,contact_id,can_edit)
     VALUES($1,$3,FALSE),($2,$4,TRUE)`,
    [ids.viewer, ids.editor, contactIds[0], contactIds[1]],
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const actorId = String(req.header("x-test-actor") || "");
    const email = actorId === ids.owner ? ownerEmail : `${actorId}@example.invalid`;
    (req as any).auth = Object.assign(() => ({
      userId: actorId,
      sessionClaims: { userId: actorId, email },
    }), { [Symbol.for("@clerk/express.auth")]: true });
    req.dbUser = {
      id: actorId,
      email,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    (req as any).log = { error() {}, warn() {}, info() {} };
    next();
  });

  const canSeeClient = (scope: any, clientId: number | null | undefined) =>
    scope.unrestricted || (clientId != null && scope.clientIds.has(clientId));
  const canSeeContact = (scope: any, contactId: number | null | undefined) =>
    scope.unrestricted || (contactId != null && scope.contactIds.has(contactId));
  const canEditContact = (scope: any, contactId: number | null | undefined) =>
    scope.unrestricted || (contactId != null && scope.editableContactIds.has(contactId));

  registerContactOverviewRoute(app, { canSeeClient, canSeeContact });
  registerContactCrmRoutes(app, { canSeeClient, canSeeContact, canEditContact });
  registerGoogleContactRoutes(app, {
    canSeeContact,
    canEditContact,
    googleContactsService: {
      getStatus: () => ({ configured: true, authenticated: true }),
      getAuthUrl: () => "https://example.invalid/oauth",
      handleAuthCallback: async () => ({}),
      createContact: async () => {
        googleCalls += 1;
        return { resourceName: "people/test" } as any;
      },
      listAllContacts: async () => {
        googleCalls += 1;
        return [];
      },
    } as any,
  });
  registerContactSmsRoutes(app, {
    canSeeContact,
    canEditContact,
    isTwilioConfigured: () => true,
    getSmsConsentEligibility: async () => {
      consentEligibilityCalls += 1;
      return { eligible: true, reason: null };
    },
    sendSms: async (to: string) => {
      twilioCalls += 1;
      return { sid: `SM-${to}`, to, from: "+15555550999", status: "sent" };
    },
  });
  registerContactImportRoutes(app, { authMiddleware: (_req, _res, next) => next() });
  registerInvoiceRoutes(app, { authMiddleware: (_req, _res, next) => next() });
  server = createServer(app);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query("DELETE FROM crm_interactions WHERE summary LIKE $1", [`${marker}%`]);
  await pool.query("DELETE FROM crm_contacts WHERE full_name LIKE $1 OR email LIKE $1", [`${marker}%`]);
  await pool.query("DELETE FROM clients WHERE name=$1", [marker]);
  await pool.query("DELETE FROM staff_access_profiles WHERE user_id LIKE $1", [`${marker}%`]);
  await pool.query("DELETE FROM auth_users WHERE id LIKE $1", [`${marker}%`]);
  if (oldAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = oldAdminEmails;
});

test("real contact routes enforce hidden, view-only, editable, suspended, administrator, and owner access", async () => {
  for (const actor of ["unassigned", "suspended"] as const) {
    const list = await json("/api/crm/contacts", actor);
    assert.equal(list.response.status, 200);
    assert.deepEqual(list.body.filter((contact: any) => contactIds.includes(contact.id)), []);
    assert.equal((await request(`/api/crm/contacts/${contactIds[0]}`, actor)).status, 404);
  }

  const viewerList = await json("/api/crm/contacts", "viewer");
  assert.deepEqual(
    viewerList.body.filter((contact: any) => contactIds.includes(contact.id)).map((contact: any) => [contact.id, contact.canEdit]),
    [[contactIds[0], false]],
  );
  const editorList = await json("/api/crm/contacts", "editor");
  assert.deepEqual(
    editorList.body.filter((contact: any) => contactIds.includes(contact.id)).map((contact: any) => [contact.id, contact.canEdit]),
    [[contactIds[1], true]],
  );
  for (const actor of ["administrator", "owner"] as const) {
    const list = await json("/api/crm/contacts", actor);
    const visible = list.body.filter((contact: any) => contactIds.includes(contact.id));
    assert.equal(visible.length, 3);
    assert.ok(visible.every((contact: any) => contact.canEdit === true));
  }

  assert.equal((await request(`/api/crm/contacts/${contactIds[0]}`, "viewer", {
    method: "PATCH",
    body: JSON.stringify({ notes: "must not be written" }),
  })).status, 403);
  assert.equal((await request(`/api/crm/contacts/${contactIds[1]}`, "editor", {
    method: "PATCH",
    body: JSON.stringify({ notes: `${marker}-allowed` }),
  })).status, 200);
  const saved = await pool.query("SELECT notes FROM crm_contacts WHERE id=$1", [contactIds[1]]);
  assert.equal(saved.rows[0].notes, `${marker}-allowed`);
});

test("account overview and interaction routes disclose only explicitly assigned contacts", async () => {
  const unassignedOverview = await request(`/api/clients/${clientId}/overview`, "unassigned");
  assert.equal(unassignedOverview.status, 404);

  const viewerOverview = await json(`/api/clients/${clientId}/overview`, "viewer");
  assert.equal(viewerOverview.response.status, 200);
  assert.deepEqual(viewerOverview.body.contacts.map((contact: any) => contact.id), [contactIds[0]]);
  assert.deepEqual(
    viewerOverview.body.communications.interactions.map((interaction: any) => interaction.id),
    [interactionIds[0]],
  );

  const interactions = await json("/api/crm/interactions", "viewer");
  assert.deepEqual(
    interactions.body.filter((interaction: any) => interactionIds.includes(interaction.id)).map((interaction: any) => interaction.id),
    [interactionIds[0]],
  );
  assert.equal((await request(`/api/crm/interactions/${interactionIds[2]}`, "viewer")).status, 404);
  assert.equal((await request("/api/crm/interactions", "viewer", {
    method: "POST",
    body: JSON.stringify({ contactId: contactIds[0], type: "note", summary: `${marker}-denied` }),
  })).status, 403);
  assert.equal((await request("/api/crm/interactions", "editor", {
    method: "POST",
    body: JSON.stringify({ contactId: contactIds[1], type: "note", summary: `${marker}-allowed-interaction` }),
  })).status, 201);
});

test("bulk SMS routes hide unassigned recipients and never call Twilio for denied contacts", async () => {
  const recipients = await json("/api/sms/bulk-recipients?messageClass=service", "viewer");
  assert.deepEqual(
    recipients.body.filter((contact: any) => contactIds.includes(contact.contactId)).map((contact: any) => contact.contactId),
    [contactIds[0]],
  );

  const callsBefore = twilioCalls;
  const response = await json("/api/sms/bulk-send", "viewer", {
    method: "POST",
    body: JSON.stringify({
      messageClass: "service",
      body: "Permission regression test",
      contactIds: [contactIds[0], contactIds[1], contactIds[2]],
    }),
  });
  assert.equal(response.response.status, 200);
  assert.equal(response.body.sent, 0);
  assert.deepEqual(response.body.results.map((result: any) => result.reason), [
    "Contact edit assignment required",
    "Contact not found",
    "Contact not found",
  ]);
  assert.equal(twilioCalls, callsBefore);
});

test("one-to-one SMS requires edit access for known contacts and explicitly permits approved staff to text unlinked numbers", async () => {
  const callsBefore = twilioCalls;
  for (const [actor, phone, status] of [
    ["viewer", mobileNumbers[0], 403],
    ["viewer", mobileNumbers[2], 404],
    ["unassigned", mobileNumbers[1], 404],
  ] as const) {
    const denied = await request("/api/sms/send", actor, {
      method: "POST",
      body: JSON.stringify({ to: phone, body: "Must not be sent" }),
    });
    assert.equal(denied.status, status);
  }
  assert.equal(twilioCalls, callsBefore);

  const allowedKnown = await request("/api/sms/send", "editor", {
    method: "POST",
    body: JSON.stringify({ to: mobileNumbers[1], body: "Editable contact" }),
  });
  assert.equal(allowedKnown.status, 200);
  assert.equal(twilioCalls, callsBefore + 1);

  const unlinkedNumber = "+15555550199";
  const allowedUnlinked = await request("/api/sms/send", "viewer", {
    method: "POST",
    body: JSON.stringify({ to: unlinkedNumber, body: "Unlinked number policy" }),
  });
  assert.equal(allowedUnlinked.status, 200);
  assert.equal(twilioCalls, callsBefore + 2);

  const deniedSuspended = await request("/api/sms/send", "suspended", {
    method: "POST",
    body: JSON.stringify({ to: "+15555550198", body: "Must not be sent" }),
  });
  assert.equal(deniedSuspended.status, 403);
  assert.equal(twilioCalls, callsBefore + 2);
});

test("one-to-one and bulk SMS reject implausible phone numbers before delivery", async () => {
  const callsBefore = twilioCalls;
  for (const phone of [
    "+1234567",
    "+1234567890123456",
    "+44 20 7invalid",
  ]) {
    const invalid = await json("/api/sms/send", "viewer", {
      method: "POST",
      body: JSON.stringify({ to: phone, body: "Must not be sent" }),
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.error, "Destination phone number must be a valid E.164 number");
  }
  assert.equal(twilioCalls, callsBefore);

  for (const phone of [
    "+1234567",
    "+1234567890123456",
    "+44++2071234567",
  ]) {
    await pool.query("UPDATE crm_contacts SET mobile_phone=$1 WHERE id=$2", [phone, contactIds[1]]);
    const consentCallsBefore = consentEligibilityCalls;
    const recipients = await json("/api/sms/bulk-recipients?messageClass=service", "editor");
    const invalidRecipient = recipients.body.find((contact: any) => contact.contactId === contactIds[1]);
    assert.deepEqual(invalidRecipient, {
      contactId: contactIds[1],
      name: `${marker}-edit`,
      mobilePhone: phone,
      eligible: false,
      reason: "Invalid mobile number",
    });
    assert.equal(consentEligibilityCalls, consentCallsBefore);

    const invalid = await json("/api/sms/bulk-send", "editor", {
      method: "POST",
      body: JSON.stringify({
        messageClass: "service",
        body: "Must not be sent",
        contactIds: [contactIds[1]],
      }),
    });
    assert.equal(invalid.response.status, 200);
    assert.equal(invalid.body.sent, 0);
    assert.equal(invalid.body.results[0].reason, "Contact has an invalid mobile number");
  }
  await pool.query("UPDATE crm_contacts SET mobile_phone=$1 WHERE id=$2", [mobileNumbers[1], contactIds[1]]);
  assert.equal(twilioCalls, callsBefore);
});

test("contact creates and edits reject malformed phones while keeping valid formatting", async () => {
  for (const [field, value, message] of [
    ["mobilePhone", "+44 20 CALL-NOW", "Mobile phone must be a valid phone number"],
    ["officePhone", "+44++2071234567", "Office phone must be a valid phone number"],
  ] as const) {
    const created = await json("/api/crm/contacts", "owner", {
      method: "POST",
      body: JSON.stringify({ fullName: `${marker}-${field}-invalid`, [field]: value }),
    });
    assert.equal(created.response.status, 400);
    assert.equal(created.body.error, message);

    const updated = await json(`/api/crm/contacts/${contactIds[1]}`, "editor", {
      method: "PATCH",
      body: JSON.stringify({ [field]: value }),
    });
    assert.equal(updated.response.status, 400);
    assert.equal(updated.body.error, message);
  }

  const formatted = "(512) 555-0199";
  const updated = await json(`/api/crm/contacts/${contactIds[1]}`, "editor", {
    method: "PATCH",
    body: JSON.stringify({ officePhone: formatted }),
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.officePhone, formatted);
});

test("contact imports report malformed phone fields and do not save those rows", async () => {
  const invalidEmail = `${marker}-invalid-phone@example.com`;
  const csv = [
    "Name,Email,Mobile Phone,Office Phone",
    `${marker}-invalid-phone,${invalidEmail},+44 20 CALL-NOW,+44++2071234567`,
  ].join("\n");

  const preview = await json("/api/contact-import/preview", "owner", {
    method: "POST",
    body: JSON.stringify({ csv }),
  });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.body.counts.skip, 1);
  assert.match(preview.body.rows[0].issue, /Mobile phone is invalid/);
  assert.match(preview.body.rows[0].issue, /Office phone is invalid/);

  const imported = await json("/api/contact-import/import", "owner", {
    method: "POST",
    body: JSON.stringify({ csv }),
  });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.body.skipped, 1);
  assert.match(imported.body.errors[0], /Mobile phone is invalid/);
  const saved = await pool.query("SELECT id FROM crm_contacts WHERE email=$1", [invalidEmail]);
  assert.equal(saved.rowCount, 0);
});

test("contact imports write only selected preview rows, leaving other new and existing contacts untouched", async () => {
  const existingEmail = `${marker}-unselected-existing@example.invalid`;
  const selectedEmail = `${marker}-selected@example.invalid`;
  const unselectedEmail = `${marker}-unselected-new@example.invalid`;
  await pool.query("INSERT INTO crm_contacts(full_name,email) VALUES($1,$2)", [`${marker}-existing`, existingEmail]);
  const csv = [
    "Name,Email,Company",
    `${marker}-existing,${existingEmail},Must Not Fill`,
    `${marker}-selected,${selectedEmail},Selected Company`,
    `${marker}-unselected-new,${unselectedEmail},Must Not Add`,
  ].join("\n");
  const preview = await json("/api/contact-import/preview", "owner", { method: "POST", body: JSON.stringify({ csv }) });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.body.rows[0].action, "enrich");
  assert.equal(preview.body.rows[1].email, selectedEmail);

  const result = await json("/api/contact-import/import", "owner", {
    method: "POST", body: JSON.stringify({ csv, selectedRows: [1] }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.created, 1);
  assert.equal(result.body.enriched, 0);
  const rows = await pool.query("SELECT email, company FROM crm_contacts WHERE email = ANY($1::text[])", [[existingEmail, selectedEmail, unselectedEmail]]);
  assert.equal(rows.rows.length, 2);
  assert.equal(rows.rows.find((row) => row.email === existingEmail).company, null);
  assert.equal(rows.rows.find((row) => row.email === selectedEmail).company, "Selected Company");
  assert.equal(rows.rows.some((row) => row.email === unselectedEmail), false);
});

test("empty or invalid import selections never fall back to importing the whole CSV", async () => {
  const email = `${marker}-selection-validation@example.invalid`;
  const csv = `Name,Email\n${marker}-selection-validation,${email}`;
  for (const selectedRows of [[], [1], [-1], [0, 0], ["0"], null]) {
    const result = await json("/api/contact-import/import", "owner", {
      method: "POST", body: JSON.stringify({ csv, selectedRows }),
    });
    assert.equal(result.response.status, Array.isArray(selectedRows) && selectedRows.length === 0 ? 200 : 400);
    if (result.response.status === 200) assert.equal(result.body.created, 0);
    const saved = await pool.query("SELECT id FROM crm_contacts WHERE email=$1", [email]);
    assert.equal(saved.rowCount, 0);
  }
});

test("new invoice recipients reject malformed phones without creating contacts", async () => {
  for (const [suffix, phone] of [
    ["letters", "+44 20 CALL-NOW"],
    ["pluses", "+44++2071234567"],
  ] as const) {
    const email = `${marker}-invoice-${suffix}@example.com`;
    const result = await json("/api/invoices", "owner", {
      method: "POST",
      body: JSON.stringify({
        recipient: { kind: "new", name: "Invalid Invoice Phone", email, phone },
        lineItems: [{ description: "Service", quantity: 1, unitAmountCents: 1000 }],
      }),
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error, "phone number is invalid");
    const saved = await pool.query("SELECT id FROM crm_contacts WHERE email=$1", [email]);
    assert.equal(saved.rowCount, 0);
  }
});

test("denied Google sync and administrator-only imports make no external call or database write", async () => {
  const callsBefore = googleCalls;
  assert.equal((await request(`/api/google/sync-contact/${contactIds[2]}`, "viewer", { method: "POST" })).status, 404);
  assert.equal((await request(`/api/google/sync-contact/${contactIds[0]}`, "viewer", { method: "POST" })).status, 403);
  assert.equal((await request("/api/google/sync-all-contacts", "viewer", { method: "POST" })).status, 403);
  assert.equal((await request("/api/google/import-contacts", "suspended", { method: "POST" })).status, 403);
  assert.equal(googleCalls, callsBefore);

  const csv = `Name,Email\n${marker}-imported,${marker}-imported@example.invalid`;
  for (const actor of ["viewer", "editor", "suspended"] as const) {
    assert.equal((await request("/api/contact-import/preview", actor, {
      method: "POST", body: JSON.stringify({ csv }),
    })).status, 403);
    assert.equal((await request("/api/contact-import/import", actor, {
      method: "POST", body: JSON.stringify({ csv }),
    })).status, 403);
  }
  const deniedRows = await pool.query("SELECT id FROM crm_contacts WHERE email=$1", [`${marker}-imported@example.invalid`]);
  assert.equal(deniedRows.rowCount, 0);

  for (const actor of ["administrator", "owner"] as const) {
    const preview = await request("/api/contact-import/preview", actor, {
      method: "POST", body: JSON.stringify({ csv }),
    });
    assert.equal(preview.status, 200);
  }
  const imported = await request("/api/contact-import/import", "owner", {
    method: "POST", body: JSON.stringify({ csv, fileName: `${marker}.csv` }),
  });
  assert.equal(imported.status, 200);
  const importedRows = await pool.query("SELECT id FROM crm_contacts WHERE email=$1", [`${marker}-imported@example.invalid`]);
  assert.equal(importedRows.rowCount, 1);
});