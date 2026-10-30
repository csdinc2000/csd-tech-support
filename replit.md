# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Authentication: Replit-managed Clerk with cookie-based browser sessions; local
  `auth_users.id` remains the legacy identity bridge and is JIT provisioned.
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- Technician board (`/dashboard`, three columns: active jobs by status | daily schedule + calendar | service requests + call log; every row opens one shared detail dialog):
  - Client: `artifacts/csd-rmm-crm/src/components/dashboard/tech-board/` (`tech-board.tsx` composes the columns; `detail-dialog.tsx` renders job / appointment / intake / call records). `pages/dashboard.tsx` is a thin wrapper that resolves the `communications` feature for the call log. The previous RMM overview lives on at `/dashboard/rmm` (`pages/rmm-dashboard.tsx`).
  - Server: `GET /api/booking/appointments?from&to&status` in `api-server/src/booking/booking-routes.ts` (staff-only, assignment-scoped, joins the service name). Other columns reuse `/api/crm/jobs`, `/api/intake`, `/api/call-tracking/calls`.
  - Above the columns: `board-stats.tsx` (counts derived from the already-loaded board data, each tile links to where you act on it) and `quick-links.tsx` (pinned chips + "All links" drawer).
  - Tests: `tests/tech-board.spec.ts` (+ fixture) in the client, `booking-appointments.routes.integration.test.ts` in the server.
- Tech support link catalog: `src/lib/tech-support-links.ts` — one list of technician pages with their staff-feature gate, shared by the board quick links and the Training Portal. Add new tech pages here. Tech Tools accepts `?tab=<id>` to deep-link a tool.
- Training Portal (`/training`, any approved staff member; no feature gate): `pages/training.tsx` (`TrainingPortalView` is provider-free for tests), curriculum content in `src/lib/training-curriculum.ts`. Lesson progress is per user in browser `localStorage` (`csd:training-progress:<clerkUserId>`), not server-side. Tests: `tests/training-portal.spec.ts` (+ fixture).
- Shared team inbox + single main number (Communications → Messages):
  - Server: `api-server/src/shared-inbox.ts` (conversation state, timeline, `#code` relay, team mirrors; routes `/api/sms/inbox*`, gated by `communications`), tables in `migrations/2026-10-30-shared-inbox.ts` (`sms_conversations`, `_reads`, `_notes`, plus `sms_messages.sent_by_*` written by raw SQL after send). Inbound wiring in `twilio-forwarding.ts` `handleInboundSms` (reopen + `#code` on forwards + relay) and the whisper (CRM name to the tech).
  - Client: `components/communications/shared-inbox.tsx`, mounted by `pages/messages.tsx`. Tests: `shared-inbox.test.ts` / `shared-inbox.integration.test.ts` (server), `tests/shared-inbox.spec.ts` (client).
- Community Marketplace (customer buy/sell listings):
  - Server: `artifacts/api-server/src/marketplace.ts` (public `/api/portal/marketplace/*`, staff `/api/marketplace/*`), tables in `migrations/2026-09-16-marketplace.ts`, tests in `marketplace.routes.integration.test.ts`.
  - Client: `artifacts/csd-rmm-crm/src/pages/marketplace-*.tsx` (public browse / listing / sell / manage, staff admin at `/marketplace`), shared pieces in `src/components/marketplace/` and `src/lib/marketplace.ts`.
  - CyberScan (photo / model-number → auto-filled listing): server `marketplace-scan.ts` (regex parser + Claude vision/text readers, `POST /api/portal/marketplace/scan` and `/scan/lookup`), client `components/marketplace/cyber-scan.tsx`. Tests: `marketplace-scan.test.ts` (parser), route test, `tests/marketplace-scan.spec.ts` (browser).

