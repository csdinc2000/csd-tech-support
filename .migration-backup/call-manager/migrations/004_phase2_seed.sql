-- CSD Call Manager — Phase 2 Seed Data
-- Default business hours (Mon–Fri 9–6 ET), default open IVR matching Phase 1, default tech queue.
-- Safe to run multiple times (uses ON CONFLICT DO NOTHING / UPSERT).

-- ─── Business hours: Mon–Fri 9:00–18:00 ET, Sat/Sun closed ───────────────────
INSERT INTO public.business_hours (day_of_week, open_time, close_time, timezone) VALUES
  (0, NULL,       NULL,       'America/New_York'),  -- Sunday closed
  (1, '09:00:00', '18:00:00', 'America/New_York'),  -- Monday
  (2, '09:00:00', '18:00:00', 'America/New_York'),  -- Tuesday
  (3, '09:00:00', '18:00:00', 'America/New_York'),  -- Wednesday
  (4, '09:00:00', '18:00:00', 'America/New_York'),  -- Thursday
  (5, '09:00:00', '18:00:00', 'America/New_York'),  -- Friday
  (6, NULL,       NULL,       'America/New_York')   -- Saturday closed
ON CONFLICT (day_of_week) DO NOTHING;

-- ─── Default 'open' IVR menu (matches Phase 1 verbatim) ──────────────────────
INSERT INTO public.ivr_menus (name, greeting_text, timeout_seconds, is_default, business_hours_state)
VALUES (
  'main_open',
  'For repair status or an existing ticket, press 1. ' ||
  'For a new service request, press 2. ' ||
  'For remote support or an RMM issue, press 3. ' ||
  'To speak with the owner, press 0.',
  10,
  TRUE,
  'open'
)
ON CONFLICT (name) DO NOTHING;

-- Options for main_open — all forward to owner mobile, matching Phase 1 behavior.
-- The `target` for 'forward' actions is the env var TWILIO_OWNER_FORWARD_NUMBER at runtime
-- (we use the literal string 'OWNER_FORWARD' as a sentinel that the webhook resolves).
INSERT INTO public.ivr_options (menu_id, digit, label, action, target, sort_order)
SELECT m.id, v.digit, v.label, v.action::ivr_action, v.target, v.sort_order
FROM public.ivr_menus m,
     (VALUES
       ('1', 'Repair status / existing ticket', 'forward', 'OWNER_FORWARD', 1),
       ('2', 'New service request',             'forward', 'OWNER_FORWARD', 2),
       ('3', 'Remote support / RMM issue',      'forward', 'OWNER_FORWARD', 3),
       ('0', 'Speak with the owner',            'forward', 'OWNER_FORWARD', 4)
     ) AS v(digit, label, action, target, sort_order)
WHERE m.name = 'main_open'
ON CONFLICT (menu_id, digit) DO NOTHING;

-- ─── Default 'closed' IVR menu — brief greeting then voicemail ───────────────
INSERT INTO public.ivr_menus (name, greeting_text, timeout_seconds, is_default, business_hours_state)
VALUES (
  'main_closed',
  'Thank you for calling Computer Systems Depot. We are currently closed. ' ||
  'Our normal hours are Monday through Friday, 9 a.m. to 6 p.m. Eastern. ' ||
  'Please leave a message after the tone and we will return your call the next business day.',
  3,
  TRUE,
  'closed'
)
ON CONFLICT (name) DO NOTHING;

-- After-hours menu has a single implicit voicemail option (no digit input expected).
-- We model this with a '#' digit so the webhook can fall through to voicemail on timeout.
INSERT INTO public.ivr_options (menu_id, digit, label, action, target, sort_order)
SELECT m.id, '#', 'Leave a voicemail', 'voicemail', NULL, 1
FROM public.ivr_menus m
WHERE m.name = 'main_closed'
ON CONFLICT (menu_id, digit) DO NOTHING;

-- ─── Default tech queue (empty members; owner adds later) ────────────────────
INSERT INTO public.call_queues (name, strategy, max_wait_seconds, on_timeout_action, on_timeout_target)
VALUES ('tech_main', 'ring_all', 60, 'voicemail', NULL)
ON CONFLICT (name) DO NOTHING;
