---
name: SSRF guard for user-host endpoints
description: Rule for any backend route that opens connections to a user-supplied host (network checkers, webhook testers, URL fetchers, port scanners).
---

Any backend endpoint that makes an outbound connection (fetch / TCP / DNS) to a
host or port supplied by the client MUST guard against SSRF before connecting.

**Why:** A naive reachability/ping endpoint lets an unauthenticated caller probe
internal services from the server's network — loopback (`127.0.0.1`, `::1`),
RFC1918 private ranges, link-local incl. the cloud metadata endpoint
`169.254.169.254`, CGNAT, and reserved/multicast ranges. Character-only regex
validation does NOT prevent this. A code review blocked the first version of the
tech-tools network checker for exactly this.

**How to apply:**
1. Resolve the host to IPs ONCE (or accept an IP literal via `net.isIP`).
2. Reject the whole request if ANY resolved IP is non-public (check IPv4 ranges
   0/10/127/169.254/172.16-31/192.168/100.64-127/198.18-19/test-nets/224+, and
   IPv6 `::1`/`::`/`fe80`/`fc`/`fd`/`ff`/IPv4-mapped). Also reject `localhost`.
3. Connect only to the validated IP (do not re-resolve) to close the
   DNS-rebinding window.
4. Prefer a raw TCP reachability probe over a full HTTP fetch when you only need
   "is something listening" — avoids cert/SNI issues and content exfiltration.

Reference implementation lives in the `/api/tech-tools/network-check` route in
`server/routes.ts`.
