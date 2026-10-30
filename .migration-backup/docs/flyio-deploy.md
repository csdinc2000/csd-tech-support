# Deploying CSD to Fly.io (24/7 uptime)

This guide takes the app from "running on Replit" to "always-on at a stable
`https://<your-app>.fly.dev` URL" so Twilio webhooks (calls, SMS, voicemail)
never miss a beat.

The repo already ships with everything you need:

- `Dockerfile` — multi-stage Node 20 build, listens on `PORT=8080`
- `fly.toml` — region `mia`, always-on (`min_machines_running = 1`), health
  check hitting `/api/health`, force HTTPS
- `.dockerignore` — keeps build context small
- `/api/health` — cheap JSON endpoint Fly uses to know the app is alive

You only have to run the deploy commands and move the Twilio webhooks.

---

## 1. One-time setup

### Install `flyctl`

In the Replit shell:

```bash
curl -L https://fly.io/install.sh | sh
export FLYCTL_INSTALL="/home/runner/.fly"
export PATH="$FLYCTL_INSTALL/bin:$PATH"
flyctl version
```

(Add the two `export` lines to `~/.bashrc` if you want them to persist across
shells.)

### Sign in / create an account

```bash
flyctl auth signup     # first time — opens a browser
# or
flyctl auth login      # if you already have an account
```

Fly's "Hobby" plan ($5/mo of usage credit) covers one always-on 1GB shared-cpu
machine in `mia` with room to spare.

---

## 2. First deploy

The app name in `fly.toml` is `workspace-ambered-brook-386`. Change the `app =`
line at the top of `fly.toml` if you want something friendlier (e.g.
`csd-rmm`) — names must be globally unique on Fly.

```bash
flyctl apps create csd-rmm       # only if you renamed it; skip otherwise
flyctl deploy --remote-only      # builds the Docker image on Fly's builder
```

The first build pulls the Node image and runs `npm ci && npm run build`, so
expect 4–6 minutes. Subsequent deploys are much faster.

When it finishes, Fly prints the URL — note it down. It looks like
`https://csd-rmm.fly.dev`.

---

## 3. Set secrets

Fly secrets are encrypted env vars. Run each line below, replacing the
right-hand side with the value from your Replit Secrets pane. Anything you
don't use (e.g. SendGrid if you only do SMS) you can skip.

```bash
# --- Database (REQUIRED) ---
flyctl secrets set DATABASE_URL='postgres://...neon.tech/...'

# --- Session signing (REQUIRED — app crashes on boot without it) ---
# Generate any long random string. Easy way: `openssl rand -hex 48`
flyctl secrets set SESSION_SECRET='paste-a-long-random-string-here'

# --- Public base URL (REQUIRED so outbound SMS status callbacks come back here) ---
flyctl secrets set PUBLIC_BASE_URL='https://csd-rmm.fly.dev'

# --- Twilio (REQUIRED for calls + SMS) ---
# All three must be set. TWILIO_AUTH_TOKEN is what we use to verify the
# signature on every incoming Twilio webhook — without it, requests would be
# trusted blindly. The app skips the Replit Twilio connector when these are
# present and talks to Twilio directly.
flyctl secrets set \
  TWILIO_ACCOUNT_SID='ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' \
  TWILIO_AUTH_TOKEN='xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' \
  TWILIO_PHONE_NUMBER='+1XXXXXXXXXX'

# --- AI assistants (optional) ---
flyctl secrets set \
  OPENAI_API_KEY='sk-...' \
  GEMINI_API_KEY='...' \
  VAPI_API_KEY='...' \
  VAPI_PRIVATE_KEY='...'

# --- Stripe / SendGrid / Slack / Google / MeshCentral — only if you use them ---
# flyctl secrets set STRIPE_SECRET_KEY='sk_live_...'
# flyctl secrets set STRIPE_WEBHOOK_SECRET='whsec_...'
# flyctl secrets set SENDGRID_API_KEY='SG.xxx'
# flyctl secrets set SLACK_BOT_TOKEN='xoxb-...'
# flyctl secrets set GOOGLE_CLIENT_ID='...' GOOGLE_CLIENT_SECRET='...'
# flyctl secrets set MESHCENTRAL_URL='https://...' MESHCENTRAL_USERNAME='...' MESHCENTRAL_PASSWORD='...'
```

