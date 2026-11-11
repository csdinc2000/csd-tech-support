---
name: Company email SMTP
description: HostGator company-mail choice, direct-server requirement, and safe verification before invitation retries.
---

The user chose company email through SMTP to restore staff invitation sending and identified the email provider as HostGator.

**Why:** The user selected company SMTP rather than restoring SendGrid sending credits.

**How to apply:** Continue HostGator SMTP setup for this app; do not substitute another provider or reuse a different mailbox's credentials without asking.

Use the account-specific direct mail-server hostname from HostGator's secure mail-client settings, not a Cloudflare-proxied website hostname.

**Why:** The configured SMTP hostname resolved to Cloudflare's web proxy and timed out on mail ports while other SMTP endpoints were reachable. Ordinary Cloudflare web proxying does not carry SMTP.

**How to apply:** Obtain the exact outgoing server from the account's secure SSL/TLS settings, use HostGator's documented secure port, and retain certificate validation. Do not guess an account server or bypass TLS checks.

Validate SMTP with a TLS/authentication check that sends no message before retrying staff invitations.

**Why:** Saving credentials does not prove the sender works, and setup checks should not send unintended or duplicate invitations.

**How to apply:** Distinguish configured settings, successful authentication, provider acceptance, and recipient delivery. Do not report email restored from configuration alone.
