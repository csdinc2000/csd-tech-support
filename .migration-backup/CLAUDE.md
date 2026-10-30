# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Full-stack TypeScript Remote Monitoring and Management (RMM) platform for IT service providers (branded internally as "CSD"). Combines device monitoring, helpdesk ticketing, MeshCentral remote access, a CRM module, a booking platform, and a multi-model AI assistant ("ARIA") behind a single Express server.

## Development Commands

- `npm run dev` — Start dev server with hot reload. Defaults to **port 5000** (set by `PORT` env var; `.replit` pins it to 5000). Express serves both the API and the Vite-built client on the same port.
- `PORT=5001 npm run dev` — Run on 5001; Playwright uses this port.
- `npm run build` — Vite builds the client into `dist/public`; esbuild bundles `server/index.ts` into `dist/index.js`.
- `npm run start` — Production server (serves static assets from `dist/public`).
- `npm run check` — TypeScript type check (`tsc`; `noEmit` is set in `tsconfig.json`).
- `npm run db:push` — Push Drizzle schema changes to the database (no migration files generated; direct push).

### Testing
- `npm test` — The primary unit suite: Node's built-in test runner over `server/__tests__/*.test.ts` (`tsx --test`). Fast, no server or DB needed — tests use dependency-injection seams (e.g. `__setA2PMonitorDepsForTests` in `a2p-monitor.ts`) to stub Twilio/storage/SendGrid. Prefer adding coverage here.
- `npx tsx --test server/__tests__/<file>.test.ts` — Run a single unit test file.
- `npx playwright test` — Runs all E2E tests. `playwright.config.ts` auto-starts `PORT=5001 npm run dev` and reuses an existing server when present.
- `npx playwright test --project chromium` — Single browser (also: `firefox`, `webkit`, `Mobile Chrome`, `Mobile Safari`).
- `npx playwright test tests/<file>.spec.ts` — Single test file.
- `TEST_BASE_URL=http://localhost:5001 node tests/<file>.js` — Standalone Node-based validation scripts under `tests/` (e.g. `simplified-validation.js`, `node-api.test.js`, `final-system-validation.js`). Server must already be running.
- `node tests/run-all-tests.js` — Runs all Node-based suites sequentially.

## Architecture

### Monorepo layout
```
client/              React + Vite frontend
  src/pages/         One file per route (dashboard, devices, tickets, crm-*, aria, etc.)
  src/components/    layout/ (header, sidebar), ui/ (shadcn), aria/, booking/, dashboard/, forms/, advanced/
server/              Express backend (ES modules)
  index.ts           Entry point — asserts required secrets, mounts the raw-body Stripe webhook BEFORE express.json(), sets up auth + a global /api auth gate, then Twilio handlers, runs the boot migration chain, initializes Stripe, then registerRoutes
  security.ts        Boot secret check (assertRequiredSecrets), admin/owner authorization (email allowlist, fails closed), isAdminApiPath/isAdminUser used by the global auth gate
  routes.ts          ~4,400-line monolith holding most API endpoints
  routes/network.ts, routes/helpdesk.ts   Domain routers mounted separately from the routes.ts monolith
  booking/           Booking-platform routes + availability service + seed data
  migrations/        Hand-rolled idempotent migrations applied at boot, named by date (billing, teamviewer, helpdesk, a2p-rejection-suggestions, patch-mgmt, sms-error-code, booking-engine)
  storage.ts         IStorage interface with two impls: MemStorage (in-memory) and DatabaseStorage
  db.ts              Neon serverless Pool + Drizzle client
  replit_integrations/auth   Replit Auth (Google/GitHub OAuth) — must be set up before other routes
  aria-service.ts    Multi-model AI (Claude + OpenAI + Gemini) backing /api/aria
  meshcentral*.ts    MeshCentral integration for remote desktop sessions
  support-codes.ts, remote-support-widget.ts   Remote Support gateway: in-memory 6-digit codes bridging a phone call to a MeshCentral session, plus the self-served customer widget (/remote-support, /support)
  a2p-status.ts, a2p-monitor.ts, a2p-events.ts   Twilio A2P 10DLC compliance: verdict normalizer, background paging monitor, SSE bus to the Messages page
  greeting-store.ts  Replit KV-store helper for the custom voicemail greeting (used because db:push is unavailable — see Database)
  teamviewer.ts      TeamViewer deep-link launcher (alternative remote-access provider — no API key)
  stripeClient.ts, billing-routes.ts, webhookHandlers.ts   Stripe subscription / plan APIs
  twilio*.ts         Twilio call forwarding, tracking, SMS emergency alerts
  emergency-alerts.ts, slack.ts, csd-notifications.ts, google-contacts.ts, google-calendar.ts
  vite.ts            Vite dev middleware + production static serving
shared/
  schema.ts          Single source of truth for DB schema + drizzle-zod insert schemas; re-exports models/auth and booking
  booking.ts, models/auth.ts
tests/               Mix of Playwright .spec.ts and standalone Node validation scripts
meshcentral-data/    Runtime config for the MeshCentral remote-access server
helpdesk-attachments/  Runtime upload dir for helpdesk ticket attachments
attached_assets/     Brand images / static design assets (exposed as @assets/*)
call-manager/        SEPARATE sub-project (own package.json, own server + client). Internal CSD call-tracking app on Supabase + Twilio. NOT wired into the main Express server — do not import across the boundary.
wordpress-plugin/    PHP WordPress plugin (csd-forms.php) that embeds the CSD intake form on the marketing site.
scripts/             post-merge.sh (git hook: re-runs npm install), seed-billing-products.ts
docs/                Design notes for the booking platform and MeshCentral setup
```

