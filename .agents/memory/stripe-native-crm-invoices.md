---
name: Stripe-native CRM invoices
description: Records the chosen boundary between CSD invoice records, Stripe-native invoices, and customer-facing payment links.
---

Issued CRM invoices should create idempotent Stripe-native invoice records and retain Stripe’s hosted invoice URL and PDF. The branded CSD invoice page remains the link sent to customers and leads them to Stripe for payment.

**Why:** The user explicitly chose Stripe-native invoices and hosted PDFs instead of one-off Checkout Sessions. Keeping the CSD page preserves the existing branded communication and private-link lifecycle while Stripe owns payment collection and invoice documents.

**How to apply:** New invoice payment work should reconcile Stripe invoice payment events to the immutable local invoice binding. Preserve legacy Checkout reconciliation only for invoices issued before this decision.

Keep the invoice experience straightforward like PayPal's invoicing flow, but use Computer Systems Depot's own logo and red, white, navy, and black branding. Stripe remains the actual payment processor; an optional external PayPal link is not integrated payment tracking.

**Why:** The user clarified that the desired PayPal resemblance is the ease and presentation of the invoice flow, not PayPal as the underlying automatic payment processor.

**How to apply:** Brand the customer-facing CSD invoice and staff creation flow consistently. Label any external PayPal link as manually reconciled, never as a Stripe-equivalent payment integration.

Stripe document verification incidents must retain only invoice identifiers, document kind, failure category, and attempts. Never retain signed hosted-page or PDF URLs in failure details, and resolve the incident transactionally when a later email is queued successfully.

**Why:** Signed Stripe document URLs are operational secrets, while owners still need a durable explanation for blocked invoice emails and a clear indication that a later retry succeeded.

**How to apply:** Any send path that verifies Stripe-hosted documents should use the same sanitized incident lifecycle, including initial sends, manual resends, and automated reminders.

Treat business-wide invoice branding as defaults for future issues, not a retroactive edit to sent invoices. Stripe's account logo and colors remain separate from the branded CSD customer page; the supported per-invoice customization is footer text.

**Why:** A later settings change should not silently alter what an existing customer sees for an issued invoice or imply the Stripe-hosted PDF has adopted CSD page styling.

**How to apply:** Capture settings when the invoice is sent, retain CSD defaults for legacy invoices, and state clearly which parts of the Stripe document are controlled by the invoice settings page.