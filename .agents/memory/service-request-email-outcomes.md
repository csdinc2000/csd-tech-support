---
name: Service-request email outcomes
description: How staff should interpret uncertain email submissions and decide whether to retry.
---

Service-request email tracking records submission, not customer delivery. Ambiguous transport failures, HTTP server errors, and interrupted sends must not be treated as proof that no email was sent. Do not automatically resend these messages.

**Why:** Staff may reload or time out after a provider has already queued the message. Retrying automatically can duplicate customer emails; a provider's acceptance response still does not prove customer receipt.

**How to apply:** Keep submission history available before staff retry, distinguish explicit rejection from uncertainty, and require a deliberate staff decision for another send. Delivery confirmation requires separate authenticated provider delivery events, not an inference from acceptance.