# Backup-call verification

## Result and authorization boundary

The user declined live calls. No provider calls were placed, no provider charges
were incurred by this verification, and no production forwarding, staff access,
numbers, or customer records were changed.

**Real-provider verification is incomplete.** Passing local tests is not proof
that a carrier's mobile voicemail cannot intercept the call.

## Checks performed

Command: `node artifacts/api-server/scripts/run-tests.mjs twilio-voice-answer`

Result: 12 tests passed, 0 failed. The suite stubs provider operations,
notifications, persistence, and settings. Its callback bodies are synthetic.

The existing tests confirm:

- The main-line greeting is exactly “CSD tracking,” including unknown and blocked
  caller IDs, and precedes forwarding or voicemail.
- Configured primary and backup destinations are selected in order.
- A synthetic `completed` result with `DialBridged=false` continues to a backup.
- Synthetic no-answer, busy, and failed results continue or reach CSD voicemail.
- A synthetic `completed` result with `DialBridged=true` stops further dialing.
- Pressing 1 returns the connecting response; pressing 2 returns Hangup.
- The screening response includes a one-digit Gather and a Hangup after it.
- POST callbacks reject missing signatures.

The suite does not observe real DTMF, Gather timeout execution, carrier
voicemail, actual DialBridged values, unreachable carrier destinations, or
caller disconnection during backup attempts.

## Provider documentation

- [Twilio Dial](https://www.twilio.com/docs/voice/twiml/dial):
  DialBridged indicates whether the dialing call connected to its destination.
  Dial action callbacks control subsequent instructions on the original call.
- [Twilio Number](https://www.twilio.com/docs/voice/twiml/number):
  Number's URL executes on the called party before bridging; Gather and Hangup
  can let that party decline. An answered child leg alone is not evidence of
  human acceptance.
- [Twilio test credentials](https://www.twilio.com/docs/iam/test-credentials):
  test calls do not connect to real phones and do not trigger status callbacks.
  Magic-number REST tests cannot establish this task's real-provider outcomes.

## Required future live evidence

Do not execute this section without new explicit approval for calls and charges,
an approved spending limit, controlled non-customer phones, and participants.
Use an isolated fixture service with injected settings, persistence and
notification dependencies. Never point production number webhooks at it or
modify production forwarding. Preserve signature verification and the greeting.
Record only sanitized case outcomes, not phone numbers, credentials, recordings,
raw callback bodies, or customer data in the evidence report.

| Scenario | Required observations |
| --- | --- |
| Human presses 1 at each position | Caller and technician actually connect; provider DialBridged is true; no later destination rings after disconnection. |
| Human presses 2 | No bridge; provider DialBridged is false; next destination rings. |
| Human answers without pressing a key | Gather times out and hangs up the child; no bridge; next destination rings. |
| Actual mobile voicemail answers | Caller never connects to carrier voicemail; provider DialBridged is false; backups continue. |
| Busy and unreachable controlled destinations | Observe actual provider result statuses and continuation to the next destination. Do not dial invented numbers with live credentials. |
| All destinations fail | Caller hears CSD voicemail and can leave a message in isolated test storage. |
| Caller hangs up while each backup is ringing or screening | Child attempt ends; no subsequent backup rings and no voicemail recording starts. Observe actual callback presence/status rather than assuming a particular canceled result. |

Correlate parent/child legs privately while testing and capture DialCallStatus
and DialBridged at the authenticated action callback. Do not infer DialBridged
from a child call's answered/completed status. Confirm the provider returns the
values the application expects before making any claim of live verification.
