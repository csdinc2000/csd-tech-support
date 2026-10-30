---
name: Client history identity safety
description: Privacy and identity rules for consolidating communications into account-level customer history.
---

When client profiles aggregate communication history, explicit persisted contact links are authoritative. A phone fallback is allowed only when the full canonical number belongs to exactly one CRM contact across the system; ambiguous numbers must remain unlinked. Raw Twilio call and SMS content is administrator-only even when broader client overview data is available to staff.

**Why:** Suffix matching or first-match selection can assign shared, recycled, or international numbers to the wrong customer and disclose communication content across accounts. The client overview must not become a bypass around communications authorization.

**How to apply:** Use full canonical E.164-style comparison, verify global uniqueness before fallback association, prefer indexed foreign keys for new records, and filter communication content by role at the API boundary.