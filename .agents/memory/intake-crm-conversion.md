---
name: Intake CRM conversion
description: Rules for safely treating public intake submissions as the foundation of CRM and sales pipeline records.
---

Each accepted intake should atomically persist the canonical service request, produce or associate a client account and CRM contact, create a lead, and create a lead-stage sales opportunity. Anonymous intake data must not overwrite existing staff-maintained records; conflicting or partial identity matches should be flagged for staff review.

**Why:** Intake is the first sales touchpoint, but public identifiers are unverified. Directly merging them can poison customer records, while non-atomic creation and retries can leave orphaned or duplicate pipeline entries.

**How to apply:** Normalize identifiers for comparison, require unambiguous identity resolution before reuse, link every derived record back to the canonical intake, use durable idempotency with resumable job/ticket handoff, and expose no existing PII publicly.