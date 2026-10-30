# CSD Cloud Scheduling Platform — Modular Implementation Plan

**Owner:** Engineering
**Scope:** computersystemsdepot.com booking system
**Goals:** Scalability, conversion, operational intelligence, PCI compliance, high-concurrency safety

---

## Architecture Principles

- **Modular monolith** with clear domain boundaries (booking, payments, messaging, calendar-sync, analytics) — graduate to services only when load demands.
- **PostgreSQL** as system of record. Per-domain schemas in `shared/` re-exported from `schema.ts`.
- **Stateless API workers** behind a load balancer; sticky sessions only for SSE/streaming endpoints.
- **Background jobs** via a queue (BullMQ on Redis) for reminders, sync, post-completion triggers, and Stripe/Square reconciliation.
- **Soft-locks** for slot reservation use Postgres advisory locks + a `booking_slot_locks` table with TTL — no Redis dependency for correctness.
- **Idempotency keys** on every payment-creating endpoint to survive retries during traffic bursts.

---

## Module Roadmap

### Phase 1 — Booking Foundation (this PR)
**Goal:** Stand up the core data model so resource availability can be computed deterministically.

- ✅ `M1.1` Database schema for **Intelligent Resource Mapping** (resources, tags, capabilities, services, requirements)
- ✅ `M1.2` Database schema for **Availability Engine** (business hours, holidays, buffers, slot locks, appointments, appointment_resources)
- ✅ `M1.3` Storage interface stubs for the new tables
- `M1.4` Availability calculation service (`server/booking/availability.ts`) — pure function: `(date_range, service_id, resource_filters) → AvailableSlot[]`
- `M1.5` Slot soft-lock endpoint (`POST /api/booking/lock`) with 5-min TTL + lock release on checkout failure

### Phase 2 — Calendar Sync
- `M2.1` `calendar_connections` table + OAuth flows for Google, Microsoft Graph, iCal subscription
- `M2.2` Two-way sync worker — outbound on appointment write, inbound via webhooks (Google push, Graph subscriptions) + iCal polling
- `M2.3` DST-safe time math: store all timestamps in UTC with originating IANA timezone alongside; convert at presentation only
- `M2.4` Conflict resolution: external events block internal slots; internal appointments win on double-write

### Phase 3 — Payments & Revenue Protection
- `M3.1` Pluggable `PaymentProvider` interface — Stripe, Square, PayPal adapters
- `M3.2` `service_pricing_tiers` + `deposit_rules` (full | flat | percent) with per-tier overrides
- `M3.3` Stripe Payment Intents with 3DS, webhooks for `payment_intent.succeeded` / `.payment_failed` / `charge.dispute.created`
- `M3.4` PCI: never touch card data — always Elements/SDK; AES-256 at rest for any stored tokens; secrets via env only
- `M3.5` `client_risk_scores` table — running no-show count, last_no_show_at, risk_tier; auto-bump to 100% prepay at threshold
- `M3.6` Reminder chain engine — `reminder_schedules` + `reminder_jobs`; SMS via Twilio, email via SendGrid; one-tap confirm links signed with HMAC

### Phase 4 — Client Experience
- `M4.1` Public embeddable booking widget — `/embed/booking?service=...` route, vanilla JS bootstrap that injects an iframe; postMessage API for height auto-resize
- `M4.2` 3-click flow: pick service → pick slot → confirm + pay (deposit if required)
- `M4.3` Review automation — post-completion job triggers email with branded landing page; routes to Google/Yelp deep links or internal NPS
- `M4.4` Upsell engine — `service_addons` + `addon_rules` (context-aware: prior history, service tier, time-of-day)

### Phase 5 — Staff & Admin
- `M5.1` RBAC: extend `users.role` enum to `admin | manager | staff | client`; route guards + row-level filters in storage layer
- `M5.2` Audit log table for any access to PII or revenue data
- `M5.3` Analytics dashboard — utilization (booked / available hours), revenue/staff, LTV (rolling 12mo), retention cohort
- `M5.4` Virtual meeting integrations: Zoom OAuth + Google Meet via Calendar API; auto-refresh tokens; regenerate join links on reschedule

### Phase 6 — Scale & Hardening
- `M6.1` Read replicas + query routing for analytics
- `M6.2` Rate limiting per IP + per API key (token bucket in Redis)
- `M6.3` Burst-traffic handling — queue-based deferral for non-critical writes (reminders, analytics)
- `M6.4` Observability: structured logs, OpenTelemetry traces, RED metrics per endpoint
- `M6.5` Mobile parity — finalize REST surface; optional GraphQL gateway (`graphql-yoga`) for mobile-optimized batched queries

---

## Concurrency Safety Strategy (deep dive)

The hardest correctness problem is **two clients booking the same slot**. Approach:

