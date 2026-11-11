import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { format } from "node:util";
import Stripe from "stripe";
import { pool } from "../src/db.ts";
import {
  ensureInvoiceSchema,
  ensureStripeNativeInvoice,
  handleInvoiceStripeWebhookEvent,
  recordStripeDocumentFailure,
  resolveStripeDocumentFailure,
  StripeDocumentVerificationError,
  verifyCurrentStripeInvoiceDocuments,
  verifyStripeInvoiceDocuments,
} from "../src/invoice-routes.ts";
import {
  getStripeWebhookSecret,
  getUncachableStripeClient,
} from "../src/stripeClient.ts";
import { WebhookHandlers } from "../src/webhookHandlers.ts";

const documentRetryTestOnly = process.env.RUN_STRIPE_DOCUMENT_RETRY_TEST === "1";
const documentAuditConcurrencyTestOnly =
  process.env.RUN_STRIPE_DOCUMENT_AUDIT_CONCURRENCY_TEST === "1";
const documentAuditOrderingTestOnly =
  process.env.RUN_STRIPE_DOCUMENT_AUDIT_ORDERING_TEST === "1";

if (
  process.env.RUN_STRIPE_SANDBOX_TEST !== "1"
  && !documentRetryTestOnly
  && !documentAuditConcurrencyTestOnly
  && !documentAuditOrderingTestOnly
) {
  throw new Error(
    "Refusing to run without a supported Stripe invoice test mode",
  );
}

