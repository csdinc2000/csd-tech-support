---
name: Email webhook event ordering
description: Keeps asynchronous provider delivery events authoritative despite app-side send timestamps.
---

Track provider event time separately from application send-attempt time when ordering email delivery statuses.

**Why:** Provider timestamps may have only second-level precision, while the app writes acceptance after the provider event is already emitted. Comparing the event directly to the later database write can incorrectly discard a valid delivery or bounce event.

**How to apply:** Use the provider timestamp only to order provider callbacks; allow the first verified provider status to supersede app-side pending, accepted, or failed outcomes, then reject older provider events.
