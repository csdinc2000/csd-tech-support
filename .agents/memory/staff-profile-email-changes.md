---
name: Staff profile email changes
description: Safety boundaries for administrator edits to staff sign-in and contact information.
---

Administrator email edits may select only an already verified address on the staff member's exact linked Clerk account. A new address must first be added and verified by that staff member through Manage account. Owner allowlist identities must not be changed or assigned through this editor.

**Why:** An editable local email field alone would leave authentication and meeting invitations inconsistent. Assigning an arbitrary address or linking by email/name could transfer account ownership or elevate someone to owner.

**How to apply:** Resolve the exact established Clerk identity, verify address ownership again at save time, reject conflicts without merging identities, and report an uncertain provider/database outcome explicitly. A provider change and a local save cannot be one atomic transaction.

Staff contact phone edits must not silently change Dispatch or call-forwarding destinations.

**Why:** Contact information and operational phone routing serve different purposes; a profile correction is not permission to reroute incoming business calls.

**How to apply:** Keep phone routing an explicit Dispatch action and explain that distinction in the staff editor.