Setting a secret triggers a rolling restart automatically. To see what's set:

```bash
flyctl secrets list
```

> **Note on the Twilio connector**: in production we bypass the Replit Twilio
> connector entirely. `server/twilio.ts` checks for `TWILIO_ACCOUNT_SID` +
> `TWILIO_AUTH_TOKEN` first and uses them directly when present, so on Fly
> these two env vars are the *only* Twilio credentials needed. Replit-specific
> env vars (`REPLIT_CONNECTORS_HOSTNAME`, `REPL_IDENTITY`) aren't set on Fly
> and aren't required.

---

## 4. Confirm the app is alive

```bash
curl https://csd-rmm.fly.dev/api/health
# → {"status":"ok","uptime":12.3,"ts":1736...}

flyctl status                 # shows machine state + region
flyctl logs                   # tail live logs (Ctrl-C to exit)
```

Open the URL in your browser — you should see the dashboard.

---

## 5. Point Twilio webhooks at Fly

In the Twilio Console → **Phone Numbers → Manage → Active Numbers**, click
each number you use and update:

| Field | New value |
|---|---|
| **A call comes in** (Voice & Fax → Webhook) | `https://csd-rmm.fly.dev/webhooks/voice/incoming` (POST) |
| **Call status changes** | `https://csd-rmm.fly.dev/webhooks/voice/status` (POST) |
| **A message comes in** (Messaging → Webhook) | `https://csd-rmm.fly.dev/webhooks/sms/incoming` (POST) — or `/webhooks/sms/tracking` for tracking numbers |

Or, if you've used the in-app provisioning, just hit the sync endpoint once
the app is up and it'll update every tracking number you bought through it:

```bash
curl -X POST https://csd-rmm.fly.dev/api/call-tracking/numbers/sync-webhooks
```

Test by texting your Twilio number from your cell — you should see the inbound
message in **Messages** within a few seconds, and (if A2P is registered) get
the auto-reply back.

---

## 6. Updating the app later

```bash
git add . && git commit -m "your change"
flyctl deploy --remote-only
```

That's it. Fly does a rolling deploy: it boots a new machine, waits for the
`/api/health` check to pass, then shifts traffic over and stops the old one.
Zero downtime.

---

## 7. Common troubleshooting

| Symptom | Fix |
|---|---|
| `flyctl deploy` fails on `npm run build` | Run `npm run build` locally first to see the real error; fix and redeploy. |
| Twilio webhooks return 403 "Invalid Twilio signature" | `TWILIO_AUTH_TOKEN` is wrong or missing. `flyctl secrets set TWILIO_AUTH_TOKEN=...` to fix. |
| Outbound SMS shows status `failed` with code `30034` | A2P 10DLC brand/campaign is not registered. Not a deploy issue — register at console.twilio.com → Messaging → Regulatory Compliance. |
| Health check failing in `flyctl status` | `flyctl logs` will tell you what crashed. Usually a missing secret (most often `DATABASE_URL`). |
| Machine is stopped / scaled to zero | `flyctl scale count 1` and confirm `min_machines_running = 1` in `fly.toml`. |
| Need a shell on the running machine | `flyctl ssh console` |
| Need to roll back a bad deploy | `flyctl releases` then `flyctl deploy --image registry.fly.io/<app>:deployment-<id>` |

---

## 8. Point a real domain at the app (e.g. `support.computersystemsdepot.com`)

The `*.fly.dev` URL works, but a branded hostname looks more professional in
Twilio voicemail SMS, customer emails, and any links you share. It also means
the URL never changes if the Fly app is ever renamed.

This whole flow takes ~10 minutes plus DNS propagation (usually a few minutes,
worst case an hour).

### 8.1 Pick the hostname and tell Fly about it

Decide the hostname — for example `support.computersystemsdepot.com`. Then, from the project
root (so `flyctl` picks up `fly.toml`):

```bash
flyctl certs add support.computersystemsdepot.com
```

Fly responds with the DNS records it wants you to create. It will look
something like:

```
You can validate your ownership by:

1: Adding an A record to your DNS service which reads:
    A @ 66.241.124.xxx
2: Adding an AAAA record to your DNS service which reads:
    AAAA @ 2a09:8280:1::xxxx
```

