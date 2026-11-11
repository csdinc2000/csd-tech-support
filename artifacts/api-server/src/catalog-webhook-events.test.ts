import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG_WEBHOOK_EVENTS, missingCatalogWebhookEvents } from "./catalog-webhook-events.ts";

test("catalog webhook requires checkout and product/price changes", () => {
  const missing = missingCatalogWebhookEvents(["checkout.session.completed", "product.updated"]);
  assert(missing.includes("checkout.session.async_payment_succeeded"));
  assert(missing.includes("checkout.session.async_payment_failed"));
  assert(missing.includes("checkout.session.expired"));
  assert(missing.includes("product.created"));
  assert(missing.includes("price.updated"));
  assert(!missing.includes("checkout.session.completed"));
  assert.equal(missingCatalogWebhookEvents(CATALOG_WEBHOOK_EVENTS).length, 0);
  assert.equal(missingCatalogWebhookEvents(["*"]).length, 0);
});