---
name: Business-line call answering
description: The CSD tracking greeting, ordered backups, explicit technician acceptance, and event-text policy.
---

The main business line must answer saying exactly "CSD tracking" at all times, including calls from numbers that have never called before and blocked or unknown caller IDs.

**Why:** The user reported that known callers were answered while unknown callers were not, and explicitly required this greeting for every call.

**How to apply:** Preserve the initial greeting independently of CRM membership, business hours, staff availability, custom routing, or voicemail settings. Keep call routing and webhook authentication working.

## Call intake scope

Staff collect intake details and SMS permission in the existing Call Tracking screen; the intake integration must not insert questions into live calls.

**Why:** The user chose "Existing Call Tracking screen" rather than phone intake, and asked to integrate into the existing system without creating a separate system or breaking working behavior.

**How to apply:** Keep intake and technician ticket assignment separate from live phone forwarding. A change to the caller's live intake experience requires a new explicit request.

## Ordered forwarding and technician alerts

The owner requested the main line ring the primary number, first backup, then second backup in the order saved in Phone Settings. This supersedes staff-group ringing on the main line; other tracking numbers retain their existing routing. Human acceptance prompts are for the technician, not caller intake.

**Why:** The user requested two backup destinations and explicitly specified their order, then asked that calls not be ignored or missed. Mobile voicemail must not prevent backup attempts.

**How to apply:** Preserve the caller's greeting, try the configured sequence before CSD voicemail, and require a technician to accept the call. Respect later owner edits rather than resetting settings on every restart.

An explicit technician keypress is canonical acceptance even when Twilio's later dial result reports the child call as unbridged. Persist acceptance against the child call ID and stop the sequential backup chain once accepted.

**Why:** The user reported that the first technician could answer, yet the call disconnected and the next technician rang. Provider bridge status alone did not reliably represent the explicit keypress.

**How to apply:** Carry parent call, child attempt, and destination context through the whisper/accept webhook. Before ringing a backup, consult the saved human-acceptance result as well as Twilio's dial status.

All approved, enabled technicians with text notifications enabled receive intake, incoming-call, ticket, and appointment notices, including off-duty technicians. Missed-call notices prompt follow-up. Broadcast alerts do not grant access to customer records or disclose customer details outside assignment scope.

**Why:** The user asked that all techs be notified by text, not just the technician assigned to a ticket. Assignment eligibility and notification eligibility are separate; approval and message opt-outs still apply.

**How to apply:** Keep alerts independent of the on-duty assignment filter, queue them durably with event/recipient deduplication, and check actual roster readiness. Never claim delivery when there are no eligible recipients.

## App and phone ringing

The user wants incoming calls to ring both inside the app and on the saved forwarding phones.

**Why:** The user explicitly selected "Both the app and the saved phones" when clarifying a report of silent incoming calls.

**How to apply:** Preserve phone forwarding when changing app sound alerts. Clearly distinguish an audible app notification from a browser softphone, and do not claim handset audibility is confirmed solely from Twilio call statuses.