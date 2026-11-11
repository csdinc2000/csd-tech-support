---
name: Bulk SMS consent
description: Consent and delivery boundaries for bulk customer texting.
---

Bulk recipient eligibility is a server-owned decision. Service messages require current service SMS consent; marketing messages require separate auditable promotional consent. A STOP state overrides either permission.

**Why:** Staff need convenient bulk selection without accidentally treating an operational opt-in as permission for promotional campaigns or relying on stale browser eligibility.

**How to apply:** Resolve contacts and consent again for every bulk send, deduplicate normalized phone numbers, cap batch size, isolate recipient failures, and show excluded recipients before confirmation.