- Voice intake (spoken assistant on the public repair intake form, `/intake` and `/embed`; hidden on the staff CRM dashboard via `voiceIntake={false}`):
  - Client: `components/forms/voice-intake-panel.tsx` (UI + turn loop), `lib/voice-intake.ts` (pure step/parsing logic, unit-tested), `hooks/use-intake-speech.ts` (Web Speech API). Shared field rules live in `components/forms/csd-intake-schema.ts`.
  - Server: `api-server/src/voice-intake.ts` — public `GET /api/portal/voice-intake/status`, `POST /api/portal/voice-intake/interpret` (Claude structured output, sanitized to the form's options; writes nothing). Submission is the normal `POST /api/intake` with `intake_channel: "voice"`.
  - Tests: `voice-intake.test.ts` (server), `src/lib/voice-intake.test.ts` and `tests/voice-intake.spec.ts` (client).

## Architecture decisions

- One customer-facing number: every staff text (`/api/sms/send`, legacy `/api/call-tracking/sms/send`) goes out from the business line; a `from` tracking number is ignored. Tracking numbers stay for attribution only. Click-to-call already bridges from the main line.
- Reply-by-text relay: forwards to staff cells start with `#<conversationId>`; a forwarding phone texting `#12 message` to the main line relays it to that customer from the main line. It only relays if that phone was sent a forward/mirror for that customer in the last 14 days (`sms_forward_deliveries`), and only when Twilio signatures are verified (same trust rule as staff SMS commands). Texts to/from staff, alert and forwarding phones are internal and never become inbox conversations.
- Marketplace sellers have no accounts: each listing gets a secret manage link (`/portal/marketplace/manage/<token>`, sha256 hash stored) emailed to the seller — same model as contract signing links. Buyers reach sellers through a relay form; seller email is never exposed publicly.
- Marketplace photos are stored as `bytea` in Postgres (`marketplace_images`) after client-side resize to 1024px JPEG stepped down in quality (then size, to a 640px floor) until ≤160 KB (`compressPhoto` in `src/lib/marketplace.ts`; 8 per listing max). The sell form has a `capture="environment"` input so phones open the camera directly. Chosen because deployments run on autoscale (ephemeral disk) and no object-storage bucket is configured; move to Replit Object Storage / R2 if the table grows past a few GB.
- Customer device photos reuse the marketplace storage approach (`bytea`, client-side `compressPhoto`, `capture="environment"`). The intake form's optional photo is kept in `csd_intake_device_photos` and fills `client_avatars` only when the account has no avatar yet, so anonymous intake never replaces a staff photo. Technicians replace or remove it from the avatar on the customer page (`PUT/DELETE /api/clients/:id/avatar`). Code: `api-server/src/customer-photos.ts`, client `components/customers/customer-avatar.tsx` and `components/forms/device-photo-field.tsx`.
- Portal-submitted listings start `pending` and must be approved by staff (`marketplace` feature); staff-posted listings go live immediately. Staff-posted listings carry `verified: true` publicly ("Rig verified" badge).
- The customer-facing marketplace is dark ("cyber" theme: zinc-950 canvas, red accents — utilities at the bottom of `src/index.css`, scoped under `.cyber`). `MarketplaceShell` toggles `.dark` on `<html>` while mounted so shadcn portals match. The staff admin page stays light and wraps shared marketplace components in a `.cyber` preview panel.
- Sell page uses `ListingForm layout="funnel"` (Identify → Details → Launch); edit/staff screens use the flat layout. CyberScan only *suggests*: it fills empty title/category/description and always updates specs; fields it touched carry `data-synced` until edited.
- CyberScan needs `ANTHROPIC_API_KEY` (model via `MARKETPLACE_SCAN_MODEL`, default `claude-opus-5`; lookup effort via `MARKETPLACE_SCAN_EFFORT`, default `low` — quality held up in live checks, ~8–18 s per lookup). Without a key the photo option hides and the model-number lookup falls back to regex only. Model-number lookups may run up to 3 web searches (`web_search_20260209`) to ground unfamiliar product numbers and current used prices; set `MARKETPLACE_SCAN_WEB_SEARCH=0` to disable. Detected lookups are cached in-process for 24 h (500 entries). Scans are rate-limited 20 / 10 min per IP.
- Voice intake never submits or ticks SMS consent on its own: the AI only suggests field values, the browser writes them into the same react-hook-form instance as manual entry, and submission needs an explicit spoken "yes" to "Shall I submit?" (or the Approve button). Voice requests are tagged `csd_intake_records.campaign = 'voice_intake'` (that column was otherwise unused) plus a line in the intake interaction; `crm_leads.source` is untouched so Leads filters keep working. `/api/intake` now also returns `ticket: { number } | null`.
- Voice intake AI needs `ANTHROPIC_API_KEY` (model `VOICE_INTAKE_MODEL`, default `claude-opus-5-5`; effort `VOICE_INTAKE_EFFORT`, default `low`). Without a key, or if the customer picks basic mode, a rule-based parser in `lib/voice-intake.ts` is used. Utterances are never logged or stored; card-like digit runs are rejected before reaching the model. Rate limit 80 / 10 min per IP.
- Lookup results carry `summary`, `releaseYear`, `pricing {low, high, basis}` (used private-party USD) and `candidates[]` (factory configs when the code doesn't pin one). The form auto-suggests the mid-range asking price only if the price field is empty; the seller picks a candidate to fill specs.

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Adding a staff feature means touching `staff-access.ts` (server), `use-admin-access.ts`, `staff-access.tsx`, `staff-access-history.ts`, `security.ts` (path gate) and the `features` fixture in `tests/staff-access-concurrency.spec.ts`.
- The vite dev server has no `/api` proxy — the Replit router forwards `/api` to port 5000. Browser tests that hit the API must `page.route("**/api/**")` to port 5000 or mock it.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
