---
name: MeshCentral control authentication
description: Non-obvious handshake requirements for reliable MeshCentral control-channel access.
---

MeshCentral control WebSockets must send the configured MeshCentral server origin and the native `x-meshauth` credential header over TLS; a browser login cookie alone is not reliable.

**Why:** This server accepts the web login but rejects cookie-only `/control.ashx` sessions as `noauth`. Adding only the origin can work initially, but the browser session may be invalidated before a later sync. The native control header remains accepted.

**How to apply:** Use the same handshake for every MeshCentral control operation, including node and device-group requests. Never log the header because Base64 encoding is not credential protection.