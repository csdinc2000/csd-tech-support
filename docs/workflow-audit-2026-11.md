# Workflow audit: customer ↔ technician ↔ front desk ↔ staff (2026-11-05)

This audit was read-only. Paths are relative to `artifacts/`.

"Verified" means a reviewer confirmed it in the code. "Suspected" means it was inferred and not tested.

## The core problem

One web intake (`POST /api/intake`, `api-server/src/routes/routes.ts` ~3450–3770) creates **five separate work records**: intake record, lead, deal, job and helpdesk ticket.

- Nothing passes status between them.
- The job and the ticket are linked only by a note.
- Each record type has its own statuses.
- Each record type has its own idea of who it is assigned to: free-text name, `users.id`, `auth_users.id`, or a Clerk id.

Every role pays for this:

- The tech updates the job but not the ticket.
- The customer's portal shows the ticket status, so it never reflects the tech's progress.
- The front desk can't tell which record is the real one.
- Nobody gets notified when work moves along.

The fixes are grouped below so each phase can ship on its own.

---

## Phase 0: Bugs and security holes (all verified, all small)

| # | Issue | Where | Effort |
|---|---|---|---|
| 0.1 | **The public appointment lookup leaks customer data.** `GET /api/booking/appointments/:reference` needs no login and returns the whole row: phone, email, `internalNotes`. References are sequential, so they can be enumerated. | `api-auth-boundary.ts:29`, `booking/booking-routes.ts:419` | S |
| 0.2 | **Any communications user can change phone forwarding.** `PATCH /api/twilio/settings` has no owner check, only the `communications` feature. That includes default techs and secretaries. | `routes/routes.ts:5961`, `security.ts:144` | S |
| 0.3 | **"Mark completed" on the Jobs page always fails.** The client sends `completedDateTime` as an ISO string. The server writes the raw body through Drizzle, and its timestamp column calls `.toISOString()` on that string, which throws. The user sees "Failed to update job". | `csd-rmm-crm/src/pages/crm-jobs.tsx:190`, `routes.ts:3039`, `storage.ts:2020` | S |
| 0.4 | **Job, intake and ticket-status updates write the raw request body.** That allows mass assignment (for example `jobNumber` or `leadId` can be overwritten), and any status string is accepted. | `routes.ts:2553, 3039`, `routes/helpdesk.ts:746` | S |
| 0.5 | **The default `field_technician` role can't load its own dashboard.** It lacks `crm`, and the board calls `/api/crm/jobs` and `/api/crm/contacts`, so those calls return 403. | `staff-access.ts:50`, `security.ts:126` | S |
| 0.6 | **Tech SMS dispatch filters on `p.role='technician'`.** That role was renamed to `field_technician`, so staff promoted to tech later never get texts. | `staff-dispatch.ts:520`, `twilio-tracking-storage.ts:493` | S |
| 0.7 | **Customer email links go nowhere.** `portal_url` points at `/portal?ticket&email&token`, but only `/portal/ticket` reads those parameters. This affects every autoreply, reply and resolved email. | `helpdesk-email.ts:48`, `pages/portal-home.tsx` | S |
| 0.8 | **The intake confirmation email is wrong.** It shows `CSD-<leadId>` instead of the ticket number. It contains a placeholder ("call us at your business phone number"). It is sent only through SendGrid, so customers on SMTP get nothing. The admin "view intake" link also uses the lead id, so it points at the wrong intake. | `routes.ts:3803-3831`, `csd-notifications.ts:84,104,127,130` | S |
| 0.9 | **Intake tickets never send the portal token.** They set `suppressAutoresponder: true`, so the customer never receives a working portal link. | `routes.ts:3751` | S |
| 0.10 | **Completed jobs can't be attached to an invoice.** The billing job picker leaves out completed jobs, which are exactly the ones that need billing. | `invoice-routes.ts:1285` | S |
| 0.11 | **`ready_pickup` can't be set from the Jobs page,** so the board's "Ready for Pickup" column stays empty. | `crm-jobs.tsx:53-59` | S |
| 0.12 | **The intake form promises an appointment reminder that doesn't exist.** | `components/forms/csd-intake-form.tsx:320` | S (remove) / M (build) |
| 0.13 | **The shared inbox stops at 300 threads, and the "Open" filter is applied after that cut,** so older open conversations disappear. | `shared-inbox.ts:347,417` | S |
| 0.14 | **The header global search box does nothing** (no handler), and the "Operational" pill is hardcoded. | `components/layout/header.tsx:86-98` | S (hide) / M (build) |
| 0.15 | **The customer page's "Add Job" button has no onClick,** and its "Calendar" link goes to the settings page. | `pages/customer-detail.tsx:114,310` | S |
| 0.16 | **Winning a deal always creates a second "Onboarding" ticket.** That ticket has no `clientId`, so non-admins can't see it. | `crm-pipeline.ts:78` | S |
| 0.17 | **Portal ticket creation has no rate limit, no CRM link and no staff dispatch.** | `routes/helpdesk.ts:871` | S |
| 0.18 | **`GET /api/intake` is not limited by assignment or role:** any approved staff member sees all intake personal data. | `routes.ts:2386` | S |

## Phase 1: Let each role actually do their job

