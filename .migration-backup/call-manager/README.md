# CSD Call Manager

Internal call tracking and management system for **Computer Systems Depot Inc.** — Miramar, FL.

Built with: Node.js 20 + Express + TypeScript (backend), React 18 + Vite + Tailwind CSS (frontend), Supabase (Postgres / Auth / Storage), Twilio Voice API.

---

## Environment Variables

### Server (`call-manager/.env`)

| Variable | Description |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account SID (starts with `AC`) |
| `TWILIO_AUTH_TOKEN` | Twilio auth token (used for webhook signature verification) |
| `TWILIO_PHONE_NUMBER` | CSD Twilio number: `+19546377300` |
| `TWILIO_OWNER_FORWARD_NUMBER` | Owner's mobile for Phase 1 call forwarding |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only** service role key (bypasses RLS) |
| `PUBLIC_BASE_URL` | Full public URL of this Replit VM, e.g. `https://abc123.repl.co` |
| `SESSION_SECRET` | Random string for session signing |
| `PORT` | Server port (default: `3000`) |

### Client (`call-manager/client/.env`)

| Variable | Description |
|---|---|
| `VITE_SUPABASE_URL` | Same as `SUPABASE_URL` above |
| `VITE_SUPABASE_ANON_KEY` | Same as `SUPABASE_ANON_KEY` above |

---

## Setup Steps

### 1. Supabase Setup

