# CSD Platform — Replit Agent Improvement Prompt

> Paste the block below into the Replit Agent. It is **audit-first and gated**: the Agent
> inventories before it touches anything, then stops for your approval between every phase.
> Do not let it skip the gates — that is what protects your working flows.

---

## ROLE & GROUND RULES (paste this whole block)

You are working on an existing production app: a combined **CRM + RMM + Service/Help Desk + Communications** platform for Computer Systems Depot, served at `support.computersystemsdepot.com`, with a remote-control integration to a self-hosted **MeshCentral** server at `remote.computersystemsdepot.com`.

**Confirmed stack — do NOT introduce anything outside it:**
- Frontend: **React + Vite + TypeScript**
- Backend: **Express / Node + TypeScript**
- Auth: **Replit Auth (OAuth)**
- Remote control: **MeshCentral** via its API (device sync)

**Hard constraints (violating any of these is a failure):**
1. **Do not add a second framework.** No Next.js, no Vue, no Python, no swapping the router/state library. Work within React+Vite / Express.
2. **TypeScript everywhere.** No new `.js` files in app code; no `any` unless justified in a comment.
3. **Surgical edits, not rewrites.** Prefer the smallest change that fixes the issue. Never mass-rewrite a working module to "clean it up" unless I explicitly approve it in that phase.
4. **Secrets are server-side only.** No API keys, MeshCentral credentials, tokens, or connection strings in any client bundle, React file, or `VITE_`-prefixed env var. The browser talks only to our Express API; Express talks to MeshCentral and any third party.
5. **Phased and gated.** Complete one phase, then **STOP and post a report**, then **wait for my explicit "go"** before the next phase. Do not chain phases.
6. **No destructive ops without naming them first.** Dropping routes, deleting tables, or removing features must be listed in the report and approved before you do them.

**Technical priorities (apply throughout):** efficient data fetching (cache + batch), low latency, and backend proxies for all credentials. Where a feature would cause heavy polling/API usage, propose a cached or event-driven (SSE/webhook) alternative instead of naive intervals.

---

## PHASE 0 — AUDIT ONLY (no code changes)

Do not modify any file in this phase. Produce a written report covering:

1. **Route & nav inventory.** List every nav entry and the route it points to. For each, mark: `WORKS` / `404` / `EMPTY STUB` / `RENDERS BUT BROKEN`. These are the "dead links" — categorize them honestly. (Known nav surfaces include: Dashboard, Device Management, Network Discovery, Real-Time Monitoring, Patch Management, Help Desk, Helpdesk Admin, Remote Access, Automation, Automation Hub, Reports, Tech Tools, CRM Dashboard, Leads & Pipeline, Jobs/Work Orders, Service Logs, Client Portal, Billing & Plans, ARIA Assistant, Contacts, Messages, CSD Intakes, Call Tracking, Phone & SMS Settings.)
2. **Auth coverage.** Which API routes and pages are protected by Replit Auth and which are exposed? Flag any admin route reachable without a session.
3. **Secret exposure scan.** Grep the client bundle and all `VITE_`-prefixed envs for anything that looks like a key, token, password, or MeshCentral credential. List every hit. This is the highest priority finding.
4. **MeshCentral integration state.** Locate the current integration code. Report: how it authenticates (mesh superuser creds? login token? `loginTokenKey`? API key?), where those secrets live, whether the browser ever calls MeshCentral directly, and whether device data is synced into our own DB or fetched live every time.
5. **Data-fetching patterns.** Identify the heaviest fetch paths (polling intervals, refetch-on-every-render, N+1 request loops). Note where caching or batching is missing.
6. **UX/structure inconsistencies.** Note pages that don't share a common layout shell, missing loading/error/empty states, and the degree of nav sprawl.

**Output format:** a single markdown report with a section per item above, plus a **proposed phase order** for the fixes (your recommendation). Then **STOP and wait for my go.** Do not start Phase 1.

---

## PHASE 1 — Navigation & routing integrity

Goal: no dead links, one source of truth for nav.
- Centralize the nav definition in **one config** (label, path, icon, required role, `enabled` flag). The sidebar renders from it.
- For each dead link from Phase 0, do exactly one of: (a) wire it to its real page if the page exists, (b) replace it with an honest "Coming soon" placeholder **and set `enabled: false`** so it's hidden from primary nav, or (c) remove it — but list every removal for my approval first.
- Add a catch-all `404` route. No raw framework error screens reach users.
- Guard every protected route with the Replit Auth session at the router level, not per-component.

