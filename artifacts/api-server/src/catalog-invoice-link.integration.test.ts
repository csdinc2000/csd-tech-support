import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { pool } from "./db";
import { registerCatalogRoutes } from "./catalog";
import { ensureInvoiceSchema, registerInvoiceRoutes } from "./invoice-routes";
import {
  applyCatalogInvoiceLinkMigration,
  applyCatalogMigration,
} from "./migrations/2026-09-28-catalog";
import { applyStaffAccessMigration } from "./migrations/2026-09-07-staff-access";

const marker = `catalog-invoice-link-${process.pid}-${Date.now()}`;
const ownerId = `${marker}-owner`;
const ownerEmail = `${marker}@example.invalid`;
const inquiryIds: string[] = [];
const invoiceIds: number[] = [];
const contactIds: number[] = [];
const clientIds: number[] = [];
const triggerNames: Array<{ trigger: string; fn: string }> = [];
let previousAdminEmails: string | undefined;
let server: Server | undefined;
let baseUrl = "";

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).auth = Object.assign(() => ({
      tokenType: "session_token",
      userId: ownerId,
      sessionClaims: { userId: ownerId, email: ownerEmail },
    }), { [Symbol.for("@clerk/express.auth")]: true });
    req.dbUser = {
      id: ownerId,
      email: ownerEmail,
      firstName: "Invoice",
      lastName: "Owner",
      profileImageUrl: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    (req as any).ownerApprovalStatus = "approved";
    (req as any).log = { error() {}, warn() {}, info() {} };
    next();
  });
  registerCatalogRoutes(app);
  registerInvoiceRoutes(app, { authMiddleware: (_req, _res, next) => next() });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopServer(): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server!.close((error) => error ? reject(error) : resolve());
  });
  server = undefined;
}

function request(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
}

async function createParty(suffix: string) {
  const client = await pool.query(
    "INSERT INTO clients(name,contact_email) VALUES($1,$2) RETURNING id",
    [`${marker}-${suffix}`, `${marker}-${suffix}@example.invalid`],
  );
  const clientId = Number(client.rows[0].id);
  clientIds.push(clientId);
  const contact = await pool.query(
    "INSERT INTO crm_contacts(full_name,email,client_id) VALUES($1,$2,$3) RETURNING id",
    [`${marker}-${suffix}`, `${marker}-${suffix}@example.invalid`, clientId],
  );
  const contactId = Number(contact.rows[0].id);
  contactIds.push(contactId);
  return { clientId, contactId };
}

