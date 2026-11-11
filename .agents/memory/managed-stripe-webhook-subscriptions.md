---
name: Managed Stripe webhook subscriptions
description: The Stripe Sync managed-webhook behavior when new business events are introduced.
---

When adding application-specific Stripe webhook event handling, explicitly check the existing managed endpoint's enabled events and add any missing subscriptions. Preserve its existing subscriptions and signing secret. Do not assume that asking Stripe Sync to find or create its managed endpoint refreshes the event set.

**Why:** The installed Stripe Sync implementation returns an existing enabled endpoint without comparing its enabled events to the requested set. A handler can be correct yet never receive newly required events.

**How to apply:** On startup, validate required events after managed endpoint discovery. Update only if events are missing; treat a wildcard subscription as complete. Keep server-side polling/reconciliation for missed webhook deliveries.