**Who can see what**
- **Ticket visibility should include the assignee.** Today `canAccessAssignedTicket` and `GET /api/tickets` check only `client_id`. A tech who claims a ticket by SMS gets a 404 on the link in that same SMS. (`staff-access.ts:1018`, `routes.ts:795`) — S
- **Front desk needs to see all customers and create new ones.** Today `secretary` is limited to assigned customers, can't create contacts ("Administrator access required"), and can't open a job for a walk-in. Treat front desk as unrestricted for contacts, jobs, tickets and appointments. (`staff-access.ts:244`, `routes/contact-crm-routes.ts:73`, `routes.ts:3002`) — S–M
- **Show front desk the call log and "Create ticket from call".** Both are currently behind the owner-only Calls & Tracking tab. (`pages/phone-hub.tsx:69`) — S

**Labels and navigation**
- **Rename the roles in the UI:** `secretary` → *Front desk*, `it_manager` → *Manager*.
- **Trim the front-desk sidebar:** RMM Overview, Marketing ×6, PTT and Website Discovery.
- **Fix the duplicate "Calendar" items.** (`components/layout/sidebar.tsx`) — S

## Phase 2: One assignment model and a "My work" view

- **Make `crm_jobs.assigned_to` a real staff FK** instead of free text, and add an assignee picker to the job form. The form also needs a scheduled date, device, and drop-off fields (serial, accessories, condition, passcode). Write `staff_job_assignments` on assign so the job shows up in the tech's scope. (`lib/db/src/schema/schema.ts:669-688`, `crm-jobs.tsx`) — M
- **Add a "My work" toggle on the tech board.** Also add a Tickets column and an SMS button next to Call. (`components/dashboard/tech-board/`) — M
- **Make the board's detail dialog editable** (status, notes, assignee). Deep-link `/crm/jobs?job=<id>` instead of opening the list. (`detail-dialog.tsx:212`) — S–M
- **Resolve staff identity once in middleware.** Today helpdesk `parseInt`s the Clerk-side id into `users.id`-space actor columns. (`routes/helpdesk.ts:237`) — L

## Phase 3: Notifications at every handoff

Today the job lifecycle (assigned, status change, ready, completed) notifies **nobody**.

| Event | Notify | Channel |
|---|---|---|
| Job / appointment assigned | Assigned tech | SMS + in-app |
| Job → waiting_parts / ready_pickup / completed | Customer (if consented) | SMS from main line + email with portal link |
| Job → completed / "ready to bill" | Front desk | In-app queue + Slack |
| Tech claims or closes a ticket via SMS | Front desk | In-app |
| Customer replies in portal / by email | Assigned tech or front desk | In-app + Slack (today: activity log only) |
| Intake or ticket unassigned > N min; SLA overdue | Front desk / manager | Scheduled sweep (today SLA runs only when someone clicks a button) |
| Appointment tomorrow | Customer | SMS reminder |
| Invoice paid | Front desk; job auto-closes; review request queued | — |

The notification code goes in a single helper called from the job, ticket and appointment update handlers (`routes.ts` `updateCrmJobHandler`, `helpdesk.ts`, `booking-routes.ts`), plus one scheduled worker. — M

## Phase 4: One "Needs response" queue for the front desk

Today the front desk has to check five places: SMS inbox, voicemails, `/tickets` (email), Customers → New Service Requests, and the dashboard.

- **Build one queue** with these item types: SMS, missed calls and voicemails, new intakes, unassigned email and portal tickets, customer replies, and jobs ready to bill.
- **Missed calls and voicemails should open inbox conversations.** Today only an inbound SMS does that. (`twilio-forwarding.ts:263`, `shared-inbox.ts:330`)
- **Each item gets one-click actions:** link or create the customer, create a job, ticket or appointment, assign, and reply.
- **The incoming-call banner should show the matched customer and an "Open" button.** (`components/notifications/incoming-call-alerts.tsx`)
- **Make global search work across contacts, tickets, jobs and invoices**, matching phone numbers on digits only. Contact search today does a raw `includes` on mobile only. (`crm-contacts.tsx:319`)

Effort: L.

## Phase 5: One work order per repair

- **Pick a canonical work order: the job.**
  - Stop auto-creating a separate ticket per intake, or add `tickets.job_id` and sync status between the two.
  - Give jobs and tickets distinct number prefixes. Today both use `CSD-YYYY-NNNN`.
  - Add a unique index on `job_number`. Today it is computed as count+1, which can produce duplicates (suspected).
- **The customer portal should show friendly job statuses** ("Diagnosing", "Waiting for parts", "Ready for pickup"), and allow lookup by phone + ticket number. Phone-only customers can't use the portal today because they have no email.
- **Add the missing FKs:** `csd_intake_records.contact_id`, `appointments.job_id/ticket_id/contact_id` (public bookings from intake are never linked to the customer), `invoices.ticket_id`.
- **Add job time and parts lines.** Carry them into the invoice through "Create invoice from job" (today only the *estimate* carries over). Also: internal vs customer notes, photos, and the device linked with a "Start remote session" button.
- **Quote approval:** a tokenized approve/decline page before work starts. Add deposit collection for `depositRequiredCents`, which is captured today but never charged.
- **Store attachments in the database or object storage.** Ticket attachments are on local disk today, which an autoscale redeploy wipes (suspected).
- **Contact merge tool for "identity review" duplicates.**
- **Write a unified `activity_events` table on every mutation and drive the job, ticket and customer timelines from it.** Today job status changes and assignments leave no audit trail.
- **Clean-up:**
  - Remove the dead `booking_appointments` / `booking_staff` tables.
  - Generate the client schema from `@workspace/db`; it is hand-copied today and has drifted.
  - Normalize `in-progress` → `in_progress`, and decide whether ticket status "pending" is real.

Effort: L overall. Each bullet can ship on its own.