async function createInquiry(contactId: number, suffix: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO catalog_inquiries
       (id,stripe_product_id,offer_name,unit_amount_cents,requester_name,requester_email,message,crm_contact_id)
     VALUES($1,$2,$3,12500,$4,$5,'Please send an invoice for this offer.', $6)`,
    [id, `${marker}-${suffix}`, `${marker} service`, `${marker} requester`, `${marker}-${suffix}@example.invalid`, contactId],
  );
  inquiryIds.push(id);
  return id;
}

function invoiceBody(contactId: number, inquiryId: string, extra: Record<string, unknown> = {}) {
  return {
    contactId,
    originInquiryId: inquiryId,
    lineItems: [{ description: "Catalog service", quantity: 1, unitAmountCents: 12500 }],
    ...extra,
  };
}

async function postInvoice(contactId: number, inquiryId: string, extra: Record<string, unknown> = {}) {
  const response = await request("/api/invoices", {
    method: "POST",
    body: JSON.stringify(invoiceBody(contactId, inquiryId, extra)),
  });
  const body = await response.json() as any;
  if (response.status === 201) invoiceIds.push(Number(body.id));
  return { response, body };
}

before(async () => {
  previousAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = ownerEmail;
  await ensureInvoiceSchema();
  await applyStaffAccessMigration();
  await applyCatalogMigration();
  await applyCatalogInvoiceLinkMigration();
  await pool.query(
    "INSERT INTO auth_users(id,email,first_name,last_name) VALUES($1,$2,'Invoice','Owner') ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email",
    [ownerId, ownerEmail],
  );
  await pool.query(
    "INSERT INTO staff_access_profiles(user_id,role,approval_status,feature_permissions) VALUES($1,'administrator','approved',$2::jsonb) ON CONFLICT(user_id) DO UPDATE SET role=EXCLUDED.role,approval_status=EXCLUDED.approval_status,feature_permissions=EXCLUDED.feature_permissions",
    [ownerId, JSON.stringify({ invoices: true })],
  );
  await startServer();
});

after(async () => {
  await stopServer();
  for (const names of triggerNames) {
    await pool.query(`DROP TRIGGER IF EXISTS "${names.trigger}" ON catalog_inquiries`);
    await pool.query(`DROP FUNCTION IF EXISTS "${names.fn}"()`);
  }
  if (inquiryIds.length) {
    await pool.query("DELETE FROM catalog_inquiries WHERE id = ANY($1::uuid[])", [inquiryIds]);
  }
  if (invoiceIds.length) await pool.query("DELETE FROM invoices WHERE id = ANY($1::integer[])", [invoiceIds]);
  if (contactIds.length) await pool.query("DELETE FROM crm_contacts WHERE id = ANY($1::integer[])", [contactIds]);
  if (clientIds.length) await pool.query("DELETE FROM clients WHERE id = ANY($1::integer[])", [clientIds]);
  await pool.query("DELETE FROM staff_access_profiles WHERE user_id=$1", [ownerId]);
  await pool.query("DELETE FROM auth_users WHERE id=$1", [ownerId]);
  if (previousAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = previousAdminEmails;
  await pool.end();
});

test("catalog inquiry invoice linkage prevents duplicates and permits an audited correction", async () => {
  const { contactId } = await createParty("correction");
  const inquiryId = await createInquiry(contactId, "correction");
  const first = await postInvoice(contactId, inquiryId);
  assert.equal(first.response.status, 201, JSON.stringify(first.body));
  const originalInvoiceId = Number(first.body.id);
  const originalTotal = Number(first.body.total_cents);

  const duplicate = await postInvoice(contactId, inquiryId);
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.invoiceId, originalInvoiceId);

  const correction = await postInvoice(contactId, inquiryId, {
    originInquiryId: undefined,
    correctionOfInvoiceId: originalInvoiceId,
  });
  assert.equal(correction.response.status, 201, JSON.stringify(correction.body));
  const correctionInvoiceId = Number(correction.body.id);
  assert.notEqual(correctionInvoiceId, originalInvoiceId);

  const original = await pool.query("SELECT status,total_cents FROM invoices WHERE id=$1", [originalInvoiceId]);
  assert.deepEqual(original.rows[0], { status: "draft", total_cents: originalTotal });
  const current = await pool.query("SELECT invoice_id FROM catalog_inquiries WHERE id=$1", [inquiryId]);
  assert.equal(Number(current.rows[0].invoice_id), correctionInvoiceId);

  const correctionAudit = await pool.query(
    "SELECT details FROM invoice_audit_records WHERE invoice_id=$1 AND action='created'",
    [correctionInvoiceId],
  );
  assert.equal(correctionAudit.rows[0]?.details.originInquiryId, inquiryId);
  assert.equal(correctionAudit.rows[0]?.details.correctionOfInvoiceId, originalInvoiceId);
  assert.equal(JSON.stringify(correctionAudit.rows[0]?.details).includes("Please send an invoice"), false);

  const stale = await postInvoice(contactId, inquiryId, {
    originInquiryId: undefined,
    correctionOfInvoiceId: originalInvoiceId,
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.invoiceId, correctionInvoiceId);

  const queue = await request("/api/catalog/inquiries");
  assert.equal(queue.status, 200);
  const inquiry = ((await queue.json()) as any).inquiries.find((row: any) => row.id === inquiryId);
  assert.equal(inquiry.invoiceId, correctionInvoiceId);
  assert.equal(inquiry.invoiceNumber, correction.body.invoice_number);
  assert.equal(inquiry.invoiceStatus, "draft");

  const otherParty = await createParty("relink");
  const relink = await request(`/api/catalog/inquiries/${inquiryId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ contactId: otherParty.contactId }),
  });
  assert.equal(relink.status, 409);
  const linked = await pool.query("SELECT crm_contact_id,invoice_id FROM catalog_inquiries WHERE id=$1", [inquiryId]);
  assert.equal(Number(linked.rows[0].crm_contact_id), contactId);
  assert.equal(Number(linked.rows[0].invoice_id), correctionInvoiceId);

  await pool.query("DELETE FROM invoices WHERE id=$1", [correctionInvoiceId]);
  const deletedLink = await pool.query("SELECT invoice_id FROM catalog_inquiries WHERE id=$1", [inquiryId]);
  assert.equal(deletedLink.rows[0].invoice_id, null);
});

