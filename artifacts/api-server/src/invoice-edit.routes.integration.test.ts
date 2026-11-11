import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { createServer, type Server } from "node:http";
import { pool } from "./db";
import { ensureInvoiceSchema, registerInvoiceRoutes } from "./invoice-routes";

// Keep these tests hermetic: without connector credentials every Stripe call
// fails fast instead of reaching a real Stripe account.
delete process.env.REPLIT_CONNECTORS_HOSTNAME;

const marker = `invoice-edit-${process.pid}-${Date.now()}`;
const ownerId = `${marker}-owner`;
let server: Server;
let baseUrl: string;
let clientId: number;
let contactId: number;
let invoiceId: number;

const body = (overrides: Record<string, unknown> = {}) => ({
  recipient: { kind: "contact", contactId },
  dueDate: "2026-12-01",
  serviceDate: "2026-11-02",
  notes: "Thanks",
  taxRateBps: 700,
  discountCents: 0,
  lineItems: [{ description: "Screen repair", quantity: 1, unitAmountCents: 10_000 }],
  ...overrides,
});

async function put(payload: unknown) {
  const response = await fetch(`${baseUrl}/api/invoices/${invoiceId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, json: await response.json() as any };
}

async function row() {
  return (await pool.query("SELECT * FROM invoices WHERE id=$1", [invoiceId])).rows[0];
}

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

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).auth = Object.assign(() => ({
      tokenType: "session_token",
      userId: ownerId,
      sessionClaims: { userId: ownerId, email: `${marker}@example.invalid` },
    }), { [Symbol.for("@clerk/express.auth")]: true });
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

// Each test starts from the same sent invoice: $100.00 + 7% tax, no Stripe objects yet.
beforeEach(async () => {
  if (invoiceId) await pool.query("DELETE FROM invoices WHERE id=$1", [invoiceId]);
  invoiceId = Number((await pool.query(
    `INSERT INTO invoices(invoice_number,contact_id,client_id,status,client_name,client_email,due_date,service_date,notes,
                          subtotal_cents,tax_rate_bps,tax_cents,discount_cents,total_cents,sent_at)
     VALUES($1,$2,$3,'sent',$4,$5,'2026-12-01','2026-11-02','Thanks',10000,700,700,0,10700,now()) RETURNING id`,
    [`${marker}-${Date.now()}`, contactId, clientId, marker, `${marker}@example.invalid`],
  )).rows[0].id);
  await pool.query(
    "INSERT INTO invoice_line_items(invoice_id,position,description,quantity,unit_amount_cents,amount_cents) VALUES($1,0,'Screen repair',1,10000,10000)",
    [invoiceId],
  );
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

test("changing only the date of service on a sent invoice keeps it sent and leaves Stripe alone", async () => {
  await pool.query("UPDATE invoices SET stripe_invoice_id=$2 WHERE id=$1", [invoiceId, `in_${marker}`]);
  const result = await put(body({ serviceDate: "2026-10-30", notes: "Updated note" }));
  assert.equal(result.status, 200, JSON.stringify(result.json));
  const saved = await row();
  assert.equal(saved.status, "sent");
  assert.equal(saved.service_date.toISOString().slice(0, 10), "2026-10-30");
  assert.equal(saved.notes, "Updated note");
  assert.equal(saved.stripe_invoice_id, `in_${marker}`);
  assert.equal(saved.stripe_revision, 0);
});

test("changing sales tax on a sent invoice recalculates it after the discount and replaces the Stripe link", async () => {
  const result = await put(body({ taxRateBps: 650, discountCents: 2_000 }));
  assert.equal(result.status, 200, JSON.stringify(result.json));
  const saved = await row();
  assert.equal(saved.status, "sent");
  assert.equal(saved.tax_rate_bps, 650);
  assert.equal(saved.tax_cents, 520); // 6.5% of ($100 - $20)
  assert.equal(saved.total_cents, 8_520);
  assert.equal(saved.stripe_revision, 1);
  assert.equal(saved.stripe_invoice_id, null);
  // Stripe is unreachable here, so the rebuild is reported rather than failing the save.
  assert.match(result.json.stripeWarning, /could not be rebuilt/);
  const audit = await pool.query("SELECT details FROM invoice_audit_records WHERE invoice_id=$1 AND action='sent_invoice_revised'", [invoiceId]);
  assert.deepEqual(audit.rows[0].details.totalCents, { from: 10_700, to: 8_520 });
});

test("if the old Stripe invoice can't be cancelled, the edit is rolled back", async () => {
  await pool.query("UPDATE invoices SET stripe_invoice_id=$2 WHERE id=$1", [invoiceId, `in_${marker}`]);
  const result = await put(body({ taxRateBps: 0 }));
  assert.equal(result.status, 400);
  assert.match(result.json.error, /Replit environment variables|Stripe/i);
  const saved = await row();
  assert.equal(saved.tax_rate_bps, 700);
  assert.equal(saved.total_cents, 10_700);
  assert.equal(saved.stripe_invoice_id, `in_${marker}`);
  assert.equal(saved.stripe_revision, 0);
});

test("a sent invoice with a recorded payment or pending external payment can't be edited", async () => {
  await pool.query("UPDATE invoices SET external_payment_pending=true WHERE id=$1", [invoiceId]);
  const pending = await put(body({ taxRateBps: 0 }));
  assert.equal(pending.status, 409);
  assert.match(pending.json.error, /reconciliation is pending/);
  await pool.query("UPDATE invoices SET external_payment_pending=false WHERE id=$1", [invoiceId]);
  await pool.query(
    "INSERT INTO invoice_payments(invoice_id,provider,provider_payment_id,amount_cents,currency,verified,paid_at) VALUES($1,'manual',$2,10700,'USD',true,now())",
    [invoiceId, `${marker}-pay`],
  );
  const paid = await put(body({ taxRateBps: 0 }));
  assert.equal(paid.status, 409);
  assert.match(paid.json.error, /recorded payment/);
  await pool.query("DELETE FROM invoice_payments WHERE invoice_id=$1", [invoiceId]);
});

test("a paid invoice keeps its amounts but its date of service and notes can be corrected", async () => {
  await pool.query("UPDATE invoices SET status='paid', paid_at=now() WHERE id=$1", [invoiceId]);
  const result = await put(body({ serviceDate: "2026-10-15", notes: "Warranty 90 days", taxRateBps: 0, lineItems: [{ description: "Free", quantity: 1, unitAmountCents: 0 }] }));
  assert.equal(result.status, 200, JSON.stringify(result.json));
  const saved = await row();
  assert.equal(saved.status, "paid");
  assert.equal(saved.service_date.toISOString().slice(0, 10), "2026-10-15");
  assert.equal(saved.notes, "Warranty 90 days");
  assert.equal(saved.tax_rate_bps, 700);
  assert.equal(saved.total_cents, 10_700);
});

test("the customer's invoice page shows the date of service", async () => {
  const token = "a".repeat(43);
  const { hashPublicInvoiceToken } = await import("./invoice-core");
  await pool.query("UPDATE invoices SET public_token_hash=$2 WHERE id=$1", [invoiceId, hashPublicInvoiceToken(token)]);
  const response = await fetch(`${baseUrl}/api/public/invoices/${token}`);
  const json = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(json));
  assert.equal(String(json.serviceDate).slice(0, 10), "2026-11-02");
});
