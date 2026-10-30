---
name: A2P alert lifecycle
description: Durable incident and recovery rules for Twilio A2P monitoring alerts.
---

An explicit approved Twilio A2P result must always reconcile active database alerts, even when process-local monitor state says no previous failure. Repeated failure checks update one active A2P incident instead of creating new rows.

**Why:** Deployment restarts reset local monitor state while stale incident rows remain in PostgreSQL, and cooldown-based re-alerting previously accumulated hundreds of duplicate active rejection alerts.

**How to apply:** Treat PostgreSQL as the incident source of truth, process state only as notification throttling, resolve all active A2P rows on approved status, and never persist preview-domain links in long-lived alert descriptions.