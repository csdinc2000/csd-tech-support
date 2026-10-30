import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import { createServer, type Server } from "node:http";
import { pool } from "./db";
import { ensureInvoiceSchema, registerInvoiceRoutes } from "./invoice-routes";

const marker = `external-void-${process.pid}-${Date.now()}`;
let server: Server;
let baseUrl: string;
let ownerId = `${marker}-owner`;
let clientId: number;
let contactId: number;
let invoiceId: number;

before(async () => {
  await ensureInvoiceSchema();
  await pool.query("INSERT INTO auth_users(id,email,first_name,last_name) VALUES($1,$2,'Invoice','Owner')", [ownerId, `${marker}@example.invalid`]);
  await pool.query(
    "INSERT INTO staff_access_profiles(user_id,role,approval_status,feature_permissions) VALUES($1,'administrator','approved',$2::jsonb)",
    [ownerId, JSON.stringify({ invoices: true })],
  );
  clientId = Number((await pool.query("INSERT INTO clients(name,contact_email) VALUES($1,$2) RETURNING id", [marker, `${marker}@example.invalid`])).rows[0].id);
  contactId = Number((await pool.query(
    "INSERT INTO crm_contacts(full_name,email,client_id) VALUES($1,$2,$3) RETURNING id",
    [marker, `${marker}@example.invalid`, clientId],
  )).rows[0].id);
  invoiceId = Number((await pool.query(
    `INSERT INTO invoices(invoice_number,contact_id,client_id,status,client_name,subtotal_cents,tax_cents,total_cents)
     VALUES($1,$2,$3,'sent',$4,1000,0,1000) RETURNING id`,
    [marker, contactId, clientId, marker],
  )).rows[0].id);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.dbUser = {
      id: ownerId, email: `${marker}@example.invalid`, firstName: "Invoice", lastName: "Owner",
      profileImageUrl: null, stripeCustomerId: null, stripeSubscriptionId: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    (req as any).log = { warn() {}, error() {}, info() {} };
    next();
  });
  registerInvoiceRoutes(app, { authMiddleware: (_req, _res, next) => next() });
  server = createServer(app);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  if (invoiceId) await pool.query("DELETE FROM invoices WHERE id=$1", [invoiceId]);
  if (contactId) await pool.query("DELETE FROM crm_contacts WHERE id=$1", [contactId]);
  if (clientId) await pool.query("DELETE FROM clients WHERE id=$1", [clientId]);
  await pool.query("DELETE FROM staff_access_profiles WHERE user_id=$1", [ownerId]);
  await pool.query("DELETE FROM auth_users WHERE id=$1", [ownerId]);
});

test("void waits for an external claim then refuses both the claim-to-close gap and unresolved retries", async () => {
  const claimant = await pool.connect();
  try {
    await claimant.query("BEGIN");
    await claimant.query("SELECT id FROM invoices WHERE id=$1 FOR UPDATE", [invoiceId]);
    const request = fetch(`${baseUrl}/api/invoices/${invoiceId}/void`, { method: "POST" });
    // The void request must wait for the claimant's row lock. Claim and commit
    // while it is waiting, as in the gap before the Stripe close request.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await claimant.query(
      "UPDATE invoices SET external_payment_pending=true, external_payment_provider='paypal', external_payment_reference=$2 WHERE id=$1",
      [invoiceId, `${marker}-payment`],
    );
    await claimant.query("COMMIT");
    const response = await request;
    assert.equal(response.status, 409, await response.text());
    assert.match((await pool.query("SELECT status FROM invoices WHERE id=$1", [invoiceId])).rows[0].status, /^sent$/);

    const retry = await fetch(`${baseUrl}/api/invoices/${invoiceId}/void`, { method: "POST" });
    assert.equal(retry.status, 409, await retry.text());
    const state = (await pool.query("SELECT status,external_payment_pending FROM invoices WHERE id=$1", [invoiceId])).rows[0];
    assert.equal(state.status, "sent");
    assert.equal(state.external_payment_pending, true);
  } finally {
    await claimant.query("ROLLBACK");
    claimant.release();
  }
});