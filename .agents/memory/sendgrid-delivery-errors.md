---
name: SendGrid provider health
description: Covers SendGrid's misleading errors and the lifecycle for account-capacity incidents.
---

When SendGrid delivery fails, use the nested provider error message rather than only the top-level SDK message.

**Why:** SendGrid returned HTTP 401 with the SDK message “Unauthorized” while the response body said “Maximum credits exceeded.” Showing only the top-level message sent administrators toward the wrong repair.

**How to apply:** Persist and display the first non-empty message from the provider response body for invoice and other operational email failures, while keeping generic network/SDK messages as the fallback.

Treat provider quota or account-capacity failures as one shared operational incident. The alert may identify affected operation categories, but must not retain recipients, subjects, message bodies, credentials, or raw provider responses. Resolve the incident only after SendGrid accepts a later operational email.

**Why:** Capacity exhaustion affects all operational mail, so per-message alerts create noise and expose unnecessary context. A later accepted send is the direct confirmation that provider capacity has recovered.

**How to apply:** Route operational SendGrid sends through the shared provider-health lifecycle, merge operation categories into the active incident, and close all active capacity incidents on the next accepted SendGrid send.

Coordinate capacity incident creation, category merging, and recovery in PostgreSQL rather than relying on a process-local queue. Enforce one active incident with a database constraint as a final backstop.

**Why:** Multiple API instances can observe no active incident at the same time; independent read-then-create or read-then-update flows can duplicate alerts or lose an operation category.

**How to apply:** Serialize the full lifecycle with one shared database lock, merge categories while holding it, and keep a partial unique index for the active capacity source.

Poll SendGrid's authenticated user credit-balance endpoint for proactive capacity warnings. Treat only a successful response with valid integer remaining and total credits as reliable; permission, transport, and malformed-response failures must not create or resolve alerts.

**Why:** SendGrid exposes remaining account credits, but API keys may lack access and transient failures do not prove that capacity is low. A failed poll must not create a false owner incident.

**How to apply:** Warn at the shared low-capacity threshold, reuse the capacity incident source and privacy rules, preserve the warning after an accepted email, and resolve it only when a later reliable balance is above threshold.

Owner-triggered provider checks must use a database-backed allowance keyed from the authenticated owner identity, never request or provider payload data.

**Why:** A process-local limiter multiplies the intended provider-call allowance when the API runs on multiple instances.

**How to apply:** Use an atomic shared-store limiter for provider rechecks, preserve a safe positive retry interval on rejection, and fail rather than calling the provider if the shared store is unavailable.
