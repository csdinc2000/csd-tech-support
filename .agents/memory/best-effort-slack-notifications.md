---
name: Best-effort Slack notifications
description: Reliability and privacy rule for Slack delivery from core CRM operations.
---

Slack notifications are best-effort side effects. A Slack HTTP failure, API-level rejection, or connector exception must never prevent a ticket, lead, call, device alert, or emergency record from being saved.

**Why:** Slack availability is outside the CRM's control, while CRM records are operationally authoritative. Connector errors may also include request details, so raw exceptions can expose notification content.

**How to apply:** Record only a sanitized delivery category and timestamp for consolidated owner health, clear the active warning on the next success, keep emergency notification-attempt history accurate, and never log credentials, request bodies, or raw connector errors.

Queue ticket, intake, call, device-alert, and emergency Slack notifications durably before returning a successful save/callback response. The request may wait for the database enqueue, but never for Slack delivery.

**Why:** Process-local fire-and-forget work can disappear during an API restart after the authoritative record has been saved.

**How to apply:** Use a shared database outbox with stable event keys, retry after restart, retain only sanitized failure categories, and clear message payloads after delivery or terminal failure.

Queue persistence and provider delivery are independent health stages: a successful Slack delivery must not clear a queue-write warning, and a successful enqueue must not clear a delivery warning.

**Why:** An unsaved outbox notification never reaches the delivery worker, so provider-only monitoring incorrectly suggests there is no problem. A database outage can also block writing the queue warning itself.

**How to apply:** Expose sanitized queue outcomes separately to owners; keep only a category and time, opportunistically retry a failed health write after the database recovers, and clear an old queue warning on a later successful enqueue. Never retain the failed notification body as a health fallback.

Owner-requested recovery after terminal failure is a new metadata-only notice, not a replay of the original message.

**Why:** Terminal failure intentionally discards the original payload. Some call and intake messages cannot be faithfully reconstructed from authoritative records; retaining or guessing their content would undermine the privacy boundary.

**How to apply:** Identify the failed event by its outbox record, make each request idempotent and auditable, and state clearly to owners that only the event type and failure time can be delivered again.