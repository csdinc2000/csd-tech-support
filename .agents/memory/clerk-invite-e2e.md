---
name: Clerk invite end-to-end checks
description: Testing real verified invitations without external email or bot challenges.
---

Use a development-only Clerk tenant with the reserved `+clerk_test` email pattern and OTP `424242` for real email verification. Clerk's Playwright testing token is needed to bypass its bot challenge, and verification input must wait until the verification preparation request completes. Sign out and back in on the same browser device when checking the next login, since a fresh context may trigger Clerk's unrelated client-trust challenge.

**Why:** Without the test token, the form stopped at Cloudflare; entering the code before preparation intermittently failed; and a fresh browser context prompted for an additional device verification code. Repeated checks also exhausted the app's shared invite-validation rate bucket.

**How to apply:** Keep test data in a development tenant, use reserved addresses only, route test validation through an isolated test server, keep an explicit development-key/database guard, and delete both Clerk and local identities after the run.