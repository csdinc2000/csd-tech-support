import assert from "node:assert/strict";
import test from "node:test";
import {
  hasPdfSignature,
  isInvoicePaymentWebhookType,
  isValidStripeNativeInvoicePayment,
  sanitizeStripeReconciliationError,
} from "./invoice-core";
import { canRecordStripeSettlement, closeStripeForExternalPayment, verifyStripeInvoiceDocuments } from "./invoice-routes";

const documentCheck = {
  crmInvoiceId: 25,
  stripeInvoiceId: "in_test",
  hostedInvoiceUrl: "https://example.test/hosted",
  invoicePdfUrl: "https://example.test/pdf",
};

test("Stripe PDF served as octet-stream is accepted only when it has a PDF signature", async () => {
  const fetchDocument = (async (url: string) => new Response(
    url.endsWith("/pdf") ? "%PDF-1.7\ninvoice" : "<html>hosted invoice</html>",
    { headers: { "content-type": url.endsWith("/pdf") ? "application/octet-stream" : "text/html" } },
  )) as typeof fetch;
  await verifyStripeInvoiceDocuments(documentCheck, { fetchDocument, pause: async () => {} });

  const notPdf = (async (url: string) => new Response(
    "<html>not a PDF</html>",
    { headers: { "content-type": url.endsWith("/pdf") ? "application/octet-stream" : "text/html" } },
  )) as typeof fetch;
  await assert.rejects(
    verifyStripeInvoiceDocuments(documentCheck, { fetchDocument: notPdf, pause: async () => {} }),
    /binary response does not contain a PDF/,
  );
});

test("PDF signature detection handles fragmented and truncated streams", async () => {
  const fragmented = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("%P"));
      controller.enqueue(new TextEncoder().encode("DF-1.7"));
      controller.close();
    },
  });
  assert.equal(await hasPdfSignature(fragmented), true);
  assert.equal(await hasPdfSignature(new Response("%PD").body), false);
  assert.equal(await hasPdfSignature(null), false);
});

test("native Stripe invoice payment events are recognized", () => {
  assert.equal(isInvoicePaymentWebhookType("invoice.paid"), true);
  assert.equal(isInvoicePaymentWebhookType("invoice.payment_succeeded"), true);
  assert.equal(isInvoicePaymentWebhookType("invoice.payment_failed"), false);
});

test("native Stripe invoice payment must match the immutable CRM binding", () => {
  const local = { id: 42, total_cents: 12_345, stripe_invoice_id: "in_123" };
  const paid = {
    id: "in_123",
    status: "paid",
    paid: true,
    amount_paid: 12_345,
    currency: "usd",
    metadata: { crmInvoiceId: "42" },
  };

  assert.equal(isValidStripeNativeInvoicePayment(paid, local), true);
  assert.equal(isValidStripeNativeInvoicePayment({ ...paid, paid: undefined }, local), true);
  assert.equal(isValidStripeNativeInvoicePayment({ ...paid, amount_paid: 12_344 }, local), false);
  assert.equal(isValidStripeNativeInvoicePayment({ ...paid, id: "in_other" }, local), false);
  assert.equal(
    isValidStripeNativeInvoicePayment({ ...paid, metadata: { crmInvoiceId: "41" } }, local),
    false,
  );
});

test("external payment closes an open Stripe invoice out of band before local settlement", async () => {
  let status = "open";
  let paidOutOfBand = false;
  const stripe = {
    invoices: {
      retrieve: async () => ({ status }),
      pay: async (_id: string, params: { paid_out_of_band: boolean }, options: { idempotencyKey: string }) => {
        assert.match(options.idempotencyKey, /^crm-external-payment-42-/);
        paidOutOfBand = params.paid_out_of_band;
        status = "paid";
        return { id: "in_123", status };
      },
    },
  } as any;
  await closeStripeForExternalPayment(stripe, "in_123", 42, "paypal", "paypal-confirmed", false);
  assert.equal(status, "paid");
  assert.equal(paidOutOfBand, true);
});

test("Stripe charge racing the out-of-band close cannot be recorded as an external settlement", async () => {
  let status = "open";
  const stripe = {
    invoices: {
      retrieve: async () => ({ status }),
      pay: async () => {
        status = "paid"; // Card payment won the race at Stripe.
        throw new Error("Stripe invoice already paid");
      },
    },
  } as any;
  await assert.rejects(closeStripeForExternalPayment(stripe, "in_123", 42, "paypal", "ref", false), /already paid/);
  await assert.rejects(closeStripeForExternalPayment(stripe, "in_123", 42, "paypal", "ref", true), /already paid/);
});

test("a manual payment cannot settle after Stripe already paid, or after Stripe fails to close", async () => {
  let status = "paid";
  const stripe = {
    invoices: {
      retrieve: async () => ({ status }),
      pay: async () => { throw new Error("Stripe unavailable"); },
    },
  } as any;
  await assert.rejects(closeStripeForExternalPayment(stripe, "in_123", 42, "manual", "check-123", false), /already paid/);
  status = "open";
  await assert.rejects(closeStripeForExternalPayment(stripe, "in_123", 42, "manual", "check-123", false), /Stripe unavailable/);
});

test("a lost Stripe response can only be retried with the same out-of-band idempotency key", async () => {
  let status = "open";
  const accepted = new Set<string>();
  const stripe = {
    invoices: {
      retrieve: async () => ({ status }),
      pay: async (_id: string, params: { paid_out_of_band: boolean }, options: { idempotencyKey: string }) => {
        if (accepted.has(options.idempotencyKey)) return { id: "in_123", status: "paid" };
        if (status !== "open") throw new Error("Stripe invoice already paid");
        assert.equal(params.paid_out_of_band, true);
        accepted.add(options.idempotencyKey);
        status = "paid";
        throw new Error("Response lost after Stripe closed the invoice");
      },
    },
  } as any;
  await assert.rejects(closeStripeForExternalPayment(stripe, "in_123", 42, "paypal", "ref", false), /Response lost/);
  await closeStripeForExternalPayment(stripe, "in_123", 42, "paypal", "ref", true);
  await assert.rejects(closeStripeForExternalPayment(stripe, "in_123", 42, "paypal", "other-ref", true), /already paid/);
});

test("a webhook with a stale paid snapshot cannot insert a second Stripe receipt after the external claim or settlement", () => {
  assert.equal(canRecordStripeSettlement({ status: "sent", external_payment_pending: true }), false);
  assert.equal(canRecordStripeSettlement({ status: "paid", external_payment_pending: false }), false);
  assert.equal(canRecordStripeSettlement({ status: "sent", external_payment_pending: false }), true);
});

test("Stripe reconciliation incident errors are bounded and do not retain credentials", () => {
  const sanitized = sanitizeStripeReconciliationError(
    new Error(
      "Stripe failed with sk_live_should_not_persist and Bearer secret-token&password=keep-out",
    ),
  );

  assert.equal(sanitized.includes("sk_live_should_not_persist"), false);
  assert.equal(sanitized.includes("secret-token"), false);
  assert.equal(sanitized.includes("keep-out"), false);
  assert.ok(sanitized.length <= 500);
});