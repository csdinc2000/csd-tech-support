import test from "node:test";
import assert from "node:assert/strict";
import {
  assertDraftMutable,
  assertInvoiceStatusTransition,
  calculateInvoiceTotals,
  generatePublicInvoiceToken,
  getCanonicalInvoiceAppBaseUrl,
  hashPublicInvoiceToken,
  normalizePayPalCheckoutUrl,
  isInvoicePaymentWebhookType,
  isValidInvoiceCheckoutPayment,
  verifyPublicInvoiceToken,
} from "../invoice-core";

test("invoice totals are calculated from validated integer line items", () => {
  const result = calculateInvoiceTotals(
    [
      { description: "Labor", quantity: 2, unitAmountCents: 12500 },
      { description: "Part", quantity: 1, unitAmountCents: 4999 },
    ],
    700,
    1000,
  );
  assert.deepEqual(
    { subtotal: result.subtotalCents, tax: result.taxCents, discount: result.discountCents, total: result.totalCents },
    { subtotal: 29999, tax: 2100, discount: 1000, total: 31099 },
  );
  assert.throws(() => calculateInvoiceTotals([], 0, 0));
  assert.throws(() => calculateInvoiceTotals([{ description: "x", quantity: 1.5, unitAmountCents: 1 }]));
  assert.throws(() => calculateInvoiceTotals([{ description: "x", quantity: 1, unitAmountCents: 1 }], 0, 2));
});

test("canonical invoice URL accepts only a clean HTTPS origin", () => {
  assert.equal(getCanonicalInvoiceAppBaseUrl("https://billing.example.com/"), "https://billing.example.com");
  for (const value of ["http://billing.example.com", "https://user@billing.example.com", "https://billing.example.com/x", "https://billing.example.com/?x=1"]) {
    assert.throws(() => getCanonicalInvoiceAppBaseUrl(value));
  }
});

test("only invoice payment completion webhook types qualify", () => {
  assert.equal(isInvoicePaymentWebhookType("checkout.session.completed"), true);
  assert.equal(isInvoicePaymentWebhookType("checkout.session.async_payment_succeeded"), true);
  assert.equal(isInvoicePaymentWebhookType("payment_intent.succeeded"), false);
});

test("Stripe checkout finality validation requires the exact immutable payment", () => {
  const invoice = { id: 42, total_cents: 1234, stripe_checkout_session_id: "cs_123" };
  const valid = { id: "cs_123", mode: "payment", status: "complete", payment_status: "paid", amount_total: 1234, currency: "USD", metadata: { invoiceId: "42" } };
  assert.equal(isValidInvoiceCheckoutPayment(valid, invoice), true);
  assert.equal(isValidInvoiceCheckoutPayment({ ...valid, amount_total: 1235 }, invoice), false);
  assert.equal(isValidInvoiceCheckoutPayment({ ...valid, currency: "eur" }, invoice), false);
  assert.equal(isValidInvoiceCheckoutPayment({ ...valid, mode: "subscription" }, invoice), false);
  assert.equal(isValidInvoiceCheckoutPayment({ ...valid, id: "cs_other" }, invoice), false);
  assert.equal(isValidInvoiceCheckoutPayment({ ...valid, metadata: { invoiceId: "43" } }, invoice), false);
});

test("PayPal URL validation permits only approved HTTPS hosts", () => {
  assert.equal(normalizePayPalCheckoutUrl("https://paypal.me/acme/10"), "https://paypal.me/acme/10");
  assert.equal(normalizePayPalCheckoutUrl(""), null);
  assert.throws(() => normalizePayPalCheckoutUrl("http://paypal.com/pay"));
  assert.throws(() => normalizePayPalCheckoutUrl("https://paypal.com.evil.test/pay"));
  assert.throws(() => normalizePayPalCheckoutUrl("https://user:pass@paypal.com/pay"));
});

test("draft mutation and status transitions are restrictive", () => {
  assert.doesNotThrow(() => assertDraftMutable("draft"));
  assert.throws(() => assertDraftMutable("sent"));
  assert.doesNotThrow(() => assertInvoiceStatusTransition("draft", "sent"));
  assert.doesNotThrow(() => assertInvoiceStatusTransition("sent", "paid"));
  assert.doesNotThrow(() => assertInvoiceStatusTransition("sent", "void"));
  assert.throws(() => assertInvoiceStatusTransition("paid", "sent"));
  assert.throws(() => assertInvoiceStatusTransition("draft", "paid"));
});

test("public invoice tokens are random, hashed, and verifiable", () => {
  const token = generatePublicInvoiceToken();
  const other = generatePublicInvoiceToken();
  const hash = hashPublicInvoiceToken(token);
  assert.notEqual(token, other);
  assert.equal(hash.length, 64);
  assert.equal(hash.includes(token), false);
  assert.equal(verifyPublicInvoiceToken(token, hash), true);
  assert.equal(verifyPublicInvoiceToken(other, hash), false);
  assert.equal(verifyPublicInvoiceToken("bad", hash), false);
});