### Backend flow
- `server/index.ts` calls `assertRequiredSecrets()` first (fatal exit if `DATABASE_URL`, `SESSION_SECRET`, or `REPL_ID` is missing), then mounts the `/api/stripe/webhook` route with `express.raw()` **before** `express.json()` so the raw body is preserved for Stripe signature verification. Adding any new webhook with HMAC signing must follow the same pattern (declare it before the JSON parser).
- It then calls `setupAuth(app)` + `registerAuthRoutes(app)` (so the session middleware wraps everything), then installs the **global `/api` auth gate**: every `/api` request must have a valid session unless it matches the `isPublicApiRequest()` allowlist (login/callback/logout, the Stripe webhook, booking public surface, portal, `/api/download/*` agent download, `/api/aria/support-chat`). Admin route groups additionally require `isAdminUser` when `isAdminApiPath` matches. **When adding a public (unauthenticated) endpoint, add it to `isPublicApiRequest` in `index.ts` or it will 401.**
- It then registers Twilio forwarding/tracking webhooks and runs the boot migration chain (`applyBillingMigration`, `applyHelpdeskMigration`, `applyA2pRejectionSuggestionsMigration`, `applyPatchMgmtMigration`, `applySmsErrorCodeMigration`, `applyBookingEngineMigration` — each wrapped in try/catch so one failure doesn't block boot), then `initStripe()` (invokes `stripe-replit-sync` to create the `stripe.*` schema/tables and backfill products + prices in the background), then calls `registerRoutes(app)`.
- `registerRoutes` (in `routes.ts`) calls `registerBillingRoutes(app)`, mounts API endpoints inline plus the separate `network` and `helpdesk` routers, ARIA, booking, and seeding helpers, and starts the A2P background monitor (`startA2PMonitor()`). Auth is already set up by `index.ts` before this runs.
- In development, after API routes are mounted, `setupVite(app, server)` attaches Vite as Express middleware so HMR works on the same port as the API. In production, `serveStatic(app)` serves the prebuilt `dist/public`.
- Server always binds `0.0.0.0:${PORT||5000}` with `reusePort: true`.

### Storage layer
`server/storage.ts` exports a singleton `storage` typed as `IStorage`, with `MemStorage` and `DatabaseStorage` implementations. Routes call `storage.getDevices()`, etc., and never touch Drizzle directly. If you add a new entity, extend `IStorage`, implement it on both classes, and add the table + insert schema to `shared/schema.ts`.

### Frontend routing
`client/src/App.tsx` splits the app into two route groups:
- **Public** (no layout): `/intake`, `/start-service`, `/embed` — used for the customer intake form and embeddable widget.
- **Admin** (wrapped in `<Layout>` with `<Header>`, `<Sidebar>`, and the floating `<AriaWidget>`): everything else — dashboard, devices, tickets, remote-access, automation (+ automation-hub), patches, monitoring, reports, clients, network-discovery, `/admin/*`, `/crm/*`, `/service-logs`, `/aria`, `/helpdesk-admin`, `/customer-portal`, `/client-portal`, `/csd-admin`, `/messages`, `/call-tracking`, `/phone-settings`, `/billing`.

When adding a page, add a `<Route>` in the appropriate group and a sidebar entry in `components/layout/sidebar.tsx`.

### Path aliases
Defined in **both** `tsconfig.json` and `vite.config.ts` — keep them in sync:
- `@/*` → `client/src/*` (tsconfig + vite)
- `@shared/*` → `shared/*` (tsconfig + vite)
- `@assets/*` → `attached_assets/*` (**vite only** — not in tsconfig)

### Database
- Drizzle ORM against PostgreSQL (Neon serverless via `@neondatabase/serverless` with the `ws` constructor).
- Requires `DATABASE_URL` to start (both `server/db.ts` and `drizzle.config.ts` throw if missing).
- `npm run db:push` is the intended way to sync `shared/schema.ts` — there are no Drizzle-generated migration files. **In practice `db:push` is unavailable in the running repl** (noted throughout the code), which is why several features avoid new columns entirely: hand-rolled boot migrations (`server/migrations/`), the Replit KV store for voicemail greeting audio (`greeting-store.ts`), and in-memory state for support codes (`support-codes.ts`). Prefer these existing patterns over assuming a schema push will work.
- The boot migrations under `server/migrations/` are hand-written idempotent SQL applied at startup (see the list under the layout tree). Add to this dir when a schema change is needed but `db:push` can't be run — e.g. billing columns on `users`, TeamViewer ID on `devices`, the osTicket-style helpdesk extension (`ticket_*` tables), patch-management, the SMS `error_code` column, and the booking engine v2 tables.
- Stripe also owns its own `stripe.*` schema, created and populated by the `stripe-replit-sync` package — do not edit those tables; query them read-only (see `billing-routes.ts` for the `stripe.products` / `stripe.prices` join pattern).
- Schema re-exports `./models/auth` (Replit Auth sessions/users) and `./booking` (booking platform tables) from `shared/schema.ts`.

### Key modules / data domains
- **RMM core**: `devices`, `alerts`, `tickets`, `clients`, `remote_access_sessions`, `automation_scripts`, `network_scans`, `service_logs`.
- **Helpdesk (osTicket-style)**: layered on top of `tickets` via the helpdesk migration. Tickets carry `ticket_number`, `access_token` (guest portal), `requester_*` fields, `department_id`, `team_id`, `help_topic_id`, `sla_plan_id`, SLA timestamps, `locked_by`/`locked_at` (agent-collision lock). Related tables: `ticket_departments`, `ticket_teams`, `ticket_help_topics`, `ticket_sla_plans`, `ticket_messages` (threaded replies), `ticket_activity`, `ticket_attachments` (stored under `helpdesk-attachments/`), `ticket_canned_responses`, `ticket_email_templates`, `ticket_filters`, `ticket_settings`. Routes in `server/routes/helpdesk.ts`; email side in `server/helpdesk-email.ts`. Admin UI at `/helpdesk-admin`, customer-facing portal at `/customer-portal`.
- **CRM**: `crm_contacts` (Google People API sync via `googleContactId`), `crm_leads` (pipeline stages New→Contacted→Qualified→Quoted→Won/Lost), `crm_jobs` (job numbers `CSD-2025-XXXX`), `crm_interactions`.
- **CSD intake**: public `/intake` form → creates linked Contact + Lead + Interaction in one submission, sends notification email via `csd-notifications.ts`.
- **Booking**: resources/services/availability/appointments in `shared/booking.ts`, routes in `server/booking/`.
- **ARIA**: full page at `/aria` + floating widget on every admin page. Backed by `server/aria-service.ts` which fans out to Anthropic, OpenAI, and Gemini SDKs. TTS uses OpenAI's API with browser SpeechSynthesis as fallback (`/api/aria/tts`, `/api/aria/tts/status`).
- **Telephony**: Twilio webhooks for call forwarding (`twilio-forwarding.ts`) and call tracking/log (`twilio-tracking.ts`) — registered in `server/index.ts` before the main router. Settings + call-log persistence in `twilio-settings-storage.ts` / `twilio-tracking-storage.ts`. SMS emergency alerts go through `emergency-alerts.ts`. UI: `/call-tracking`, `/phone-settings`, `/messages` (inbound/outbound SMS thread view).
- **Billing & plans**: Stripe subscription management exposed on `/billing`. `server/billing-routes.ts` reads plan/price data from the synced `stripe.*` tables, and `server/webhookHandlers.ts` processes incoming Stripe events (signature verified against `STRIPE_WEBHOOK_SECRET` via the raw-body route in `server/index.ts`). Customer-ID is lazily created and persisted to `authUsers.stripeCustomerId`.
- **Remote access**: two providers — MeshCentral (full agent-based session, default) and TeamViewer (deep-link launcher via `server/teamviewer.ts`; requires a tech-side TeamViewer install but no API key). Both write rows to `remote_access_sessions` with a `provider` discriminator.
- **Remote Support gateway**: bridges a phone call to a live MeshCentral session without an agent installer. A technician calls `POST /api/support/generate-code` (authenticated) to mint a short-lived, single-use 6-digit code (in-memory, 10-min TTL, per-IP redeem throttle — `server/support-codes.ts`), reads it to the customer, who enters it into the Remote Support widget served same-origin at `/remote-support` and `/support` (`server/remote-support-widget.ts`, an HTML string bundled to survive esbuild). The widget calls `POST /api/support/redeem-code` (public) → MeshCentral redirect on `remote.computersystemsdepot.com`. The widget is iframe-embedded into the WordPress marketing site via the `[csd_remote_support]` shortcode. A separate public website chatbot lives at `POST /api/aria/support-chat`.
- **A2P 10DLC compliance**: `server/a2p-status.ts` normalizes Twilio brand + campaign state into one verdict (`not_registered`/`pending`/`approved`/`rejected`/`failed`). `server/a2p-monitor.ts` polls it on a schedule (`startA2PMonitor()` from `registerRoutes`), pages the owner via SendGrid on persistent rejection/lookup-failure (with re-alert cooldown and a 2-in-a-row threshold), and supports snooze + incident history; its state persists to `.local/a2p-monitor-state.json`. `server/a2p-events.ts` is an in-process SSE bus that pushes status changes to the Messages page immediately. Endpoints under `/api/twilio/a2p/*`; snooze mutations require `requireOwner`. Tests stub Twilio/storage/SendGrid via `__setA2PMonitorDepsForTests`.
- **Authorization**: beyond the global `/api` session gate, admin status comes from an email allowlist (`ADMIN_EMAILS`, comma-separated, falling back to `CSD_ADMIN_EMAIL`) in `server/security.ts`, and **fails closed** — an empty allowlist grants admin to no one. `isAdminApiPath` marks the admin route groups (mesh, billing, call-tracking, Twilio settings). Owner-only actions use a `requireOwner` middleware.

### External services and required env vars
- Required to boot (`assertRequiredSecrets` exits otherwise): `DATABASE_URL` (PostgreSQL), `SESSION_SECRET`, `REPL_ID`.
- `ADMIN_EMAILS` (or `CSD_ADMIN_EMAIL`) — admin allowlist; `A2P_ALERT_EMAIL` (or `CSD_ADMIN_EMAIL`) — A2P paging recipient / owner check.
- MeshCentral — bundled as a dependency; data persisted under `meshcentral-data/`. Remote Support redirects resolve from `MESHCENTRAL_URL`.
- Twilio (call forwarding + SMS): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, plus the configured Twilio number.
- Stripe: managed via the Replit Stripe connector (`isStripeConfigured()` gates all billing code paths, so it degrades cleanly when unconfigured). The webhook secret is wired up automatically by `stripe-replit-sync.findOrCreateManagedWebhook` against `REPLIT_DOMAINS`.
- SendGrid (email notifications), Slack Web API (team alerts), OpenAI / Anthropic / Google Generative AI (ARIA), Google OAuth (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — used by Google Contacts and Google Calendar sync).

### 7-Gate Diagnostic Framework
Helpdesk tickets carry structured diagnostic fields modelled on this sequence — when editing ticket forms/schema, keep these gates aligned:
1. Environment Recon → 2. Resource Exhaustion → 3. Threat Perimeter → 4. Thermal/Power Audit → 5. Optimization Strike → 6. Resilience Test → 7. Secure Handover.
Detailed per-action records live in `service_logs` and are surfaced on the Service Logs page.

## Deployment

- `.replit` configures Replit autoscale deployment (`build`/`run` map to `npm run build`/`npm run start`); local port 5000 maps to external 80, local 5001 to external 3000.
- `Dockerfile` + `fly.toml` are present for Fly.io deployment as an alternative.