if (!documentRetryTestOnly && !process.env.DATABASE_URL) {
  const mode = documentAuditConcurrencyTestOnly
    ? "Stripe document audit concurrency test"
    : documentAuditOrderingTestOnly
      ? "Stripe document audit ordering test"
      : "Stripe sandbox exercise";
  throw new Error(
    `${mode} requires DATABASE_URL; configure the validation database before running this command`,
  );
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const invoiceNumber = `SANDBOX-${suffix}`;
const customerEmail = `stripe-sandbox-${suffix}@example.com`;
const totalCents = 1_234;
const lineDescription = "Stripe native invoice sandbox verification";

let stripe: Stripe | undefined;
let stripeCustomerId: string | undefined;
let crmClientId: number | undefined;
let crmContactId: number | undefined;
let crmInvoiceId: number | undefined;
let stripeInvoiceId: string | undefined;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fixtureDescription(): string {
  return `CRM invoice ${invoiceNumber} (id ${crmInvoiceId ?? "unknown"}) and Stripe invoice ${stripeInvoiceId ?? "unknown"}`;
}

function requireStripeUrl(value: string | null | undefined, label: string): string {
  if (!value || !/^https:\/\/.+/.test(value)) {
    throw new Error(`${label} URL is missing or not HTTPS for ${fixtureDescription()}`);
  }
  return value;
}

async function verifyStripeDocumentUrl(
  url: string,
  label: string,
  expectedContentType?: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch {
    throw new Error(`${label} URL could not be fetched for ${fixtureDescription()}`);
  }

  try {
    if (!response.ok) {
      throw new Error(
        `${label} URL returned HTTP ${response.status} for ${fixtureDescription()}`,
      );
    }

    if (expectedContentType) {
      const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (contentType !== expectedContentType) {
        throw new Error(
          `${label} URL returned content type ${contentType ?? "missing"} for ${fixtureDescription()}`,
        );
      }
    }
  } finally {
    await response.body?.cancel();
  }
}

async function verifyBoundedDocumentRetries(): Promise<void> {
  const calls: string[] = [];
  const responses = new Map<string, Response[]>([
    [
      "https://stripe.test/hosted",
      [
        new Response(null, { status: 503 }),
        new Response("<html>ready</html>", { status: 200, headers: { "content-type": "text/html" } }),
      ],
    ],
    [
      "https://stripe.test/invoice.pdf",
      [
        new Response(null, { status: 429 }),
        new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
      ],
    ],
  ]);
  await verifyStripeInvoiceDocuments(
    {
      crmInvoiceId: 41,
      stripeInvoiceId: "in_retry_fixture",
      hostedInvoiceUrl: "https://stripe.test/hosted",
      invoicePdfUrl: "https://stripe.test/invoice.pdf",
    },
    {
      fetchDocument: async (input) => {
        const url = String(input);
        calls.push(url);
        const response = responses.get(url)?.shift();
        if (!response) throw new Error("Unexpected document fetch");
        return response;
      },
      pause: async () => undefined,
    },
  );
  assert.deepEqual(calls, [
    "https://stripe.test/hosted",
    "https://stripe.test/hosted",
    "https://stripe.test/invoice.pdf",
    "https://stripe.test/invoice.pdf",
  ]);

  async function assertSafeFailure(
    fixture: {
      crmInvoiceId: number;
      stripeInvoiceId: string;
      hostedInvoiceUrl: string;
      invoicePdfUrl: string;
    },
    fetchDocument: typeof fetch,
  ): Promise<Error> {
    let error: Error | undefined;
    try {
      await verifyStripeInvoiceDocuments(fixture, {
        fetchDocument,
        pause: async () => undefined,
      });
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error(String(cause));
    }
    assert.ok(error, "document verification should fail");
    assert.ok(error instanceof StripeDocumentVerificationError);
    const loggedCause = format("Stripe sandbox exercise failed:", error);
    for (const output of [error.message, loggedCause]) {
      assert.match(output, new RegExp(`CRM invoice ${fixture.crmInvoiceId}`));
      assert.match(output, new RegExp(`Stripe invoice ${fixture.stripeInvoiceId}`));
      assert.doesNotMatch(output, new RegExp(fixture.hostedInvoiceUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(output, new RegExp(fixture.invoicePdfUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    return error;
  }

  const hostedFailureFixture = {
    crmInvoiceId: 42,
    stripeInvoiceId: "in_hosted_failure_fixture",
    hostedInvoiceUrl: "https://stripe.test/hosted/signed-secret",
    invoicePdfUrl: "https://stripe.test/pdf/unused-secret.pdf",
  };
  const permanentCalls: string[] = [];
  await assertSafeFailure(hostedFailureFixture, async (input) => {
    permanentCalls.push(String(input));
    return new Response(null, { status: 404 });
  });
  assert.equal(permanentCalls.length, 1, "permanent hosted-page failures must not be retried");
  const permanentError = await assertSafeFailure(hostedFailureFixture, async () => new Response(null, { status: 404 }));
  assert.deepEqual(
    {
      crmInvoiceId: (permanentError as StripeDocumentVerificationError).crmInvoiceId,
      stripeInvoiceId: (permanentError as StripeDocumentVerificationError).stripeInvoiceId,
      documentKind: (permanentError as StripeDocumentVerificationError).documentKind,
      statusCategory: (permanentError as StripeDocumentVerificationError).statusCategory,
      attemptCount: (permanentError as StripeDocumentVerificationError).attemptCount,
    },
    {
      crmInvoiceId: hostedFailureFixture.crmInvoiceId,
      stripeInvoiceId: hostedFailureFixture.stripeInvoiceId,
      documentKind: "hosted_invoice",
      statusCategory: "permanent",
      attemptCount: 1,
    },
  );

  const pdfFailureFixture = {
    crmInvoiceId: 43,
    stripeInvoiceId: "in_pdf_failure_fixture",
    hostedInvoiceUrl: "https://stripe.test/hosted/ready-secret",
    invoicePdfUrl: "https://stripe.test/pdf/signed-secret.pdf",
  };
  const pdfFailureCalls: string[] = [];
  await assertSafeFailure(pdfFailureFixture, async (input) => {
    const url = String(input);
    pdfFailureCalls.push(url);
    if (url === pdfFailureFixture.hostedInvoiceUrl) {
      return new Response("<html>ready</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    throw new Error(`network wrapper failed while fetching ${url}`);
  });
  assert.deepEqual(pdfFailureCalls, [
    pdfFailureFixture.hostedInvoiceUrl,
    pdfFailureFixture.invoicePdfUrl,
    pdfFailureFixture.invoicePdfUrl,
    pdfFailureFixture.invoicePdfUrl,
  ]);

  let retrieved = 0;
  let documentCalls = 0;
  await assert.rejects(
    verifyCurrentStripeInvoiceDocuments(
      { id: 44, stripe_invoice_id: "in_resend_failure_fixture" },
      {
        retrieveInvoice: async (stripeInvoiceId) => {
          retrieved++;
          return {
            id: stripeInvoiceId,
            hosted_invoice_url: "https://stripe.test/resend/broken",
            invoice_pdf: "https://stripe.test/resend/invoice.pdf",
          };
        },
        fetchDocument: async () => {
          documentCalls++;
          return new Response(null, { status: 404 });
        },
        pause: async () => undefined,
      },
    ),
    /Stripe hosted invoice unavailable/,
  );
  assert.equal(retrieved, 1, "resend verification must retrieve the current Stripe invoice");
  assert.equal(documentCalls, 1, "permanent resend document failures must not be retried");
}

async function verifyConcurrentDocumentFailureAudit(): Promise<void> {
  await ensureInvoiceSchema();
  await createCrmFixture();
  assert.ok(crmInvoiceId, "CRM fixture must have an invoice id");

  const hostedPageUrl = "https://stripe.test/hosted/signed-secret";
  const invoicePdfUrl = "https://stripe.test/pdf/signed-secret.pdf";
  const failures = Array.from(
    { length: 8 },
    (_, index) =>
      new StripeDocumentVerificationError(
        {
          crmInvoiceId: crmInvoiceId!,
          stripeInvoiceId: `in_concurrent_document_failure_${suffix}`,
          hostedInvoiceUrl: hostedPageUrl,
          invoicePdfUrl,
        },
        index % 2 === 0 ? "hosted invoice" : "invoice PDF",
        "document URL is missing or invalid",
        "permanent",
        1,
      ),
  );

  await Promise.all(failures.map((failure) => recordStripeDocumentFailure(failure)));

  const activeResult = await pool.query(
    `SELECT id, details
       FROM invoice_audit_records
      WHERE invoice_id = $1
        AND action = 'stripe_document_failed'
        AND COALESCE(details->>'resolutionStatus', 'active') = 'active'`,
    [crmInvoiceId],
  );
  assert.equal(activeResult.rowCount, 1, "concurrent failures must retain one active incident");
  const incidentId = activeResult.rows[0].id;
  const serializedDetails = JSON.stringify(activeResult.rows[0].details);
  assert.doesNotMatch(serializedDetails, /https?:\/\//);
  assert.doesNotMatch(serializedDetails, new RegExp(hostedPageUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(serializedDetails, new RegExp(invoicePdfUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await resolveStripeDocumentFailure(pool, crmInvoiceId);
  const resolvedResult = await pool.query(
    `SELECT id, details
       FROM invoice_audit_records
      WHERE invoice_id = $1 AND action = 'stripe_document_failed'`,
    [crmInvoiceId],
  );
  assert.equal(resolvedResult.rowCount, 1, "successful retry must not create another incident");
  assert.equal(resolvedResult.rows[0].id, incidentId, "successful retry must resolve the retained incident");
  assert.equal(resolvedResult.rows[0].details.resolutionStatus, "resolved");
  assert.equal(typeof resolvedResult.rows[0].details.resolvedAt, "string");
}

async function verifyDocumentFailureAuditOrdering(): Promise<void> {
  await ensureInvoiceSchema();
  await createCrmFixture();
  assert.ok(crmInvoiceId, "CRM fixture must have an invoice id");

  const failedAt = new Date("2026-09-16T12:00:00.000Z");
  const verifiedAt = new Date(failedAt.getTime() + 1_000);
  const delayedFailure = new StripeDocumentVerificationError(
    {
      crmInvoiceId,
      stripeInvoiceId: `in_delayed_document_failure_${suffix}`,
      hostedInvoiceUrl: "https://stripe.test/hosted/signed-secret",
      invoicePdfUrl: "https://stripe.test/pdf/signed-secret.pdf",
    },
    "hosted invoice",
    "document URL is missing or invalid",
    "permanent",
    1,
  );

  await recordStripeDocumentFailure(delayedFailure, failedAt);
  await Promise.all([
    resolveStripeDocumentFailure(pool, crmInvoiceId, verifiedAt),
    (async () => {
      await sleep(25);
      await recordStripeDocumentFailure(delayedFailure, failedAt);
    })(),
  ]);

  const result = await pool.query(
    `SELECT id, actor, action, details
       FROM invoice_audit_records
      WHERE invoice_id = $1 AND action = 'stripe_document_failed'`,
    [crmInvoiceId],
  );
  assert.equal(result.rowCount, 1, "the outcome race must retain exactly one incident");
  assert.equal(result.rows[0].actor, "stripe");
  assert.equal(result.rows[0].details.resolutionStatus, "resolved");
  assert.equal(new Date(result.rows[0].details.resolvedAt).getTime(), verifiedAt.getTime());
  const serializedDetails = JSON.stringify(result.rows[0].details);
  assert.doesNotMatch(serializedDetails, /https?:\/\//);
  assert.deepEqual(
    Object.keys(result.rows[0].details).sort(),
    [
      "attemptCount",
      "crmInvoiceId",
      "documentKind",
      "lastSeenAt",
      "resolutionStatus",
      "resolvedAt",
      "statusCategory",
      "stripeInvoiceId",
    ].sort(),
    "the retained incident must contain only sanitized metadata",
  );
}

async function waitForPaidEvent(
  client: Stripe,
  invoiceId: string,
): Promise<Stripe.Event> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const events = await client.events.list({
      limit: 100,
      types: ["invoice.paid"],
    });
    const match = events.data.find(
      (event) => (event.data.object as Stripe.Invoice).id === invoiceId,
    );
    if (match) return match;
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for invoice.paid for ${invoiceId}`);
}

async function createCrmFixture(): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const account = (
      await client.query(
        `INSERT INTO clients (name, contact_email, contact_phone)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [`Stripe sandbox account ${suffix}`, customerEmail, null],
      )
    ).rows[0];
    crmClientId = Number(account.id);

    const contact = (
      await client.query(
        `INSERT INTO crm_contacts (full_name, email, mobile_phone, company, client_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [`Stripe Sandbox Contact ${suffix}`, customerEmail, null, null, crmClientId],
      )
    ).rows[0];
    crmContactId = Number(contact.id);

    const invoice = (
      await client.query(
        `INSERT INTO invoices (
           invoice_number, client_id, contact_id, status, client_name, client_email,
           subtotal_cents, tax_rate_bps, tax_cents, discount_cents, total_cents
         ) VALUES ($1, $2, $3, 'draft', $4, $5, $6, 0, 0, 0, $6)
         RETURNING *`,
        [
          invoiceNumber,
          crmClientId,
          crmContactId,
          `Stripe sandbox account ${suffix}`,
          customerEmail,
          totalCents,
        ],
      )
    ).rows[0];
    crmInvoiceId = Number(invoice.id);

    await client.query(
      `INSERT INTO invoice_line_items
         (invoice_id, position, description, quantity, unit_amount_cents, amount_cents)
       VALUES ($1, 0, $2, 1, $3, $3)`,
      [crmInvoiceId, lineDescription, totalCents],
    );
    await client.query("COMMIT");
    return invoice;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function markFixtureSent(): Promise<Record<string, unknown>> {
  const result = await pool.query(
    `UPDATE invoices
        SET status = 'sent', sent_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'draft'
      RETURNING *`,
    [crmInvoiceId],
  );
  assert.equal(result.rowCount, 1, "CRM fixture should transition from draft to sent");
  return result.rows[0];
}

async function deliverSignedEvent(
  event: Stripe.Event,
  webhookSecret: string,
): Promise<void> {
  const payload = JSON.stringify(event);
  const signature = stripe!.webhooks.generateTestHeaderString({
    payload,
    secret: webhookSecret,
  });
  const rawPayload = Buffer.from(payload, "utf8");
  await WebhookHandlers.processWebhook(rawPayload, signature);
  await handleInvoiceStripeWebhookEvent(event);
}

async function cleanup(): Promise<void> {
  const cleanupErrors: unknown[] = [];

  if (crmInvoiceId || crmContactId || crmClientId) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (crmInvoiceId) {
        await client.query("DELETE FROM invoice_audit_records WHERE invoice_id = $1", [
          crmInvoiceId,
        ]);
        await client.query("DELETE FROM invoice_line_items WHERE invoice_id = $1", [
          crmInvoiceId,
        ]);
        await client.query("DELETE FROM invoice_payments WHERE invoice_id = $1", [
          crmInvoiceId,
        ]);
        await client.query("DELETE FROM invoices WHERE id = $1", [crmInvoiceId]);
      }
      if (crmContactId) {
        await client.query("DELETE FROM crm_contacts WHERE id = $1", [crmContactId]);
      }
      if (crmClientId) {
        await client.query("DELETE FROM clients WHERE id = $1", [crmClientId]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch((rollbackError) => {
        cleanupErrors.push(rollbackError);
      });
      cleanupErrors.push(error);
    } finally {
      client.release();
    }
  }

  if (stripe && stripeCustomerId) {
    try {
      await stripe.customers.del(stripeCustomerId);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Stripe sandbox fixture cleanup failed");
  }
}

async function main(): Promise<void> {
  await verifyBoundedDocumentRetries();
  stripe = await getUncachableStripeClient();
  const balance = await stripe.balance.retrieve();
  assert.equal(
    balance.livemode,
    false,
    "The sandbox exercise only runs against a Stripe test-mode account",
  );
  const webhookSecret = await getStripeWebhookSecret();

  await ensureInvoiceSchema();
  const fixture = await createCrmFixture();
  const nativeInvoice = await ensureStripeNativeInvoice(fixture);
  stripeInvoiceId = nativeInvoice.id;
  stripeCustomerId =
    typeof nativeInvoice.customer === "string"
      ? nativeInvoice.customer
      : nativeInvoice.customer.id;

  assert.equal(nativeInvoice.status, "open");
  assert.equal(nativeInvoice.total, totalCents);
  assert.equal(nativeInvoice.currency, "usd");
  const hostedInvoiceUrl = requireStripeUrl(
    nativeInvoice.hosted_invoice_url,
    "Stripe hosted invoice",
  );
  const invoicePdfUrl = requireStripeUrl(
    nativeInvoice.invoice_pdf,
    "Stripe invoice PDF",
  );
  await verifyStripeDocumentUrl(hostedInvoiceUrl, "Stripe hosted invoice");
  await verifyStripeDocumentUrl(invoicePdfUrl, "Stripe invoice PDF", "application/pdf");

  await markFixtureSent();
  const paidInvoice = await stripe.invoices.pay(stripeInvoiceId, {
    paid_out_of_band: true,
  });
  assert.equal(paidInvoice.status, "paid");
  assert.equal(paidInvoice.amount_paid, totalCents);

  const event = await waitForPaidEvent(stripe, stripeInvoiceId);
  assert.equal(event.type, "invoice.paid");
  assert.equal(
    (event.data.object as Stripe.Invoice).metadata?.crmInvoiceId,
    String(crmInvoiceId),
  );

  await deliverSignedEvent(event, webhookSecret);
  await deliverSignedEvent(event, webhookSecret);

  const result = await pool.query(
    `SELECT i.status, i.stripe_invoice_id, count(p.id)::int AS payment_count,
            max(p.provider_payment_id) AS provider_payment_id
       FROM invoices i
       LEFT JOIN invoice_payments p ON p.invoice_id = i.id
      WHERE i.id = $1
      GROUP BY i.id`,
    [crmInvoiceId],
  );
  assert.equal(result.rows[0]?.status, "paid");
  assert.equal(result.rows[0]?.stripe_invoice_id, stripeInvoiceId);
  assert.equal(result.rows[0]?.payment_count, 1);
  assert.equal(result.rows[0]?.provider_payment_id, stripeInvoiceId);

  console.log(
    `Stripe sandbox invoice verified: ${stripeInvoiceId} reconciled to CRM invoice ${crmInvoiceId}; duplicate delivery kept one payment record.`,
  );
}

async function run(): Promise<void> {
  try {
    if (documentRetryTestOnly) {
      await verifyBoundedDocumentRetries();
      console.log("Stripe document retry behavior verified.");
    } else if (documentAuditConcurrencyTestOnly) {
      await verifyConcurrentDocumentFailureAudit();
      console.log("Concurrent Stripe document failure audit verified.");
    } else if (documentAuditOrderingTestOnly) {
      await verifyDocumentFailureAuditOrdering();
      console.log("Stripe document failure audit ordering verified.");
    } else {
      await main();
    }
  } finally {
    if (!documentRetryTestOnly) await cleanup();
    await pool.end();
  }
}

run().catch((error) => {
  console.error("Stripe sandbox exercise failed:", error);
  process.exitCode = 1;
});