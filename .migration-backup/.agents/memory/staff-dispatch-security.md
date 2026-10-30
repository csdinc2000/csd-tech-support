---
name: Staff dispatch security
description: Security boundaries for staff SMS commands, masked client messaging, and roster-based call routing.
---

Staff SMS commands must fail closed unless the Twilio webhook signature is verified, the sender exactly matches an enabled/on-duty command recipient, and that recipient is linked to a helpdesk assignee. Mutating commands are limited to tickets assigned to that linked assignee.

**Why:** A valid Twilio webhook alone does not prove the sender is authorized staff, and a roster match without a verified webhook can be forged. Client proxy messages also need current consent; a later STOP must override any historical intake consent.

**How to apply:** Preserve compliance-keyword precedence, current consent state, atomic claims, and recipient-bound ticket authorization when extending dispatch commands. Never include customer portal bearer tokens in staff SMS links.