---
name: Staff record assignment scope
description: Durable authorization rules for customer-, job-, and contact-scoped staff data.
---

Approved non-administrator staff must receive no customer, job, or contact records until explicitly assigned. Customer assignments authorize that account’s devices and tickets; job assignments authorize only that job and its consistent service-log relationship. Contact assignments independently authorize viewing one person, and `can_edit` is required for contact-linked mutations or external disclosures. Provider device identities and bulk contact imports are administrator-controlled. One-to-one texts to known CRM phone numbers require editable access to every matching contact; approved staff may text truly unlinked numbers, while pending or suspended staff may not use that exception.

**Why:** Feature-level role access is not a substitute for row-level isolation, and trusting either side of a mixed relationship or a staff-editable provider identifier creates cross-customer bypasses.

**How to apply:** Enforce scope on lists, aggregates, direct IDs, subresources, exports, writes, and outbound communications. Resolve raw contact details before delivery and fail closed on ambiguous matches. Validate every supplied relationship, reject malformed IDs before permissive parsing, and keep owners/authorized staff administrators unrestricted.