---
name: Service contract signing
description: Security and lifecycle rules for fillable CRM agreements and client electronic signatures.
---

Agreements with incomplete service coverage must remain drafts and must not expose a usable signing link. Staff completes the scope before generating a fresh, expiring signer link; generating a new link invalidates the previous bearer token.

**Why:** The app has no safe customer-account boundary, and permitting signatures on placeholder terms can create both authorization and contract-integrity failures.

**How to apply:** Keep staff management behind authenticated CRM routes. Public signer routes may resolve only a high-entropy token hash, must reject draft/void/expired records, and must preserve consent, signer identity, timestamp, client context, and an immutable document fingerprint.

Never rotate the signing link after an agreement has been signed. For unsigned agreements, staff should be warned before regenerating a link because it invalidates every earlier copy.

**Why:** Signed agreements need stable read-only access, and an unannounced link replacement can strand a customer on a 404 page.

**How to apply:** Guard link rotation atomically against a concurrent signature, show the invalidation warning before the staff action, and keep the newly generated link available to the staff member.