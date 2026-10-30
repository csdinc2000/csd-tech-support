---
name: PTT telemetry privacy
description: Privacy boundary for historical browser voice-path telemetry.
---

Historical PTT health data must contain only a talk-group identifier, a coarse connection outcome, the selected path class, a sanitized failure reason, and a timestamp. Never persist or return TURN credentials, relay URLs, IP addresses, peer identifiers, or operator identities.

**Why:** Owners need trends and failure context, but connection diagnostics can otherwise expose temporary credentials and user/network identifiers that are unnecessary for operational reporting.

**How to apply:** Keep aggregation server-side behind the owner gate. When adding dimensions or drill-downs, prefer bounded enums and scrubbed reason text; reject fields that identify a person, peer, credential, or endpoint.