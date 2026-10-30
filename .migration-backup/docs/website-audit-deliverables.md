# Computer Systems Depot — Website Audit Deliverables

Source-of-truth facts confirmed from this repository (`.local/a2p-last-submission.json`,
`client/src/pages/csd-intake.tsx`, `server/aria-service.ts`):

| Field | Value |
| --- | --- |
| Legal name | Computer Systems Depot Inc |
| Address | 5601 NW 13 Street, Lauderhill, FL 33313 |
| Main line | 954-637-7300 |
| Domain | computersystemsdepot.com |
| Support email | support@computersystemsdepot.com |
| Serving since | 1996 |
| Service area | Broward, Miami-Dade & Palm Beach (Tri-County, South Florida) |
| Remote support tool | MeshCentral (self-hosted) |

> **Fix the city conflict:** `server/aria-service.ts` (lines ~31, 45, 71) says
> "Fort Lauderdale" while every address record says **Lauderhill**. Standardize on
> **Lauderhill** (with "serving the Fort Lauderdale / Tri-County area" as the
> service-area phrasing) so the site matches the Google Business Profile address.

---

## Deliverable 1 — Revised Professional Copy

### Homepage hero

> **Reliable Computer & Workstation Repair in Lauderhill and the Tri-County Area**
> From a slow laptop to a server that won't boot, Computer Systems Depot has kept
> South Florida running since 1996. Fast, honest, and local — serving Broward,
> Miami-Dade, and Palm Beach counties with on-site, in-shop, and secure remote support.

*(Replaces keyword-stuffed text such as "PC fix close me, PC fix or workstation fix close me.")*

### Remote support section (homepage + /support)

> **Need help right now? We can connect remotely.**
> Whether you're working from home, at the office, or connected to public Wi-Fi, our
> technicians can securely access your computer to diagnose and fix the problem — no
> trip required. Just call us, and we'll walk you through a quick, safe connection.

*(Replaces "...whether you are home or at work or even if you are a Donkin Donuts.")*

### Scheduling / contact line

> **We work around your schedule.**
> Booked solid this week? We offer flexible appointment windows to accommodate your
> busy schedule, including evening remote sessions.

*(Replaces "...accommodate you will your very busy schedule.")*

### Core services blurb (for the services page intro)

> **Complete Computer Repair, One Trusted Shop.**
> We repair laptops, desktops, and business workstations; recover lost data; service
> tablets and gaming consoles; remove viruses; and keep your network secure — backed
> by our 90-day labor guarantee and 27+ years serving South Florida.

### Service sub-page stubs (one short paragraph each — see Deliverable 3 for linking)

- **Laptop Repair** — Cracked screens, dead batteries, liquid damage, and slow
  performance. Most laptop repairs are completed in 1–3 business days.
- **Tablet Repair** — Screen, charging-port, and battery service for iPad and
  Android tablets, with clear up-front pricing.
- **Gaming Consoles** — HDMI ports, overheating, disc drives, and storage upgrades
  for PlayStation, Xbox, and Nintendo Switch.
- **Data Recovery** — Failed drives, accidental deletion, and corrupted files.
  Free evaluation before any recovery work begins.

---

## Deliverable 2 — Remote Support Gateway: reuse `remote.computersystemsdepot.com`

**Decision:** rather than stand up a new `support.` subdomain, we reuse the existing
**`remote.computersystemsdepot.com`**, which already points at your self-hosted
MeshCentral server with a valid Let's Encrypt cert (confirmed live — the app reports
`MeshCentral configured: https://remote.computersystemsdepot.com/` and
`/api/meshcentral/status` returns `connected`). **No new DNS or SSL work is required.**

Two hostnames are involved, and they do different jobs — keep them straight:

| Role | Host | Status |
| --- | --- | --- |
| MeshCentral **session** (where the customer lands) | `remote.computersystemsdepot.com` | Live, valid cert ✓ |
| Widget page + **redeem API** (`/remote-support`, `/api/support/*`) | **the app** (this Express server) | Served same-origin ✓ |

**Why the widget is served by the app (not pasted raw into WordPress):** the
redeem-code call must reach the app, and the app has no CORS layer. Serving the widget
from the app and embedding it via an **iframe** (just like your intake form) keeps that
call **same-origin**, so no CORS configuration is needed and no credentials cross
origins. The widget then redirects the *top* window to the MeshCentral session on
`remote.computersystemsdepot.com`.

**Verification checklist (all already satisfied — just confirm):**
1. `https://remote.computersystemsdepot.com` loads with a valid padlock (no new cert needed).
2. App boot log shows `MeshCentral configured: https://remote.computersystemsdepot.com/`.
3. `GET https://<app>/remote-support` returns the widget page (200, `text/html`).
4. The page sends `Content-Security-Policy: frame-ancestors … computersystemsdepot.com`
   so it can be iframed by the marketing site but not by arbitrary third parties.
5. On a valid code, the widget redirects to a `remote.computersystemsdepot.com/...` URL.

**Backend (now built).** MeshCentral has no native 6-digit code, so this app
provides the thin mapping that turns a phone-spoken code into a live session:

