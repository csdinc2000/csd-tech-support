export type CatalogPurchaseReference = {
  id: string;
  stripe_checkout_session_id: string | null;
  stripe_product_id: string;
  stripe_price_id: string;
};

export const CATALOG_RECONCILIATION_BASE_DELAY_MINUTES = 5;
export const CATALOG_RECONCILIATION_MAX_DELAY_MINUTES = 24 * 60;

export function catalogReconciliationDelayMinutes(attemptsAlreadyMade: number): number {
  const exponent = Math.max(0, Math.floor(attemptsAlreadyMade));
  return Math.min(
    CATALOG_RECONCILIATION_BASE_DELAY_MINUTES * (2 ** exponent),
    CATALOG_RECONCILIATION_MAX_DELAY_MINUTES,
  );
}

export function planCatalogCrmLinks(input: {
  contacts: Array<{ id: number; clientId: number | null }>;
  uniqueAccountId: number | null;
  associatedAccountId?: number | null;
}): { contactId: number | null; accountId: number | null; createContact: boolean } {
  if (input.contacts.length > 1) {
    return { contactId: null, accountId: null, createContact: false };
  }
  if (input.contacts.length === 1) {
    const contact = input.contacts[0];
    return {
      contactId: contact.id,
      accountId: contact.clientId != null
        ? input.associatedAccountId ?? null
        : input.uniqueAccountId,
      createContact: false,
    };
  }
  return { contactId: null, accountId: input.uniqueAccountId, createContact: true };
}

export function isValidPaidCatalogCheckout(input: {
  session: any;
  lineItems: any[];
  price: any;
  product: any;
  purchase: CatalogPurchaseReference;
}): boolean {
  const { session, lineItems, price, product, purchase } = input;
  const lineItem = lineItems.length === 1 ? lineItems[0] : null;
  const priceProductId = typeof price?.product === "string" ? price.product : price?.product?.id;
  const lineItemPriceId = typeof lineItem?.price === "string" ? lineItem.price : lineItem?.price?.id;

  return Boolean(
    session?.id &&
    (!purchase.stripe_checkout_session_id || session.id === purchase.stripe_checkout_session_id) &&
    session.mode === "payment" &&
    session.status === "complete" &&
    session.payment_status === "paid" &&
    session.amount_total === price?.unit_amount &&
    typeof session.currency === "string" &&
    session.currency.toLowerCase() === price?.currency?.toLowerCase() &&
    session.metadata?.catalogPurchaseId === purchase.id &&
    session.metadata?.productId === purchase.stripe_product_id &&
    session.metadata?.priceId === purchase.stripe_price_id &&
    price?.id === purchase.stripe_price_id &&
    priceProductId === purchase.stripe_product_id &&
    price?.unit_amount > 0 &&
    !price?.recurring &&
    product?.id === purchase.stripe_product_id &&
    product?.metadata?.csd_catalog === "true" &&
    lineItemPriceId === purchase.stripe_price_id &&
    lineItem?.quantity === 1 &&
    lineItem?.amount_total === price.unit_amount
  );
}

export function nextCatalogPurchaseStatus(
  current: string,
  session: { status?: string; payment_status?: string },
  eventType?: string,
  verifiedPaid = false,
): string {
  if (current === "paid") return "paid";
  if (verifiedPaid) return "paid";
  if (session.status === "expired") return "expired";
  if (current === "expired") return "expired";
  if (eventType === "checkout.session.async_payment_failed") return "failed";
  if (session.status === "complete" && session.payment_status === "unpaid") {
    return current === "failed" || current === "expired" ? current : "pending";
  }
  return current;
}