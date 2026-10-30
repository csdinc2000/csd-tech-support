---
name: Twilio recording & SMS quirks
description: Non-obvious Twilio behaviors behind "voicemail not working" and "SMS not sending" reports in this app.
---

# Twilio quirks (CSD app)

## "absent" recordings = no audio, not a server error
When a caller hangs up without speaking, Twilio's `<Record action=...>` callback still fires and creates a Recording resource, but with `status: "absent"`, `duration: -1` (or RecordingDuration 0).
- The recording `.json` resource returns **200** (it exists), but the media (`.mp3`/`.wav`) returns **404** (code 16101).
- **Do not** treat that media 404 as a 502/server failure. The voicemail-saved webhook now skips persisting when `duration <= 0`, and the audio proxy maps upstream 404 → 404.

**Why:** users reported "voicemail / page not working (502)" — it was just empty recordings the proxy surfaced as 502.

## SMS "default" sentinel → Twilio error 21612
The call-tracking SMS UI uses a `<SelectItem value="default">` ("Default Twilio number"). Sending `from: "default"` literally is truthy, so it bypassed the `from || getDefault()` fallback and Twilio rejected it with **21612** (From "(default)"). Always treat the `"default"` string (and empty) as "use the connector's default number".

## SMS undelivered with error 30005 = A2P 10DLC, not a code bug
Outbound US SMS landing as `undelivered` with `error_code: 30005` ("Unknown destination handset") across many different destinations is carrier-level **A2P 10DLC** rejection of unregistered traffic. This is an account-registration issue (register Brand+Campaign in Twilio Console) — **not fixable in code**.

## After publishing, the Twilio number webhooks still point at the DEV preview
The Twilio number's VoiceUrl/SmsUrl/StatusCallback can be left pointing at the `*.janeway.replit.dev` dev preview (set by a manual sync from the editor). The dev URL only responds while the editor/dev workflow is up, so on the live app **inbound calls just hang up** and inbound texts vanish. Fix: repoint the number to the production domain (`https://support.computersystemsdepot.com/webhooks/...`). The app only writes webhooks via explicit endpoints (`/api/twilio/sync-webhooks`, call-tracking sync) — never on startup — so running dev won't auto-clobber, but clicking a "sync webhooks" button *from the preview* will repoint it back to dev.

**Why:** "customers call and it just hangs up" on the published app traced to the number's webhook host being the dev preview, not production.

## Storing Twilio-playable config without a Postgres column
`db:push` is broken in this repl, so to add the custom voicemail-greeting audio we store the bytes (base64) in the **Replit key-value store** (`server/greeting-store.ts`) and serve them from a **public** webhook `GET /webhooks/voice/greeting-audio` so Twilio `<Play>` can fetch them. The voicemail flow plays the upload when present, else falls back to `<Say>` with the configured voice/text. Keep greeting uploads small (~1.5 MB) — KV stores the whole value in one key.

**Why:** user wanted to upload their own greeting; no new DB column was possible. Same pattern fits any future per-account binary that Twilio must fetch by URL.

## A2P campaign text is a contract — the app must actually do what it claims
The campaign registration's messageFlow field commits to checkable facts: the intake form's consent checkbox must show the exact first-person "I agree..." string quoted in the campaign (vetter compares verbatim — render the shared `SMS_CONSENT_TEXT` constant, never paraphrase in JSX), and every opt-in path described (web form AND texting START) must fire an immediate automated confirmation identifying the business and restating STOP/HELP. START/HELP keyword replies are handled explicitly in the inbound SMS webhook (not gated on the optional auto-reply setting), and the web-form confirmation is not gated on the optional thank-you-SMS setting. Keyword texts must still forward to the owner like any other inbound. STOP gets no app reply — Twilio enforces opt-out at carrier level.

**Why:** an A2P vetter rejected the draft because the quoted "checkbox label" was third-person policy text, and the flow described a START confirmation that wasn't wired up.

## Polly neural voices fix the "robotic" greeting
Twilio `<Say>` voices like `Polly.Joanna` are the *standard* (robotic) Polly voices. Append `-Neural` (e.g. `Polly.Joanna-Neural`, `Polly.Danielle-Neural`) for natural, human-sounding speech. The settings UI offers neural voices first; stored defaults are neural.

## Replit Twilio connector field mislabeling
`listConnections('twilio')[0].settings.account_sid` can contain a **Phone Number SID (`PN...`)** instead of an Account SID (`AC...`). Auth still works via `api_key`/`api_key_secret` (account-scoped), but don't trust that field as the account SID. `getCredentials()` in `server/twilio.ts` prefers a `TWILIO_ACCOUNT_SID` env override when it starts with `AC`.

## "Calls don't ring my cell" = business-hours/after-hours routing, and prod settings != dev
Inbound voice routing is data-driven from the single-row `twilio_settings` (read at request time), NOT code. If `business_hours_enabled` is on, any call outside `business_hours_start..end` on `business_hours_days` (CSV, 1=Mon..7=Sun; default Mon–Fri so **weekends are after-hours**) takes `after_hours_action`. With that = `voicemail`, callers hit voicemail and the cell never rings even though forwarding is enabled and the target number is correct.

**Critical:** the published app uses a **separate production database** from dev, so these settings differ per environment. Diagnose with a read-only prod query (`executeSql({environment:"production"})`), not the dev DB. Schema-default changes (e.g. flipping `after_hours_action` default to `forward`) only affect NEW rows — they do NOT change the existing singleton prod row; the live fix must be made in the app's Phone Settings UI on the published site.

**Why:** "calls not going to my cell" on a Saturday traced to prod `business_hours_enabled=true` + Mon–Fri days + `after_hours_action=voicemail`; dev DB showed business hours off, masking it.
