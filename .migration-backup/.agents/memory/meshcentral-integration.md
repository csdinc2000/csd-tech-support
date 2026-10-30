---
name: MeshCentral login protocol
description: How to authenticate to a self-hosted MeshCentral web login programmatically and detect success/failure correctly.
---

# MeshCentral programmatic login

**Rule:** A MeshCentral form login does NOT signal success with a 3xx redirect on
every server. This deployment returns **HTTP 200 + a refreshed session cookie** on
success. Do not treat "not a redirect" as a failed login.

**How to apply (login flow):**
- GET `/` first to prime the `xid` and `xid.sig` cookies, then POST to root `/`
  with form fields `username`, `password`, `action=login`, `urlargs` (urlencoded).
- The session is carried by the **same** `xid`/`xid.sig` cookie names — only their
  *values* change after a successful login. There is no separate auth-cookie name
  to look for.
- Success detection: accept a 3xx redirect OR a 200 whose body has no failure code.
- Failure detection: the response body embeds `var messageid = parseInt('NNN')`.
  Codes >= 100 are failures:
  - `112` = bad username/password
  - `110` = account locked
  - `114` = IP address temporarily blocked (too many attempts)
- A 200 with `messageid` 112 looks identical for a wrong username and a wrong
  password — MeshCentral does not distinguish them. If login fails with seemingly
  correct credentials, suspect the **username** first (it is not necessarily
  `admin`) and confirm the exact value against the MeshCentral Users panel.

**Why:** We burned a long debugging session assuming throttling / redirect-detection
bugs / password encoding. The real causes were (1) wrong username and (2) code that
rejected the 200-success response shape. The `messageid` map and the 200-success
behavior are external-system facts not discoverable from our code.

**Devices:** Node list comes over the control-channel WebSocket (`/control.ashx`,
send `{action:'nodes'}`). A brand-new server with no enrolled agents returns 0
devices — that is correct, not an error.

## Integration realities
- There is **no usable REST API** for this; authentication is the web form login
  above, and device data is only available over the WS `/control.ashx` control
  channel.
- The server's TLS cert may be **self-signed** — connections need
  `rejectUnauthorized:false`, gated behind `MESHCENTRAL_ALLOW_INSECURE_TLS=true`.
- Online vs offline is derived from each node's `conn > 0 || state === 1`. The WS
  also returns `{action:'meshes'}` (device groups) and `userinfo`/`serverinfo`
  before nodes — ignore those and wait for the action you asked for.

## Autonomous offline/online alerting convention
- The background device sync raises an alert ONLY on a non-offline→offline
  *transition* of a device it already knew, and resolves it on offline→online.
  Never alert every cycle for a still-offline device, and never alert on first
  enrollment.
- **The alerts it owns are tagged with a dedicated `alertSource` constant
  (`meshcentral-monitor`); dedupe/auto-resolve match on `deviceId + alertSource`
  only.** Do not make alert *title text* load-bearing for ownership.
- **Why:** title-text matching is brittle and a generic `alertSource` collides
  with other monitoring alerts; a dedicated source keeps ownership unambiguous.
- Dedupe is check-then-insert with no DB uniqueness, so a multi-instance
  (autoscale) deployment can still double-fire on the same transition — acceptable
  for now since schema migrations are blocked in this repl.
- No SMS/email is auto-sent on these alerts (kept in-app) while A2P/Slack are
  unhealthy; revisit once a notification channel is reliable.