**STOP. Report what changed, what you hid, what you recommend cutting. Wait for go.**

---

## PHASE 2 — Security hardening (do before MeshCentral work)

Goal: no secret reachable from the browser; every API route authenticated.
- Move every secret found in Phase 0 into **Replit Secrets**, server-side only. Remove all `VITE_`-prefixed secrets and any hardcoded keys. Rebuild and re-scan the client bundle to prove zero secrets remain.
- Add an Express auth middleware that requires a valid Replit Auth session on **all** `/api/*` routes except an explicit public allowlist (e.g. health check, client-portal intake). Add a role check for admin routes.
- Add basic abuse protection on public/expensive endpoints: rate limiting and input validation (zod) on request bodies.
- Add an `env` validation step at server boot that fails fast if a required secret is missing.

**STOP. Report the before/after secret scan and the route protection map. Wait for go.**

---

## PHASE 3 — MeshCentral integration, done securely

Reference pattern (proven): Tactical RMM stores a **mesh superuser + token server-side**, syncs each agent's unique ID into its own DB, and uses only a few mature MeshCentral features. Mirror that shape.

Build a single backend **MeshCentral proxy service** (`server/services/meshcentral.ts`):
- Holds the mesh superuser credentials / API token from Replit Secrets. **The `loginTokenKey` and mesh credentials never leave the server** — that key allows full user impersonation and there is only one per server, so treat it as a crown jewel.
- Connects to MeshCentral over its control WebSocket / API to perform: list device groups, list devices, device status/power, and (gated) run-command. The React app calls **our** `/api/mesh/*` endpoints; it must never open a socket to MeshCentral directly.
- **Device sync, not live-fetch-everything:** on an interval (and/or on demand), pull the device list and cache it in our DB keyed by MeshCentral node ID, mapped to our CRM clients/jobs. UI reads from our cache; this keeps latency low and load off MeshCentral.
- **Remote-control launch:** when a tech opens a session, generate a **short-lived, per-request login token server-side** and return only the embed URL. Require `AllowLoginToken: true` + `allowFraming: true` on the MeshCentral side. Treat the token as ~1-hour and copyable — scope it to the specific device/session and log who launched it. Never expose the `loginTokenKey` used to mint it.
- Wrap MeshCentral calls in a timeout + circuit breaker so a slow/dead mesh server never hangs the CRM.

**STOP. Report the endpoints created, the secret-handling, and the sync model. Wait for go.**

---

## PHASE 4 — Data-layer efficiency & latency

Goal: cut redundant fetching; make it feel instant.
- Introduce a query/cache layer (e.g. TanStack Query) with sane `staleTime`/`cacheKey`s for read-heavy views (devices, tickets, contacts, pipeline). Replace ad-hoc `useEffect` fetches.
- Replace naive polling on live views (Real-Time Monitoring, Messages, device status) with **SSE or WebSocket push** from Express, or a single batched poll — not per-widget intervals.
- Batch N+1 request loops found in Phase 0 into single endpoints.
- Add server-side response caching for expensive, slow-changing reads (reports, device groups).

**STOP. Report the fetch-count / latency before vs after on the heaviest views. Wait for go.**

---

## PHASE 5 — "Simple & organized" UX pass

Goal: tame the sprawl without losing capability.
- Group the nav into a few top-level domains with collapsible sections, e.g. **Operations** (RMM/monitoring/patches/remote), **Service** (help desk/jobs/service logs/intakes), **Sales** (CRM/leads/billing), **Comms** (messages/contacts/phone), **Admin/AI** (ARIA, settings). Driven by the Phase 1 nav config.
- Enforce one shared **app layout shell** (sidebar + topbar + content) so every page is consistent.
- Every data view gets explicit **loading, empty, and error** states. No blank flashes, no infinite spinners.
- Consistent table/card/button primitives across modules.

**STOP. Report the new IA and a screenshot list. Wait for go.**

---

## PHASE 6 — Production readiness

- Central error handling on Express (typed error responses, no stack traces to client) and a React error boundary per route.
- Structured request logging with a correlation id; redact secrets.
- `/healthz` endpoint checking DB + MeshCentral reachability.
- README section: required Replit Secrets, MeshCentral config flags (`AllowLoginToken`, `allowFraming`), and run/deploy steps.

**STOP. Final report + deploy checklist.**

---

### Reminders to the Agent
- One phase at a time. Stop and wait between each.
- If you're about to add a dependency, name it and why in the report first.
- If something in the audit contradicts these instructions, surface it — don't silently "fix" it.
