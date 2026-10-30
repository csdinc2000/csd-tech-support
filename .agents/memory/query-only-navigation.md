---
name: Query-only navigation
description: Preserving staff handoff selections and dirty forms when only the URL query changes.
---

Treat query-only navigation as real navigation: observe the query separately from the pathname, carry selection parameters through redirects, and apply dirty-form protection before changing visible content.

**Why:** Wouter's pathname value can stay unchanged when a tab or selected assignee changes. A handoff may pass isolated helper tests yet fail in the combined Staff area if a legacy redirect drops its query or the tab does not observe it.

**How to apply:** Verify handoffs through the real containing view and redirects, not just a standalone destination component. Keep explicit owner approval and recipient saving separate from navigation; restoring a cancelled tab switch must preserve the draft.