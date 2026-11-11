---
name: Published feedback widget
description: How to distinguish the Replit publishing feedback control from app UI.
---

The “Share Your Feedback” button on a published Replit app is controlled by Publishing → Advanced Settings → Enable Feedback. It is not the app's React widget and is unrelated to the Vite development banner. Disabling it requires changing that publishing setting and republishing; app CSS or component edits will not reliably remove it.

**Why:** The user wanted ARIA in the lower-right corner instead of this control. The published overlay cannot be replaced by merely moving ARIA in app code.

**How to apply:** Move app-owned controls in code, then tell the user to turn off Enable Feedback in Publishing settings and republish. Do not claim the published widget has disappeared before the setting is changed.