---
name: Stripe reconciliation incidents
description: Durable privacy and deduplication rules for failed Stripe-to-CRM payment reconciliation.
---

Failed Stripe payment reconciliation should remain visible as one administrator-facing audit incident per invoice. Repeated webhook delivery updates the existing incident with the latest event, error, timestamp, and attempt count instead of creating another row.

**Why:** Stripe retries can deliver the same signed event repeatedly, while raw webhook payloads and credentials are not appropriate for an administrator audit view.

**How to apply:** Store only invoice identity, Stripe event identity, a bounded/redacted error message, and retry metadata. Use a database uniqueness rule for the invoice/action pair so concurrent deliveries cannot create duplicate incidents.