1. **Read phase:** availability service reads candidate slots filtering against:
   - Existing `appointments` rows (status ∈ active set)
   - Active `booking_slot_locks` (not expired)
   - External `calendar_events` blocking time
   - Buffers from `service_buffer_rules`
2. **Lock phase:** client calls `POST /api/booking/lock` with `{resource_id, start, end, service_id}`. Server:
   - Begins transaction, takes Postgres advisory lock keyed by `hashtext(resource_id || day)`
   - Re-validates the slot is free
   - Inserts `booking_slot_locks` row with `expires_at = now() + 5min`, returns `lock_token`
3. **Confirm phase:** checkout submits `lock_token`. Server validates lock still valid, atomically converts lock → `appointment` in same transaction, releases lock.
4. **Cleanup:** background job sweeps expired locks every minute; UI-driven cancel hits `DELETE /api/booking/lock/:token`.

Postgres advisory locks give us serializability without a separate lock service. The `booking_slot_locks` table is the source of truth for "slot held but not yet purchased" so other readers immediately see it as taken.

### Resource-keyed overlap correctness

Each lock and appointment has a junction table (`booking_slot_lock_resources`, `appointment_resources`) that denormalizes `(resource_id, starts_at, ends_at, status)` so overlap queries can be answered by a single composite-index scan per resource. A follow-up SQL migration will add Postgres `EXCLUDE USING gist (resource_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status IN (...))` constraints on both junction tables, making double-booking physically impossible at the database level (Drizzle doesn't yet emit EXCLUDE constraints, so this is a hand-written migration).

---

## Open Questions / Decisions Needed

1. **Payment processor priority:** Stripe-first or all three at parity? (Affects M3 sequencing.)
2. **Mobile strategy:** native apps or PWA? GraphQL only justifies its complexity for native.
3. **Multi-location:** is CSD single-location or multi? Affects whether `locations` is a top-level entity or an attribute on resources.
4. **Existing CRM integration:** the platform already has `crm_contacts`/`crm_leads`/`crm_jobs`. Booking clients should reference `crm_contacts` to avoid duplication — confirm before wiring FK.

---

## Deliverables in This Change

- `shared/booking.ts` — full schema for resource mapping + availability engine
- `shared/schema.ts` — re-exports booking module
- `server/storage.ts` — `IStorage` extended with booking CRUD methods (stubs)
- This document

---

## Phase 1 Status (Apr 2026)

The intake-to-booking happy path is wired end-to-end:

- **Schema**: `timestamptz` everywhere, junction tables (`booking_slot_lock_resources`, `appointment_resources`), check constraints, composite overlap indexes. Pushed via `npm run db:push --force`.
- **Storage**: `IStorage` + `DatabaseStorage` cover resources, tags, services, requirements, business hours, time-off, holidays, slot locks, appointments, sweeper, and reference generation.
- **Availability engine** (`server/booking/availability-service.ts`): pure function honoring tz, business hours, holidays, time-off, buffers, lead time, advance window, and lock + appointment conflicts. Slots only emit when `start + duration` fits inside the working window.
- **Routes** (`server/booking/booking-routes.ts`):
  - `GET /api/booking/categories|services|services/:slug` — public catalog
  - `GET /api/booking/availability?serviceId&date&timezone` — slot grid
  - `POST /api/booking/locks` — **server is authoritative**: client supplies `(serviceId, startsAt, timezone)` only; server recomputes slots and matches by `startsAt`, then assigns `endsAt` and `resourceIds` from its own computation
  - `DELETE /api/booking/locks/:token` — best-effort release
  - `POST /api/booking/appointments` — atomic transaction: `SELECT … FOR UPDATE` on the lock, conflict re-check, appointment + appointment_resources insert, lock delete; replay returns 404
  - `GET /api/booking/appointments/:reference` — confirmation lookup
- **Sweeper**: `startSlotLockSweeper()` runs on startup, deletes expired locks every 60 s.
- **Seed** (`server/booking/seed.ts`): creates "Technician" tag, "Main Bench" resource (Mon–Fri 17:00–23:00 ET), and 7 default services mirroring the intake serviceType list, with deposits configured.
- **Frontend**:
  - `client/src/components/booking/slot-picker.tsx` — date input + time grid using server-formatted times.
  - `client/src/components/forms/csd-intake-form.tsx` — pulls service catalog from `/api/booking/services`, optional "schedule now" checkbox triggers `<SlotPicker>`. Submit flow: lock → POST /api/intake → confirm appointment. Lock is best-effort released if intake or confirm fails.

### Still Open / Phase 2

1. Hand-write SQL migration adding Postgres `EXCLUDE USING gist` constraints on the two junction tables for physical double-booking prevention.
2. Multi-timezone resources — availability currently uses request tz uniformly; resource-level tz should override.
3. Payment / deposit collection (deposit amount is computed but no charge step yet).
4. Customer-facing confirmation page at `/booking/confirmation/:reference`.
5. Staff calendar UI for managing resources, hours, time-off, and appointments.
