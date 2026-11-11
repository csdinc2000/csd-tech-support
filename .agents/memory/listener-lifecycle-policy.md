---
name: Listener lifecycle policy
description: User-requested boundary between feature cleanup and always-needed call handling.
---

Only turn listeners on and off when needed, and leave on what needs to be left on for phone calls.

**Why:** The user explicitly clarified that fixing memory leaks must not disable necessary phone-call functionality.

**How to apply:** Scope feature listeners to their actual lifetimes and clean up duplicates or obsolete subscriptions. Preserve required incoming-call and call-routing handling while the app is active.
