---
name: First-party catalog offers
description: The product boundary and purchase choices for CSD-owned marketplace offers.
---

CSD-owned products and services should remain visibly distinct from customer-to-customer hardware listings in the existing marketplace. Buyers must have both an inquiry path, after which staff can issue a CRM-linked invoice, and a direct Stripe Checkout path.

**Why:** The existing community marketplace is a free peer-to-peer contact board, whereas CSD-owned offers are paid directly to the business. The user explicitly chose both contact-and-invoice and immediate Stripe purchase options.

**How to apply:** Do not turn peer listings into CSD checkout items or imply that an inquiry is a completed payment. Keep customer invoice recipients linked through CRM identities, and verify direct-sale payment server-side before attributing a purchase.

Marketplace corrections must not silently void, refund, or change an earlier invoice. Prefer opening an existing draft for edits; creating a separate correction requires explicit confirmation that the earlier invoice remains unchanged.

**Why:** Duplicate prevention and intentional correction were requested together, but cancellation and refund authority were not. Automatically cancelling an earlier invoice could change a legitimate customer balance or payment.

**How to apply:** Preserve this distinction when extending correction workflows. Any future replacement-and-cancellation flow needs its own explicit confirmation and settlement rules.