- `server/support-codes.ts` — in-memory, single-use codes with a **10-minute TTL**
  and per-IP brute-force throttling (max 10 failed attempts/minute). Codes aren't
  persisted on purpose: they live for minutes and a dropped one is just regenerated.
- `POST /api/support/generate-code` *(technician-only, authenticated)* —
  body `{ deviceId, sessionType? }` → returns `{ code, deviceName, expiresAt }`.
  Resolves the device's MeshCentral session URL via the existing
  `meshCentralService.createRemoteSession` path.
- `POST /api/support/redeem-code` *(public, called by the widget)* —
  body `{ code }` → `{ ok: true, redirectUrl }` on success (and records an active
  `remote_access_sessions` row for audit), or a vague `{ ok: false, message }` on
  failure so the 6-digit space can't be probed. Returns `429` when throttled.

**Technician workflow (UI is built):** open the device in the Remote Access page →
click **"Phone Support Code"** (`client/src/components/remote/support-code-dialog.tsx`)
→ read the 6 digits to the customer on the phone → customer types them into the widget
→ they're dropped into the MeshCentral session. The dialog shows a live expiry
countdown and a Regenerate button; codes self-expire in 10 min and are single-use.

**Embedding the customer widget (Task 1):** the widget is served by the app at
`/remote-support` (canonical source: `server/remote-support-widget.ts`). Add it to the
homepage and a support page in WordPress with the new shortcode:

```
[csd_remote_support height="560px"]
```

This iframes the app's widget page (same-origin redeem call, no CORS). Set the CSD
Forms plugin's **Replit Base URL** to the app's deployment URL — the same setting the
intake form already uses.

---

## Deliverable 3 — Fix "Read More" / CTA Link Looping (Technical SEO)

**Problem:** "Read More" and CTA buttons on the services page use `href="#"` (or empty
`href`), which jumps to the top of the homepage instead of the service page.

**Fix:** point each button at its own page and add descriptive anchor text (better for SEO than "Read More"):

| Service | Button target | Recommended anchor text |
| --- | --- | --- |
| Laptop Repair | `/services/laptop-repair` | "See Laptop Repair pricing" |
| Tablet Repair | `/services/tablet-repair` | "Tablet repair details" |
| Gaming Consoles | `/services/gaming-console-repair` | "Console repair options" |
| Data Recovery | `/services/data-recovery` | "Start a data recovery" |

Checklist:
- Replace every `href="#"` / `href=""` with the real sub-page URL above.
- Create the four sub-pages (copy stubs in Deliverable 1) so links don't 404.
- Use unique, descriptive anchor text — not "Read More" — on every CTA.
- Add an internal link from each sub-page back to the main services page (breadcrumb).
- After publishing, crawl with Screaming Frog (or Google Search Console → Pages) to
  confirm 0 redirect loops and 0 broken internal links; submit an updated `sitemap.xml`.

**Theme hardening (also Task 3):**
- Disable XML-RPC and remove the WordPress version meta tag / generator header.
- Suppress server signature (`ServerTokens Prod`, `ServerSignature Off`) so the site
  doesn't leak PHP/Apache versions.
- Update the child theme to the current WP/PHP standard (PHP 8.x); replace any
  deprecated functions; escape all output (`esc_html`, `esc_attr`, `esc_url`) — the
  CSD Forms plugin already follows this pattern, mirror it in the theme.
- Add security headers via the theme/functions or server: `X-Content-Type-Options:
  nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`,
  and a `Content-Security-Policy` that allows the support subdomain iframe.
- Keep plugins/core auto-updated; remove unused themes/plugins.

---

## Deliverable 4 — Standardized Hours Table

Publish these **identically** in the footer, the contact page, and the Google
Business Profile. (Per your decision, the 5 AM–11 PM window is retained — it reflects
phone & remote-support availability, which is why a computer shop is reachable that
long.)

| Day | Hours |
| --- | --- |
| Monday | 5:00 AM – 11:00 PM |
| Tuesday | 5:00 AM – 11:00 PM |
| Wednesday | 5:00 AM – 11:00 PM |
| Thursday | 5:00 AM – 11:00 PM |
| Friday | 5:00 AM – 11:00 PM |
| Saturday | Closed — emergency remote support available |
| Sunday | Closed — emergency remote support available |

**Weekend note to publish verbatim:** *"Saturday–Sunday: Closed for walk-ins —
emergency remote support available, call 954-637-7300."* This matches the
"Available 24/7 for critical issues" line in `client/src/pages/dashboard.tsx`, so the
site, footer, and Google Business Profile all tell the same story (mismatched hours
hurt local SEO and customer trust).

**Footer/label wording:** *"Hours of Operation (Phone & Remote Support)."* This is
accurate and explains the long daily window credibly.

**Google Business Profile setup:** enter Mon–Fri 5:00 AM–11:00 PM as regular hours;
mark Sat/Sun as "Closed" and add *"emergency remote support available — call
954-637-7300"* in the business description (GBP has no per-day note field).