(For a subdomain like `support.computersystemsdepot.com`, the host field is `app`, not `@`.)

Leave that terminal open — you'll come back to it after DNS is set.

### 8.2 Add the DNS records at your registrar

In your DNS provider (Cloudflare, Namecheap, GoDaddy, Route 53, etc.) add:

| Type  | Name (host) | Value                                   | TTL  |
|-------|-------------|-----------------------------------------|------|
| A     | `app`       | the IPv4 address Fly printed            | Auto |
| AAAA  | `app`       | the IPv6 address Fly printed            | Auto |

Notes:
- If you use Cloudflare, set the proxy status to **DNS only** (grey cloud)
  for the cert challenge to succeed. You can re-enable proxying later if you
  want, but `force_https` in `fly.toml` already handles TLS termination at
  Fly, so proxying buys little.
- Apex domains (`computersystemsdepot.com` with no subdomain) need `ALIAS`/`ANAME` or
  Fly's recommended pair of A/AAAA records — see
  <https://fly.io/docs/networking/custom-domain/>.

### 8.3 Wait for the cert to issue

Check status until it says `Certificate Status: Ready`:

```bash
flyctl certs show support.computersystemsdepot.com
```

Or watch all certs for the app:

```bash
flyctl certs list
```

Fly auto-renews the Let's Encrypt cert; no cron needed.

### 8.4 Verify HTTPS works

```bash
curl https://support.computersystemsdepot.com/api/health
# → {"status":"ok",...}
```

Open the URL in a browser — you should see the dashboard with a valid
padlock.

### 8.5 Update `PUBLIC_BASE_URL`

This is the secret the app embeds in outbound Twilio status callbacks, SMS
links, etc. If it still points at `*.fly.dev`, Twilio status callbacks will
hit the old URL.

```bash
flyctl secrets set PUBLIC_BASE_URL='https://support.computersystemsdepot.com'
```

Setting a secret triggers a rolling restart automatically.

### 8.6 Re-point Twilio webhooks

The easy path — for any numbers provisioned through the in-app call
tracking, hit the sync endpoint once. It reads `PUBLIC_BASE_URL` and rewrites
every tracking number's webhooks:

```bash
curl -X POST https://support.computersystemsdepot.com/api/call-tracking/numbers/sync-webhooks
```

For numbers you configured manually in the Twilio Console, repeat the
webhook table from section 5 with the new hostname:

| Field | New value |
|---|---|
| **A call comes in** | `https://support.computersystemsdepot.com/webhooks/voice/incoming` (POST) |
| **Call status changes** | `https://support.computersystemsdepot.com/webhooks/voice/status` (POST) |
| **A message comes in** (main business line) | `https://support.computersystemsdepot.com/webhooks/sms/incoming` (POST) |
| **A message comes in** (call-tracking number) | `https://support.computersystemsdepot.com/webhooks/sms/tracking` (POST) |

Pick the SMS path based on what the number is for:
- `/webhooks/sms/incoming` — your main / manually-configured business
  numbers. This is also what `sync-webhooks` uses for tracking numbers
  only if you haven't differentiated them; double-check below.
- `/webhooks/sms/tracking` — numbers provisioned through the in-app call
  tracking flow. `POST /api/call-tracking/numbers/sync-webhooks` sets this
  path automatically, so you usually don't touch these by hand.

Test by texting your Twilio number — the inbound message should appear in
**Messages** within a few seconds.

### 8.7 (Optional) Remove the old `*.fly.dev` cert

The `*.fly.dev` hostname keeps working forever — it's free and useful as a
fallback. No need to remove it. Just stop sharing it.

### Troubleshooting custom domains

| Symptom | Fix |
|---|---|
| `flyctl certs show` stuck on `Awaiting configuration` | DNS hasn't propagated yet, or the A/AAAA records point somewhere else. Check with `dig support.computersystemsdepot.com` / `dig AAAA support.computersystemsdepot.com`. |
| Browser shows `NET::ERR_CERT_AUTHORITY_INVALID` | Cert hasn't issued yet — run `flyctl certs show` and wait until status is `Ready`. |
| Cloudflare users see a redirect loop | Set SSL/TLS mode to **Full (strict)** in Cloudflare, or turn the orange cloud off. |
| Twilio callbacks still hitting `*.fly.dev` | You forgot section 8.5 (`PUBLIC_BASE_URL`) or 8.6 (sync webhooks). |

