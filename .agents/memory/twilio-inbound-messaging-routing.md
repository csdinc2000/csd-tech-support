---
name: Twilio inbound messaging routing
description: External Twilio Messaging Service setting required for SMS and MMS webhooks to reach the application.
---

The CSD business number is attached to an A2P Messaging Service. That service must keep “use the inbound webhook on the number” enabled. If disabled while the service-level inbound URL is blank, Twilio accepts incoming SMS/MMS but never calls the number’s configured webhook.

**Why:** This failure is silent at the application boundary: the message shows as received in Twilio, while no inbound request, stored message, or cellphone-forwarding job appears in the app.

**How to apply:** When inbound texts disappear, inspect both the phone number’s SMS URL and its attached Messaging Service. Preserve sender-level webhook delegation when changing A2P or Messaging Service configuration.