---
name: Stripe document incident ordering
description: Ordering and privacy rules for Stripe invoice document availability incidents.
---

Stripe invoice document incidents must apply failure and resolution outcomes by when document availability was verified, not when each database write happens. A success wins an equal-time tie, and all outcomes update the single retained incident row.

**Why:** Document checks can finish or reach the database out of order. An older blocked send must not reopen a warning after a newer check proves the hosted invoice and PDF are available.

**How to apply:** Capture the outcome timestamp when verification completes, compare it atomically during incident writes, and retain only sanitized document kind, category, attempt, identity, and lifecycle metadata.