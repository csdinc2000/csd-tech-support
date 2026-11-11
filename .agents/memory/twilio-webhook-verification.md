---
name: Twilio webhook verification
description: Security rule for authenticating all Twilio callback routes consistently.
---

All Twilio POST callbacks must live below one shared `/webhooks` boundary that rejects invalid signatures in production, ignores local bypass flags there, and fails closed when the auth token is unavailable.

Signature URLs use the canonical `APP_BASE_URL` origin when configured, falling back to the ingress request URL only when no valid canonical origin exists.

Every URL written to Twilio—including number provisioning, webhook synchronization, and outbound delivery-status callbacks—must use that same canonical origin. An administrator opening settings through a development or proxy host must never replace production callbacks with that host.

**Why:** Per-handler checks and manually maintained route inventories can leave a callback unprotected, while ingress hosts can differ from the public URL Twilio signs. If callback creation and verification choose different origins, valid Twilio requests fail signature checks or get sent to a temporary environment.

**How to apply:** Mount the boundary before every Twilio route registrar, keep Twilio POST callbacks under `/webhooks`, and test proxy-host scenarios against the canonical public origin. Keep public resources GET-only.