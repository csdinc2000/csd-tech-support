import assert from "node:assert/strict";
import test from "node:test";
import {
  CATALOG_RECONCILIATION_MAX_DELAY_MINUTES,
  catalogReconciliationDelayMinutes,
  isValidPaidCatalogCheckout,
  nextCatalogPurchaseStatus,
  planCatalogCrmLinks,
} from "./catalog-core";

const purchase = {
  id: "c06fd8d8-a1cc-4c11-a573-e153c42b581b",
  stripe_checkout_session_id: "cs_test_123",
  stripe_product_id: "prod_catalog",
  stripe_price_id: "price_catalog",
};

const validPayment = {
  session: {
    id: "cs_test_123",
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    amount_total: 2500,
    currency: "usd",
    metadata: {
      catalogPurchaseId: purchase.id,
      productId: purchase.stripe_product_id,
      priceId: purchase.stripe_price_id,
    },
  },
  lineItems: [{ price: { id: purchase.stripe_price_id }, quantity: 1, amount_total: 2500 }],
  price: {
    id: purchase.stripe_price_id,
    product: purchase.stripe_product_id,
    unit_amount: 2500,
    currency: "usd",
    recurring: null,
  },
  product: { id: purchase.stripe_product_id, metadata: { csd_catalog: "true" } },
  purchase,
};

test("validates paid catalog sessions against the persisted Stripe purchase", () => {
  assert.equal(isValidPaidCatalogCheckout(validPayment), true);
  assert.equal(isValidPaidCatalogCheckout({
    ...validPayment,
    session: { ...validPayment.session, amount_total: 1 },
  }), false);
  assert.equal(isValidPaidCatalogCheckout({
    ...validPayment,
    session: { ...validPayment.session, currency: "eur" },
  }), false);
  assert.equal(isValidPaidCatalogCheckout({
    ...validPayment,
    lineItems: [{ ...validPayment.lineItems[0], price: { id: "price_unrelated" } }],
  }), false);
  assert.equal(isValidPaidCatalogCheckout({
    ...validPayment,
    price: { ...validPayment.price, product: "prod_unrelated" },
  }), false);
});

test("allows a later verified paid event to supersede failed or expired events", () => {
  const livePaidSession = { status: "complete", payment_status: "paid" };
  assert.equal(nextCatalogPurchaseStatus("failed", livePaidSession, "checkout.session.async_payment_failed", true), "paid");
  assert.equal(nextCatalogPurchaseStatus("expired", livePaidSession, "checkout.session.completed", true), "paid");
  assert.equal(nextCatalogPurchaseStatus("paid", { status: "expired" }), "paid");
  assert.equal(nextCatalogPurchaseStatus("pending", { status: "expired" }), "expired");
  assert.equal(nextCatalogPurchaseStatus("expired", { status: "complete", payment_status: "unpaid" }, "checkout.session.async_payment_failed"), "expired");
});

test("CRM linking avoids ambiguous identities and prefers a contact's associated account", () => {
  assert.deepEqual(planCatalogCrmLinks({
    contacts: [{ id: 1, clientId: 8 }],
    uniqueAccountId: 9,
    associatedAccountId: 8,
  }), { contactId: 1, accountId: 8, createContact: false });
  assert.deepEqual(planCatalogCrmLinks({
    contacts: [{ id: 1, clientId: null }],
    uniqueAccountId: 9,
  }), { contactId: 1, accountId: 9, createContact: false });
  assert.deepEqual(planCatalogCrmLinks({
    contacts: [{ id: 1, clientId: null }, { id: 2, clientId: 9 }],
    uniqueAccountId: 9,
  }), { contactId: null, accountId: null, createContact: false });
  assert.deepEqual(planCatalogCrmLinks({
    contacts: [],
    uniqueAccountId: null,
  }), { contactId: null, accountId: null, createContact: true });
});

test("reconciliation retries indefinitely with a capped daily backoff", () => {
  assert.equal(catalogReconciliationDelayMinutes(0), 5);
  assert.equal(catalogReconciliationDelayMinutes(1), 10);
  assert.equal(catalogReconciliationDelayMinutes(9), CATALOG_RECONCILIATION_MAX_DELAY_MINUTES);
  assert.equal(catalogReconciliationDelayMinutes(1_000), CATALOG_RECONCILIATION_MAX_DELAY_MINUTES);
});