---
name: Contact phone validation
description: The invariant for accepting phone numbers on any path that creates or updates CRM contacts.
---

Any path that creates or updates a CRM contact must validate the raw, nonblank phone input before formatting, matching, or extracting digits. Character stripping is allowed only after strict validation succeeds.

**Why:** Digit-only normalization can turn malformed input containing letters or repeated plus signs into an apparently usable stored number, bypassing entry validation.

**How to apply:** Use the shared strict phone validator for manual edits, imports, intake, invoice recipients, call-derived contacts, and future contact-producing integrations. Preserve accepted user formatting unless a path intentionally stores canonical E.164.