test("inquiry recipient identity is enforced and a stale correction with no current invoice is rejected", async () => {
  const linkedParty = await createParty("identity-linked");
  const unrelatedParty = await createParty("identity-unrelated");
  const inquiryId = await createInquiry(linkedParty.contactId, "identity");
  const mismatched = await postInvoice(unrelatedParty.contactId, inquiryId);
  assert.equal(mismatched.response.status, 400);
  assert.match(mismatched.body.error, /must match the CRM contact/i);

  const stale = await postInvoice(linkedParty.contactId, inquiryId, { correctionOfInvoiceId: 987654321 });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.invoiceId, null);
  const state = await pool.query("SELECT invoice_id FROM catalog_inquiries WHERE id=$1", [inquiryId]);
  assert.equal(state.rows[0].invoice_id, null);
  const invoices = await pool.query("SELECT id FROM invoices WHERE contact_id=$1", [linkedParty.contactId]);
  assert.equal(invoices.rowCount, 0);
});

test("concurrent requests create one invoice and the loser gets the committed invoice ID", async () => {
  const { contactId } = await createParty("concurrent");
  const inquiryId = await createInquiry(contactId, "concurrent");
  const [first, second] = await Promise.all([
    postInvoice(contactId, inquiryId),
    postInvoice(contactId, inquiryId),
  ]);
  const successes = [first, second].filter((result) => result.response.status === 201);
  const conflicts = [first, second].filter((result) => result.response.status === 409);
  assert.equal(successes.length, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].body.invoiceId, successes[0].body.id);

  const saved = await pool.query("SELECT invoice_id FROM catalog_inquiries WHERE id=$1", [inquiryId]);
  assert.equal(Number(saved.rows[0].invoice_id), Number(successes[0].body.id));
  const rows = await pool.query("SELECT id FROM invoices WHERE contact_id=$1", [contactId]);
  assert.equal(rows.rowCount, 1);
});

test("a failure after invoice insert rolls back invoice and inquiry linkage", async () => {
  const { contactId } = await createParty("rollback");
  const inquiryId = await createInquiry(contactId, "rollback");
  const suffix = `${process.pid}_${Date.now()}`;
  const triggerName = `test_catalog_invoice_rollback_${suffix}`;
  const functionName = `test_catalog_invoice_rollback_fn_${suffix}`;
  triggerNames.push({ trigger: triggerName, fn: functionName });
  await pool.query(`
    CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      IF NEW.id = '${inquiryId}'::uuid THEN RAISE EXCEPTION 'test rollback after invoice insert'; END IF;
      RETURN NEW;
    END
    $body$
  `);
  await pool.query(`
    CREATE TRIGGER "${triggerName}" BEFORE UPDATE OF invoice_id ON catalog_inquiries
    FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
  `);

  const failed = await postInvoice(contactId, inquiryId);
  assert.equal(failed.response.status, 400);
  const inquiry = await pool.query("SELECT invoice_id FROM catalog_inquiries WHERE id=$1", [inquiryId]);
  assert.equal(inquiry.rows[0].invoice_id, null);
  const invoices = await pool.query("SELECT id FROM invoices WHERE contact_id=$1", [contactId]);
  assert.equal(invoices.rowCount, 0);
});