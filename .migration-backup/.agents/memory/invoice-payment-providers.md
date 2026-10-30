---
name: Invoice payment providers
description: The trust boundary for Stripe and PayPal payments on customer invoices.
---

Stripe Checkout is the verified invoice-payment provider. PayPal is limited to an owner-supplied HTTPS PayPal or PayPal.me link and is never treated as paid automatically; an owner must record the external payment reference.

**Why:** Stripe has a supported connected integration with signature-verified webhooks. No supported PayPal verification connector is available, so presenting PayPal as automatically verified would create a false payment state.

**How to apply:** Keep Stripe amount and status verification server-side and webhook-driven. Label PayPal as externally processed, and require explicit owner confirmation before changing invoice status to paid.