---

## 9. Branded sender for outbound email (`no-reply@computersystemsdepot.com`)

Once the app lives at `support.computersystemsdepot.com`, outbound notifications (password
resets, ticket autoresponders, voicemail-to-email, intake confirmations)
should come from a matching `computersystemsdepot.com` sender instead of the default
SendGrid sandbox address. That requires two things: verify the domain in
SendGrid so DKIM/SPF pass, and point the app at the new From address with
the `MAIL_FROM` secret.

### 9.1 Verify `computersystemsdepot.com` in SendGrid

In the SendGrid app: **Settings → Sender Authentication → Authenticate Your
Domain**.

1. Pick your DNS host (Cloudflare, Namecheap, GoDaddy, etc.).
2. Domain: `computersystemsdepot.com`. Leave "Use automated security" **on** — that gives
   you CNAMEs SendGrid can rotate without your help.
3. SendGrid prints three CNAMEs that look like:

   ```
   em1234.computersystemsdepot.com        CNAME  u12345678.wl.sendgrid.net
   s1._domainkey.computersystemsdepot.com CNAME  s1.domainkey.u12345678.wl.sendgrid.net
   s2._domainkey.computersystemsdepot.com CNAME  s2.domainkey.u12345678.wl.sendgrid.net
   ```

4. Add all three CNAMEs at your registrar. If you use Cloudflare, set them
   to **DNS only** (grey cloud) — proxying breaks the DKIM lookup.
5. Back in SendGrid, click **Verify**. Propagation is usually a few minutes;
   worst case an hour.

When the page shows all three records as **Verified**, you're done. SendGrid
auto-rotates the keys; no cron needed.

### 9.2 Set the `MAIL_FROM` secret on Fly

```bash
flyctl secrets set MAIL_FROM='no-reply@computersystemsdepot.com'
```

The app reads `MAIL_FROM` first, falls back to the legacy `CSD_FROM_EMAIL`,
and finally defaults to `no-reply@computersystemsdepot.com` — so even if you forget the
secret, mail still goes out under the branded address (but it'll only land
in the inbox once section 9.1 is done).

Setting the secret triggers a rolling restart automatically.

#### Friendly From display name

By default the inbox shows `Computer Systems Depot <no-reply@computersystemsdepot.com>`.
Override the display name with `MAIL_FROM_NAME` if you want something
different (for example a brand line or department name):

```bash
flyctl secrets set MAIL_FROM_NAME='Computer Systems Depot Support'
```

The app reads `MAIL_FROM_NAME` first, falls back to the legacy
`CSD_FROM_NAME`, and finally defaults to `Computer Systems Depot`. Both
`server/csd-notifications.ts` and `server/helpdesk-email.ts` send the
SendGrid `from` field in the object form (`{ email, name }`) so the friendly
name lands in the recipient's inbox.

Helpdesk departments that have their own `email` set will use the
department's `name` as the friendly display name automatically — no extra
config needed.

### 9.3 Send a test email and confirm

Easiest end-to-end test: submit the customer intake form on the live site.
That fires `sendIntakeNotificationEmail` to `CSD_ADMIN_EMAIL` and (if
`CSD_SEND_CUSTOMER_CONFIRMATION` is set) a confirmation to the customer.

Check the inbox of the receiving address:

- **From** should read `Computer Systems Depot <no-reply@computersystemsdepot.com>` (or
  whatever you set `MAIL_FROM_NAME` to) — not `…@sendgrid.net` and not
  "via sendgrid.net" in the header.
- The message should land in **Inbox**, not Spam.
- View the raw headers and confirm `dkim=pass` and `spf=pass` for
  `computersystemsdepot.com`.

If it lands in Spam, the domain isn't fully verified yet — recheck the
CNAMEs in section 9.1.

---

## Out of scope for this runbook

- **A2P 10DLC registration** — separate Twilio compliance flow, must be done
  in the Twilio Console.
- **Migrating Postgres to Fly** — we keep using Neon. If you ever want to move
  off Neon, `flyctl postgres create` then change `DATABASE_URL`.
- **Autoscaling** — current config is one always-on machine. Plenty for a
  single-tech shop.
