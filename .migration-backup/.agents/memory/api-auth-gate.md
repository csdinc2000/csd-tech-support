---
name: API auth gate (default-deny)
description: How /api auth is enforced and the ordering constraints that make it work.
---

# Default-deny /api auth gate

The app gates every `/api/*` request behind a logged-in session via a single global
middleware in `server/index.ts`, with an explicit public allowlist
(`isPublicApiRequest`). Anything not allowlisted and not `req.isAuthenticated()` → 401.

**Why ordering matters:** `setupAuth(app)` (session + passport) and
`registerAuthRoutes(app)` must run BEFORE the gate so the gate can read the session
and so `/api/login`, `/api/callback`, `/api/logout`, `/api/auth/user` stay reachable
(they're matched before the gate runs). The gate must be mounted BEFORE
`registerTwilioTracking(app)` and `registerRoutes(app)` — otherwise their `/api/*`
routes are unprotected. The Twilio call-tracking routes were previously
*unprotectable* because they registered before passport.session; moving auth setup
into index.ts ahead of the gate fixed that.

**How to apply:** Add new admin endpoints anywhere under `registerRoutes` /
`registerTwilioTracking` and they're protected by default. To make something public,
add it to `isPublicApiRequest`. Prefer explicit method+path entries over broad
prefixes — `/api/portal/*` and `/api/booking/*` are prefix-allowlisted, so a new
sensitive endpoint under those prefixes would leak unless you tighten the allowlist.
Auth routes / Stripe webhook stay public by being registered before the gate, not via
the allowlist.

Client side: `RequireAuth` in `client/src/App.tsx` wraps the admin router and
redirects to `/api/login` once auth state resolves; public pages (`/`,
`/intake`, `/start-service`, `/embed`, `/privacy`, `/portal`) sit outside it.

**Root `/` is the PUBLIC customer landing page**, not the dashboard — the domain
(support.computersystemsdepot.com) is customer-facing, so an unauthenticated
visitor must see a real page, never a login redirect/blank. Staff home is
`/dashboard`; the auth callback `successReturnToOrRedirect` points there so login
lands on the dashboard, not the public page. **Why:** a gated root made the
public site look broken (blank `#root`). Keep `/` public; add new public routes
in the public block BEFORE the auth-gated catch-all `<Route>`.

## Admin authorization (email allowlist, fail-closed)

There are two user tables: legacy `users` (serial id, empty/unused) and
`auth_users` (the real Replit-Auth table; varchar id from OIDC `claims.sub`).
`auth_users` has **no role column** and `db:push` is broken, so admin status is
NOT a DB role — it's an email allowlist: `ADMIN_EMAILS` (comma-separated, falls
back to `CSD_ADMIN_EMAIL`) compared against `req.user.claims.email`.

**Why:** can't add a role column (no working migration), single-tenant internal
tool. An earlier fail-OPEN fallback (empty allowlist → everyone admin) was a
privilege-escalation hole, so `isAdminUser` now **fails closed**: empty allowlist
→ nobody is admin → admin groups 403 for all. `ADMIN_EMAILS` is set to the owner
so they keep access; if it's ever cleared, admin routes lock down rather than
open up.

**How to apply:** admin groups are matched by prefix in `isAdminApiPath`
(`/api/meshcentral*`, `/api/billing*`, `/api/call-tracking*`, `/api/twilio*`) and
enforced inside the same `/api` gate after the auth check (403 on fail). Some
routes (e.g. `/api/twilio/a2p/rejection-suggestions`) also have their own
route-level "Owner access" check — that's separate from this gate.
