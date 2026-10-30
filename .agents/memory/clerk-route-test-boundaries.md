---
name: Clerk route test boundaries
description: Why focused API route tests inject authentication instead of fabricating Clerk request state.
---

Focused route integration tests should inject or replace only the authentication gate, then exercise the real application authorization middleware and handlers. If a test must fabricate Clerk auth for code that calls `getAuth` directly, its auth object needs `tokenType: "session_token"` so Clerk preserves the claims.

**Why:** Clerk brands and normalizes its request auth handler internally. Adding a synthetic `req.auth` function, even with Clerk's global brand symbol, can still normalize to a signed-out session and produce misleading authorization results.

**How to apply:** When a route registrar supports middleware injection, use a no-op authenticated test gate while populating the application's resolved database user. Keep feature, role, ownership, and resource-scope middleware unchanged. When direct `getAuth` calls must remain real, include the session token type in the synthetic auth result.