1. Create a new Supabase project at [supabase.com](https://supabase.com).
2. In **SQL Editor**, run `migrations/001_initial_schema.sql` in full.
3. Create the first owner auth user:
   - Go to **Authentication → Users → Add user** (email: `owner@csd.local`, password: `ChangeMe2025!`).
   - Copy the UUID shown.
   - Run `migrations/002_seed_owner.sql` in the SQL editor (it auto-detects the user by email).
4. Create the storage bucket:
   - Go to **Storage → New bucket**: name `call-recordings`, **private** (uncheck public).
5. Copy project URL, anon key, and service role key from **Settings → API**.

### 2. Twilio Setup

1. Log into [twilio.com/console](https://www.twilio.com/console).
2. Confirm `+19546377300` is your active number.
3. Set webhook URLs (see below).
4. Make sure the number has **Voice** capability enabled.

### 3. Local / Replit Setup

```bash
# From call-manager/ directory
cp .env.example .env          # fill in server env vars
cp client/.env.example client/.env    # fill in client env vars

npm run install:all           # install all dependencies
npm run dev                   # start both server (port 3000) and client (port 5173)
```

For production on Replit Reserved VM:
```bash
npm run build     # builds client/dist and server/dist
npm run start     # serves everything on port 3000
```

---

## Twilio Console Configuration

After deploying to your Reserved VM, configure these URLs in the Twilio console:

Navigate to: **Phone Numbers → Manage → Active Numbers → +19546377300 → Voice & Fax**

| Setting | Value |
|---|---|
| **A CALL COMES IN** (Voice) | `https://<your-vm-url>/webhooks/voice/incoming` — HTTP POST |
| **CALL STATUS CHANGES** | `https://<your-vm-url>/webhooks/voice/status` — HTTP POST |

> The gather, recording, and no-answer webhooks are set dynamically in TwiML — no manual config needed for those.

---

## Inviting the First Owner User

1. Go to Supabase **Authentication → Users → Add user** (email: `owner@csd.local`, password: `ChangeMe2025!`).
2. The trigger creates a `viewer` row automatically.
3. Run `migrations/002_seed_owner.sql` to upgrade it to `owner`.
4. Log in at `https://<your-vm-url>/login` with those credentials.
5. Change the password immediately in **Settings**.

To invite additional users: log in as owner → go to `/users` → use the **Invite** form. Supabase sends a magic-link email.

---

## First Call Test Runbook (5 Steps)

**Prerequisites:** App deployed, Twilio webhooks configured, owner account created.

1. **Dial CSD** — From any phone, call `+1 (954) 637-7300`. You should hear the consent disclosure: *"This call may be recorded for quality and training purposes."*

2. **Navigate the IVR** — Press `2` (New service request). You should hear *"Please hold while we connect your call."* The owner's mobile should ring within seconds.

3. **Verify the call appears** — Log in to the CSD Call Manager at `https://<your-vm-url>`. On the Dashboard, you should see the call appear in the Recent Calls table with status `in-progress` or `completed`.

4. **Check the recording** — After the call ends (~30–60 seconds for Twilio to process), open the call detail page. The recording player should appear. Click play to confirm dual-channel audio.

5. **Tag and save** — Add a customer name, select the `new-service` disposition tag, and click **Save Changes**. Verify the audit trail shows the `call_updated` event.

---

## Phase 2 — Advanced Routing, Full IVR, Analytics

Phase 2 adds business hours, holidays, a database-driven IVR builder, call queues,
voicemail with transcription, and an analytics dashboard — without changing any
Phase 1 webhook URLs.

### Apply the Phase 2 schema

In Supabase SQL editor, run **in this order**:

1. `migrations/003_phase2_schema.sql` — tables, enums, RLS policies
2. `migrations/004_phase2_seed.sql` — defaults: Mon–Fri 9–6 ET hours, an `open` IVR
   matching Phase 1 verbatim, an empty `closed` after-hours voicemail menu, and a
   `tech_main` queue with no members. Safe to re-run.

The seed leaves Phase 1 behavior unchanged: until you edit anything in `/admin/ivr`,
inbound calls during business hours hit the same 4-digit menu and forward to the
owner mobile exactly like before.

### Install Phase 2 client dependency

`recharts` is added to `client/package.json` for the analytics charts. Run:

```bash
npm run install:all      # from call-manager/
```

### New admin pages (owner-only)

| Route | What it does |
|---|---|
| `/admin/hours` | Edit weekly business hours (Mon–Sun, per-day open/close, single timezone) and add/remove holidays. |
| `/admin/ivr`   | Visual IVR builder. Create menus, edit greeting text or audio URL, set timeout, mark default-per-state, add digit options with actions: `forward`, `voicemail`, `submenu`, `queue`, `hangup`. Use `OWNER_FORWARD` as the target on a forward action to use the `TWILIO_OWNER_FORWARD_NUMBER` env var. |
| `/admin/queues`| Create call queues, set `ring_all` / `round_robin` / `least_recent` strategy, max wait, on-timeout action, and add tech members (must have a phone number set in Settings). |

### New shared pages

| Route | What it does |
|---|---|
| `/voicemails` | List voicemails newest-first. Plays audio inline, shows transcription, mark-as-listened (auto-marked on play). Filter to unlistened only. |
| `/analytics`  | Date range picker, KPI cards, calls-per-day stacked bar, hour-of-day line, IVR pie, top inbound numbers, and an owner-only tech performance table. Export CSV button respects the date filter. |

### How webhooks decide which IVR to play

`POST /webhooks/voice/incoming` (URL unchanged) now:

1. Inserts the call row and plays the Florida consent disclosure (unchanged).
2. Calls `getCurrentBusinessHoursState()` which checks today's `holidays` row first,
   then the `business_hours` row for the current weekday in the configured timezone.
3. Looks up the `ivr_menus` row where `is_default = true AND business_hours_state = <open|closed>`.
4. Redirects the caller to `POST /webhooks/voice/menu/:menuId`, which renders the
   menu's `<Gather>` (or drops straight to `<Record>` if the menu has a single
   voicemail option).
5. `POST /webhooks/voice/menu/:menuId/select` reads the digit, persists the
   selection on `calls.ivr_selection`, and executes the option's action.

Voicemails are recorded with `transcribe="true"`. Twilio posts the transcription to
`POST /webhooks/voice/transcription`, which fills in `voicemails.transcription`.

### Phase 2 API endpoints (all under `/api`)

| Method | Path | Auth |
|---|---|---|
| `GET / PUT` | `/admin/business-hours` | owner |
| `GET / POST / DELETE` | `/admin/holidays[/:id]` | owner |
| `GET / POST / PATCH / DELETE` | `/admin/ivr-menus[/:id]` | owner |
| `POST / PATCH / DELETE` | `/admin/ivr-options[/:id]` | owner |
| `GET / POST / PATCH / DELETE` | `/admin/queues[/:id]` | owner |
| `POST / DELETE` | `/admin/queues/:id/members[/:userId]` | owner |
| `GET` | `/voicemails` | any auth |
| `PATCH` | `/voicemails/:id` | any auth |
| `GET` | `/analytics/summary` | any auth |
| `GET` | `/analytics/timeseries` | any auth |
| `GET` | `/analytics/ivr-distribution` | any auth |
| `GET` | `/analytics/top-numbers` | any auth |
| `GET` | `/analytics/tech-performance` | **owner** |
| `GET` | `/analytics/export.csv` | any auth |

### Phase 2 Test Runbook

Prerequisites: migrations 001–004 applied, `tech_main` queue exists, owner logged in,
Twilio webhooks already pointed at `/webhooks/voice/incoming`.

**Re-run Phase 1 first.** Make a normal business-hours call to confirm the seed
preserves the original 4-digit IVR forwarding to the owner mobile.

**Test 1 — Business hours routing.**
1. In `/admin/hours`, set today's weekday open=now-1h, close=now+1h. Save.
2. Call CSD. You should hit `main_open` and the menu plays. Press a forwarding digit
   and verify the owner mobile rings.
3. In `/admin/hours`, set today's weekday Closed. Save.
4. Call CSD again. You should hit `main_closed` (brief greeting), beep, and be able
   to leave a voicemail. Hang up.
5. Open `/voicemails`. Within ~30 seconds you should see the new entry, and
   transcription should arrive within 1–2 minutes.

**Test 2 — Holiday closes the system.**
1. In `/admin/hours`, restore today's normal hours.
2. Add today's date as a holiday with `closed = true`. Save.
3. Call CSD. Despite open hours, you should hit `main_closed`. Remove the holiday.

**Test 3 — IVR edit applies live.**
1. In `/admin/ivr`, select `main_open`, edit a digit's label or change a forward
   target, hit Save.
2. Call CSD again — the change is reflected on the next call. No redeploy needed.

**Test 4 — Queue distribution.**
1. In `/admin/queues`, open `tech_main`, add 1–2 tech users (each must have a phone
   number set in `/settings`).
2. In `/admin/ivr`, on `main_open`, change one digit's action to `queue` with target
   = `tech_main`. Save.
3. Call CSD and press that digit — Twilio rings the queue members per the chosen
   strategy (`ring_all` rings all simultaneously). On no-answer, the queue's
   `on_timeout_action` kicks in (voicemail by default).

**Test 5 — Voicemails persist listened state.**
1. In `/voicemails`, click play on an item — it auto-marks listened. Untoggle
   "Unlistened only". Mark another back to unlistened. Refresh the page; the state
   persists.

**Test 6 — Analytics charts and date filter.**
1. Go to `/analytics`. Default range is the last 30 days.
2. Verify KPI cards, the calls-per-day bar, IVR pie, and top inbound numbers render
   with real data.
3. Change the date range — all charts refetch. Click Export CSV — file downloads.

**Test 7 — Tech-performance is owner-only.**
1. As `owner`, the Tech Performance table renders at the bottom of `/analytics`.
2. As a `tech` user, the table is hidden and `GET /api/analytics/tech-performance`
   returns 403.

---

## Phase 3 — SMS, Blacklist, DNC, Spam Filter

Phase 3 adds two-way SMS, message templates, an inbound blacklist (blocks
calls and/or SMS), an outbound Do Not Call list, and a Twilio-Lookup-based
spam filter with optional inbound screening. Phase 1 voice/IVR and Phase 2
routing/voicemail/analytics are unchanged.

### ⚠️ A2P 10DLC Registration (REQUIRED for production SMS)

US carriers require all application-to-person SMS traffic on long-codes to be
registered under **A2P 10DLC** before they will reliably deliver. Without
registration, messages may be filtered, rate-limited, or dropped silently.

Before going live with SMS:
1. In the Twilio console, go to **Messaging → Regulatory Compliance → A2P 10DLC**.
2. Register your **Brand** (Computer Systems Depot Inc., EIN, address, etc.).
3. Create a **Campaign** describing the use case (Customer Care / Account
   Notifications). Sample message bodies will be reviewed.
4. Attach the campaign to a **Messaging Service** and add `+19546377300` to it.
5. Wait for approval (typically a few business days).

The app code works in development without this registration — but production
SMS deliverability is **not** guaranteed until the brand and campaign are
approved.

### Apply the Phase 3 schema

In Supabase SQL editor, run `migrations/005_phase3_schema.sql`.

This adds: `messages`, `message_templates`, `blacklist`, `dnc_list`,
`spam_scores`, `app_settings`. It also extends the existing `call_status` enum
(if it exists) with a `'blocked'` value used when an inbound call is rejected
by the blacklist.

### Twilio webhook URLs (Phase 3)

In Twilio console under your messaging service / phone number → Messaging:

| Setting | URL |
|---|---|
| **A MESSAGE COMES IN** | `https://<your-vm-url>/webhooks/sms/incoming` — HTTP POST |
| **STATUS CALLBACK URL** | `https://<your-vm-url>/webhooks/sms/status` — HTTP POST |

Voice webhooks from Phase 1 stay the same; the blacklist and spam-screen
checks happen inside `/webhooks/voice/incoming` before the IVR runs.

### Phase 3 API endpoints (all under `/api`)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/messages` | List threads (grouped by partner number) |
| `GET` | `/messages/thread/:threadKey` | Full conversation + best-known contact |
| `GET` | `/messages/stream` | SSE stream — `message:new`, `message:status` events |
| `POST` | `/messages` | Send SMS (DNC-checked). Body: `{ to_number, body?, template_id?, media_urls? }` |
| `GET/POST/PATCH/DELETE` | `/templates` | Message template CRUD |
| `GET/POST/DELETE` | `/blacklist` | Owner-only writes |
| `GET/POST/DELETE` | `/dnc` | Owner-only writes; `POST /dnc/import` for CSV bulk |
| `POST` | `/spam/check` | `{ phone_number, force? }` — Twilio Lookup v2, cached 24h |
| `GET` | `/spam/recent` | Last 100 cached scores |
| `GET/PUT` | `/spam/settings` | `{ threshold (0-100), screening_enabled }` |

### Phase 3 frontend pages

- `/messages` — threaded SMS view with template picker, real-time SSE updates
- `/admin/templates` — owner-only template editor with `{{customer_name}}` and `{{ticket_number}}` placeholders
- `/admin/blacklist` — owner-only inbound block list
- `/admin/dnc` — owner-only outbound suppression with CSV import
- `/admin/spam` — owner-only screening settings + lookup tester

### How blacklist + spam screening work

`POST /webhooks/voice/incoming` now:

1. Records the call as `ringing` (idempotent — same as before).
2. Checks `blacklist` for the caller's number — if `blocks_calls` is true,
   responds with bare `<Hangup/>`, marks the call `failed` with a
   `Blocked: <reason>` note, and emits a `call_blocked` event.
3. If `app_settings.spam_screening_enabled` is true and the cached
   `spam_scores.score` for the caller is `>= app_settings.spam_threshold`
   (default 70), responds with a `<Gather numDigits=1>` press-any-key
   challenge. On any digit it redirects back to `/webhooks/voice/incoming?screened=1`
   which skips both checks. No input → hang up.
4. Otherwise continues into the normal Phase 2 IVR flow.

The spam check uses cached scores only on the hot path — no live Twilio
Lookup call during call routing. Owners populate the cache from
`/admin/spam` (Check button) or via `POST /api/spam/check`.

### Outbound DNC enforcement

Both `POST /api/calls/outbound` and `POST /api/messages` look up the
target number in `dnc_list` and reject with HTTP 403 + a clear error
message before contacting Twilio.

### Phase 3 Test Runbook

**Prerequisites:** Phase 3 migration applied; Twilio messaging webhooks set
to the URLs above; A2P 10DLC at minimum in *pending* state for dev testing.

**Test 1 — Inbound SMS appears in real time.**
1. From your personal phone, text `Hello CSD` to `+19546377300`.
2. Open `/messages` in two browser tabs as different users.
3. Within a couple seconds the new thread should appear in both tabs without
   refresh, and your message body should be visible.

**Test 2 — Outbound SMS sends and updates status.**
1. Open the new thread, type a reply, click Send.
2. Bubble appears immediately as `queued`.
3. Within a few seconds the bubble status updates to `sent` then `delivered`.

**Test 3 — Templates with placeholders.**
1. As owner, go to `/admin/templates` and create a template:
   `Hi {{customer_name}}, your ticket #{{ticket_number}} is ready.`
2. Make sure the conversation partner has at least one prior call where
   `customer_name` and `ticket_number` are set on `calls`.
3. In the messages page pick the template — the body fills with the raw
   template text. Click Send. The delivered SMS has the placeholders
   resolved against the most recent matching call.

**Test 4 — Blacklist blocks inbound calls.**
1. As owner, add your personal mobile to `/admin/blacklist` (Block calls + SMS).
2. Call `+19546377300` from that number — Twilio should hang up immediately
   (no greeting, no IVR).
3. The call appears in `/calls` with status `failed` and a `Blocked:` note.
4. Text the same number — the inbound message is recorded but is not
   broadcast to the messages page (suppressed for blacklisted senders).

**Test 5 — DNC blocks outbound.**
1. As owner, add a test number to `/admin/dnc`.
2. Try to call that number from `/dial` — receive a 403 with a clear error.
3. Try to text the same number from `/messages` — same 403 with clear error.

**Test 6 — Spam check returns a score.**
1. Go to `/admin/spam`, enter a known good mobile number, click Check —
   expect a low score (typically 0–20).
2. Enter a known VOIP number (or a robocaller) — expect a higher score.
3. Toggle "Enable auto-screening" with threshold 50, save. Place an
   inbound call from the high-scoring number — Twilio plays the
   press-any-key challenge before continuing into the IVR.

**Test 7 — Phase 1 + 2 still work.**
1. Call `+19546377300` from a non-blocked number outside business hours →
   you reach the after-hours voicemail menu (Phase 2 unchanged).
2. Call during business hours → you hear the consent disclosure and the
   Phase 1 4-digit IVR.
3. `/voicemails` and `/analytics` continue to render as before.

---

## Phase 4 — Multi-Tenancy, Email Notifications, Full User Management

Phase 4 adds:

- **Organizations / Partners** — multi-tenancy lite (one root org by default; Partners
  page is hidden from the sidebar unless the signed-in user belongs to more than one org).
- **Email notifications via Resend** with HTML templates and `{{placeholder}}` /
  `{{#section}}…{{/section}}` substitution. Triggers: `missed_call`,
  `voicemail_received`, `daily_digest`, `invitation`, `manual`, `new_customer`.
- **Per-user notification settings** — email/SMS opt-in for missed calls + voicemails,
  optional daily digest, and quiet hours (notifications queued during quiet hours and
  delivered after they end; cross-midnight ranges supported).
- **Daily digest scheduler** that wakes once per minute and sends each user their
  digest at their configured local time. Digest emails include a CAN-SPAM unsubscribe
  link backed by `notification_settings.unsubscribe_token` and a public
  `/unsubscribe/:token` endpoint.
- **Invitations** — invite-by-email with a signed token; the recipient sets a password
  at `/accept-invite?token=…`. Falls back to printing the accept URL in a toast if
  Resend is not configured.
- **Full user management** — invite, deactivate/reactivate, role audit log
  (`role_audit` table populated on every role change with the actor's user id).
- **Integrations & system health page** — live Supabase / Twilio / Email checks
  with a 30-second auto-refresh and Test buttons.
- **Profile page** — full name, phone, timezone, change password.

### Apply the Phase 4 schema

```bash
psql "$DATABASE_URL" -f migrations/006_phase4_schema.sql
```

This creates `organizations`, `org_memberships`, `email_templates`,
`notification_settings`, `notification_log`, `invitations`, and `role_audit`,
seeds a default root organization, backfills every existing user into
`org_memberships`, and inserts starter templates for `missed_call`,
`voicemail_received`, `daily_digest`, and `invitation`.

### Required environment variables (new in Phase 4)

| Variable           | Required | Notes                                                                                  |
| ------------------ | -------- | -------------------------------------------------------------------------------------- |
| `RESEND_API_KEY`   | optional | If unset, all outbound emails are recorded in `notification_log` with `status='suppressed'` and the UI shows a clear "email provider not configured" warning. The app continues to function. |
| `EMAIL_FROM`       | optional | Default `noreply@example.com`. Set this to a verified Resend sender once configured. |
| `APP_BASE_URL`     | optional | Used to build accept-invite and unsubscribe links. Defaults to `http://localhost:5173`. |

### Phase 4 API endpoints (all under `/api` unless noted)

```
GET    /me/organizations                 List orgs the current user belongs to
GET    /organizations                    (owner) List all orgs
POST   /organizations                    (owner) Create org
PATCH  /organizations/:id                (owner) Update org
DELETE /organizations/:id                (owner) Delete (refuses if it has members)
GET    /organizations/:id/members        (owner) List members
POST   /organizations/:id/members        (owner) Add member
DELETE /organizations/:id/members/:uid   (owner) Remove member

GET    /invitations                      (owner) List invitations
POST   /invitations                      (owner) Create + email invite
POST   /invitations/accept               (public) Accept with token + password
DELETE /invitations/:id                  (owner) Revoke

GET    /email-templates                  List templates
POST   /email-templates                  (owner) Create
PATCH  /email-templates/:id              (owner) Update
DELETE /email-templates/:id              (owner) Delete
POST   /email-templates/preview          Render with sample context
POST   /email-templates/:id/test-send    (owner) Test send

GET    /notification-settings            Current user's settings (auto-creates row)
PATCH  /notification-settings            Update settings
POST   /notifications/test               Test dispatch
GET    /notifications/log                Current user's recent notification log

GET    /integrations/health              Supabase + Twilio + Email + last-webhook
POST   /integrations/twilio/test         (owner)
POST   /integrations/email/test          (owner)

PATCH  /users/:id  { is_active: boolean }   (owner) Activate/deactivate
GET    /users/:id/role-audit                (owner) Role change history

GET    /unsubscribe/:token  (public, no /api prefix)   One-click email unsubscribe
```

### Phase 4 frontend pages

- `/admin/partners` — only shown in the sidebar when the user belongs to >1 org.
- `/admin/email-templates` — list / create / edit / delete with live preview and test send.
- `/admin/integrations` — system health dashboard with Test buttons.
- `/notifications` — per-user notification preferences + recent notification log.
- `/profile` — full name, phone, timezone, change password.
- `/accept-invite?token=…` — public invite acceptance form.
- `/users` — extended with deactivate/reactivate column, pending invitations
  panel, and an inline role-audit drawer per user.

### Phase 4 Test Runbook

1. **Apply migration:** `psql "$DATABASE_URL" -f migrations/006_phase4_schema.sql`.
   Verify the four seeded templates exist (`select name, trigger from email_templates`).
2. **Notifications without Resend:** Sign in as the owner, open `/notifications`,
   enable email + SMS for missed calls, click **Test email**. The toast should report
   `1 queued` and the log row should show `status='suppressed'` with no crash.
3. **Notifications with Resend:** Set `RESEND_API_KEY` and `EMAIL_FROM`, restart,
   click **Test email** again — the row should flip to `status='sent'` and the email
   arrives in your inbox.
4. **Quiet hours:** Set quiet hours to a window covering the current minute, then
   trigger a missed call. The notification log row appears with `status='queued'`;
   wait until the window ends and confirm it transitions to `sent`.
5. **Invitations + role audit:** From `/users`, invite a new email. Open the accept
   URL (toast) in another browser, set a password, sign in. Back as owner, change
   the new user's role and click **Audit** on their row — the change is listed with
   timestamp and the actor's email.

## Architecture Notes

- **Twilio webhook signature** is verified on every `/webhooks/*` request using `twilio.validateRequest()`. Invalid signatures return HTTP 403.
- **Florida two-party consent** disclosure plays before any `<Record>` or `record=` attribute in the TwiML — this is hard-coded and not configurable.
- **Recordings** are downloaded from Twilio (MP3) and re-uploaded to Supabase Storage bucket `call-recordings` (private). The frontend receives time-limited signed URLs (1-hour expiry) via the API.
- **Service role key** is used only in the Express backend (`server/src/lib/supabase.ts`). The frontend uses the anon key + user JWT.
- **Rate limiting** on `POST /api/calls/outbound`: 30 calls/minute per user.
- **RLS** is enabled on all tables. The service role key bypasses RLS for webhook operations. All authenticated API endpoints pass the user JWT through to Supabase (or enforce roles in Express middleware).

---

## Phase 5 — VAPI AI Voice Agents

Phase 5 adds AI receptionist (inbound IVR routing to a VAPI assistant) and outbound AI campaigns with hard-coded TCPA + DNC compliance.

### 1. Required Secrets

Add in **Replit → Secrets**:

| Secret | Where to get it |
|---|---|
| `VAPI_API_KEY` | VAPI Dashboard → API Keys → **Public** key (used for SDK calls from server) |
| `VAPI_PRIVATE_KEY` | VAPI Dashboard → API Keys → **Private** key (used as `x-vapi-secret` to verify webhooks) |

Without these the AI pages still work for authoring drafts, but no real call can be placed and webhooks are rejected.

### 2. Apply Migration

In Supabase **SQL Editor**, run `call-manager/migrations/007_phase5_schema.sql` once. It:
- Extends the `ivr_action` enum with `'ai_assistant'`.
- Creates tables: `ai_assistants`, `ai_call_sessions`, `outbound_campaigns`, `campaign_calls`, `callbacks`, `ai_spend_log`.
- Inserts default `app_settings` rows: `ai_daily_cap_cents` (default `2000` = $20), `ai_paused_for_cap` (`false`).
- Enables RLS (owner-only writes, all authenticated reads).
- Seeds a draft assistant called **"CSD Receptionist"**.

### 3. Configure VAPI Webhook

In VAPI Dashboard → Assistant or Org settings → Server URL:

```
https://<your-replit-domain>/webhooks/vapi
```

Set the secret header to the value of `VAPI_PRIVATE_KEY`. The server verifies `x-vapi-secret` on every webhook and rejects mismatched calls.

### 4. Voice & Cost

- **Voices** (configurable per assistant): `jennifer`, `rachel`, `sarah`, `antoni`, `josh`, `adam` (11Labs voices via VAPI default).
- **Models**: `gpt-4o-mini` (cheap, recommended), `gpt-4o`, `claude-3-5-sonnet`.
- **Cost**: typically **$0.05–$0.15 per minute** all-in (Twilio + VAPI + LLM + TTS). Calls are debited to `ai_spend_log` from VAPI's `end-of-call-report` (`cost` is in dollars; we store cents).
- **Daily cap**: defaults to **$20/day**. When exceeded the scheduler immediately pauses every running campaign and emails all owner-role users via the existing notifications pipeline. Cap auto-resets daily at midnight UTC; campaigns must be manually resumed.

### 5. Compliance Guardrails (Hard-coded — Cannot Be Disabled)

| Rule | Enforcement point |
|---|---|
| AI/recording disclosure on every call | `ensureDisclosure()` auto-prepends "This call is being handled by an AI assistant and may be recorded." to `first_message` if missing — applied on both create and update of every assistant. |
| Mandatory `transfer_to_human` tool | `ensureTransferTool()` always re-adds `transfer_to_human` to `tools_enabled`, even if the UI tries to remove it. |
| Mandatory DNC check on outbound | DB `CHECK (dnc_check_enabled = true)` on `outbound_campaigns`; route forces `dnc=true` on insert; `campaignWorker` re-verifies against `dnc_list` before each dial and marks the row `dnc_blocked`. |
| Caller-local 8 am – 9 pm window | `lib/tcpa.ts` derives time zone from NPA (area code) → IANA TZ map and converts "now" to the called party's local time. Out-of-window calls are deferred (status `outside_hours`). Campaign-level window is also clamped to `08:00 – 21:00`. |
| Max 1 call / number / 7 days | `campaignWorker` queries `calls` (`from_number` / `to_number`) for the past 7 days and skips with status `cooldown_blocked` unless the row is flagged `owner_override`. |

### 6. Pages

| Path | Role | Purpose |
|---|---|---|
| `/admin/ai/assistants` | owner | Create / edit / activate VAPI assistants. Place real test calls to your own number. Edit daily spend cap. |
| `/admin/ai/campaigns` | owner | Create outbound campaigns (paste targets `phone[,name]` per line). Start/pause/resume/delete. Per-call status panel shows `dnc_blocked` / `cooldown_blocked` / `outside_hours` reasons. |
| `/ai/sessions` | all authenticated | Search and inspect transcripts, summary, extracted data, outcome and per-call cost. |

### 7. IVR Wiring

In **IVR Builder**, choose action `ai_assistant` on any digit and pick from the dropdown of *active + VAPI-synced* assistants. Inbound calls hitting that digit are bridged via `<Dial><Sip>sip:<vapi_assistant_id>@sip.vapi.ai</Sip></Dial>`, so Twilio call recording and `/voice/status` continue to work unchanged.

### 8. Test Runbook

1. Set `VAPI_API_KEY` + `VAPI_PRIVATE_KEY` and apply migration `007`.
2. Open `/admin/ai/assistants` → edit "CSD Receptionist" → set a sensible system prompt → check **Active** → Save. Verify the row shows **✓ synced** (server pushed the assistant to VAPI on save).
3. Enter your own mobile in the "Test call goes to" field → click **Test call** on the row → answer → confirm the disclosure is the first thing you hear and that saying "transfer me to a human" triggers a transfer.
4. Open `/admin/ai/campaigns` → create a campaign with **only your own phone number** as the target → Start → wait up to 60 s → confirm an outbound dial.
5. After the call ends, open `/ai/sessions` and verify the row shows the transcript, summary, and a non-zero `cost_cents`.
6. Force-test compliance: add your number to the DNC list → re-create a campaign → confirm the row in the per-call panel reads `dnc_blocked` instead of dialing. Then, with the cap set to `1` cent, confirm any new in-flight call pauses all campaigns and the owner receives an email.
