---
name: External invoice settlement ambiguity
description: How to reason about lost responses and concurrent payments when confirming external invoice payments.
---

Stripe's invoice status alone does not distinguish a customer Stripe payment from an out-of-band payment after a lost response. Only a successful out-of-band pay request or a replay of the same idempotency key proves which operation closed the invoice. Once that replay window is gone, do not guess: leave the external confirmation unresolved for manual review.

**Why:** A network timeout or process failure can happen after Stripe closes an invoice but before CSD records the external payment. Treating any later `paid` invoice as either a Stripe charge or a confirmed PayPal receipt can create false or duplicate settlements.

**How to apply:** Persist an external settlement claim before making the provider call; block automatic Stripe reconciliation while it is unresolved. Retry with exactly the same provider and reference, and fail closed if Stripe cannot prove the original out-of-band close.