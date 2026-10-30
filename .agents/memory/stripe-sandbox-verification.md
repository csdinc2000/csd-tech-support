---
name: Stripe sandbox verification
description: Durable constraints for exercising Stripe-native CRM invoice payment flow in the connected test account.
---

Stripe invoice payment verification must treat `status = paid` plus the immutable invoice ID, exact amount, USD currency, and CRM metadata as the payment proof. Do not require Stripe's legacy `paid` or `paid_out_of_band` flags: the connected API version can omit both while returning a paid invoice.

**Why:** The real Stripe sandbox response omitted those legacy flags, while the status and binding fields were present and the signed `invoice.paid` event reconciled correctly.

**How to apply:** Run the opt-in sandbox exercise only against a test-mode account. For signed replay, read the managed webhook secret from Stripe Sync's `_managed_webhooks` table when connector settings do not expose it; never print the secret.