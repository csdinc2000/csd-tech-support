---
name: PTT live call visibility
description: The administrator visibility boundary for direct and group PTT calls.
---

Administrator PTT views show call status and participants only; they do not provide live audio monitoring. Role-targeted and selected-recipient calls use private direct channels, separate from the shared talk-group/RoIP path.

**Why:** the user chose status-only visibility for the technician call pop-up, and private recipient groups must not accidentally bridge into radio traffic.

**How to apply:** Provide ringing, connected, declined, and unavailable states plus participant names. Do not add administrator listen-in audio or route role/individual calls through the shared radio talk group.
