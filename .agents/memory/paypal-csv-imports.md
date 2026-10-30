---
name: PayPal CSV transaction imports
description: Covers the safety and data-minimization rules for importing PayPal transaction-history exports into the CRM.
---

PayPal CSV imports must preview mapped transaction fields before writing and remain idempotent. A PayPal source ID is not unique per translated row: invoice summaries and line items can share it, so deduplication must combine it with stable mapped row fields. Continue recognizing the legacy ID-only key for previously imported data.

**Why:** Staff may re-export overlapping date ranges or upload the same file twice. Translated invoice exports can also omit dates and net amounts while reusing one source ID across multiple legitimate rows. Raw exports include unrelated personal and payment metadata that the CRM does not need.

**How to apply:** Preserve blank translated dates and net amounts as null, reject malformed nonblank values, and persist only mapped ledger fields plus source ID, status, file name, and import audit identity. Do not retain the full raw CSV row or automatically attach ambiguous transactions to invoices.