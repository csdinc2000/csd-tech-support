// Stripe Sync owns the endpoint and handles product/price mirroring. These
// events also drive CSD's catalog purchase reconciliation.
export const CATALOG_WEBHOOK_EVENTS = [
  "product.created",
  "product.updated",
  "product.deleted",
  "price.created",
  "price.updated",
  "price.deleted",
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
] as const;

export function missingCatalogWebhookEvents(enabledEvents: readonly string[]): string[] {
  if (enabledEvents.includes("*")) return [];
  return CATALOG_WEBHOOK_EVENTS.filter((event) => !enabledEvents.includes(event));
}