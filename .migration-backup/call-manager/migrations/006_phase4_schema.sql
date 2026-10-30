-- ============================================================================
-- Phase 4: Admin, Partner Management, Email Templates, Settings
-- ============================================================================
-- New tables: organizations, org_memberships, email_templates,
-- notification_settings, invitations, notifications_log, role_audit.
--
-- Also extends `users` with: is_active, timezone, deactivated_at.
-- A default organization is created and every existing user is auto-added so
-- single-org installs continue to work without exposing partner UI.
-- ============================================================================

-- ── 1. Extend users ─────────────────────────────────────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS timezone        TEXT        NOT NULL DEFAULT 'America/New_York',
  ADD COLUMN IF NOT EXISTS deactivated_at  TIMESTAMPTZ;

-- ── 2. Enums ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE org_role AS ENUM ('owner','admin','tech','viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE email_trigger AS ENUM (
    'manual','missed_call','voicemail_received','new_customer','daily_digest','invitation'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_status AS ENUM ('queued','sent','failed','suppressed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. Organizations ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.organizations (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL,
  parent_org_id          UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  twilio_subaccount_sid  TEXT,
  settings               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS organizations_parent_idx ON public.organizations(parent_org_id);

-- ── 4. Org memberships ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.org_memberships (
  org_id   UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role     org_role NOT NULL DEFAULT 'viewer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS org_memberships_user_idx ON public.org_memberships(user_id);

-- ── 5. Email templates ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body_html   TEXT NOT NULL,
  body_text   TEXT NOT NULL,
  trigger     email_trigger NOT NULL DEFAULT 'manual',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_templates_org_trigger_idx ON public.email_templates(org_id, trigger);

-- ── 6. Notification settings (per user) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notification_settings (
  user_id              UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  missed_call_email    BOOLEAN NOT NULL DEFAULT TRUE,
  missed_call_sms      BOOLEAN NOT NULL DEFAULT FALSE,
  voicemail_email      BOOLEAN NOT NULL DEFAULT TRUE,
  voicemail_sms        BOOLEAN NOT NULL DEFAULT FALSE,
  daily_digest_email   BOOLEAN NOT NULL DEFAULT FALSE,
  daily_digest_time    TIME    NOT NULL DEFAULT '08:00',
  quiet_hours_start    TIME,
  quiet_hours_end      TIME,
  unsubscribe_token    TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 7. Invitations ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.invitations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  org_id        UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role          org_role NOT NULL DEFAULT 'viewer',
  invited_by    UUID REFERENCES public.users(id) ON DELETE SET NULL,
  token         TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  accepted_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invitations_token_idx ON public.invitations(token);
CREATE INDEX IF NOT EXISTS invitations_email_idx ON public.invitations(LOWER(email));

-- ── 8. Notifications log (sent + queued) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notifications_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES public.users(id) ON DELETE SET NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('email','sms')),
  trigger         email_trigger NOT NULL,
  to_address      TEXT NOT NULL,
  subject         TEXT,
  body            TEXT,
  status          notification_status NOT NULL DEFAULT 'queued',
  context         JSONB NOT NULL DEFAULT '{}'::jsonb,
  deliver_after   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at    TIMESTAMPTZ,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_log_user_idx ON public.notifications_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_log_pending_idx
  ON public.notifications_log(deliver_after) WHERE status = 'queued';

-- ── 9. Role audit log ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.role_audit (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  changed_by   UUID REFERENCES public.users(id) ON DELETE SET NULL,
  old_role     TEXT,
  new_role     TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'global',  -- 'global' (users.role) or org_id
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS role_audit_user_idx ON public.role_audit(user_id, created_at DESC);

-- ── 10. RLS — enable + simple authenticated policies ────────────────────────
ALTER TABLE public.organizations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_memberships       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_templates       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_audit            ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "organizations: authenticated read" ON public.organizations FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "org_memberships: authenticated read" ON public.org_memberships FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "email_templates: authenticated read" ON public.email_templates FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "notification_settings: own row" ON public.notification_settings FOR ALL TO authenticated
    USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "invitations: authenticated read" ON public.invitations FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "notifications_log: own rows" ON public.notifications_log FOR SELECT TO authenticated
    USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "role_audit: authenticated read" ON public.role_audit FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 11. Default organization + membership backfill ──────────────────────────
INSERT INTO public.organizations (id, name)
SELECT '00000000-0000-0000-0000-000000000001'::uuid, 'Computer Systems Depot'
WHERE NOT EXISTS (SELECT 1 FROM public.organizations);

-- Add every existing user to the default org with their existing role
INSERT INTO public.org_memberships (org_id, user_id, role)
SELECT
  (SELECT id FROM public.organizations ORDER BY created_at ASC LIMIT 1),
  u.id,
  CASE u.role::text
    WHEN 'owner'  THEN 'owner'::org_role
    WHEN 'tech'   THEN 'tech'::org_role
    WHEN 'viewer' THEN 'viewer'::org_role
    ELSE 'viewer'::org_role
  END
FROM public.users u
ON CONFLICT (org_id, user_id) DO NOTHING;

-- Default notification_settings row for every existing user
INSERT INTO public.notification_settings (user_id)
SELECT id FROM public.users
ON CONFLICT (user_id) DO NOTHING;

-- ── 12. Sample email templates ──────────────────────────────────────────────
INSERT INTO public.email_templates (org_id, name, subject, body_html, body_text, trigger)
SELECT
  (SELECT id FROM public.organizations ORDER BY created_at ASC LIMIT 1),
  'Missed call — default',
  'Missed call from {{from_number}}',
  '<p>Hi {{recipient_name}},</p>'
  '<p>You missed a call from <strong>{{from_number}}</strong>'
  '{{#customer_name}} ({{customer_name}}){{/customer_name}} at {{call_time}}.</p>'
  '<p><a href="{{call_url}}">View call in CSD Call Manager</a></p>',
  'Hi {{recipient_name}}, you missed a call from {{from_number}} at {{call_time}}. '
  'View call: {{call_url}}',
  'missed_call'
WHERE NOT EXISTS (SELECT 1 FROM public.email_templates WHERE trigger = 'missed_call');

INSERT INTO public.email_templates (org_id, name, subject, body_html, body_text, trigger)
SELECT
  (SELECT id FROM public.organizations ORDER BY created_at ASC LIMIT 1),
  'Voicemail received — default',
  'New voicemail from {{from_number}}',
  '<p>Hi {{recipient_name}},</p>'
  '<p>A new voicemail was received from <strong>{{from_number}}</strong> at {{call_time}}'
  ' ({{duration}}s).</p>'
  '<p><a href="{{voicemail_url}}">Listen in CSD Call Manager</a></p>',
  'Hi {{recipient_name}}, a new voicemail from {{from_number}} ({{duration}}s) at {{call_time}}. '
  'Listen: {{voicemail_url}}',
  'voicemail_received'
WHERE NOT EXISTS (SELECT 1 FROM public.email_templates WHERE trigger = 'voicemail_received');

INSERT INTO public.email_templates (org_id, name, subject, body_html, body_text, trigger)
SELECT
  (SELECT id FROM public.organizations ORDER BY created_at ASC LIMIT 1),
  'Daily digest — default',
  'Your CSD daily digest — {{date}}',
  '<p>Hi {{recipient_name}},</p>'
  '<p>Yesterday at CSD: <strong>{{call_count}}</strong> calls, '
  '<strong>{{voicemail_count}}</strong> new voicemails, '
  '<strong>{{message_count}}</strong> SMS exchanges.</p>'
  '<p><a href="{{dashboard_url}}">Open dashboard</a></p>'
  '<hr><p style="font-size:11px;color:#888">'
  '<a href="{{unsubscribe_url}}">Unsubscribe from daily digest</a></p>',
  'Hi {{recipient_name}}, yesterday: {{call_count}} calls, {{voicemail_count}} voicemails, '
  '{{message_count}} SMS. Open: {{dashboard_url}} — Unsubscribe: {{unsubscribe_url}}',
  'daily_digest'
WHERE NOT EXISTS (SELECT 1 FROM public.email_templates WHERE trigger = 'daily_digest');

INSERT INTO public.email_templates (org_id, name, subject, body_html, body_text, trigger)
SELECT
  (SELECT id FROM public.organizations ORDER BY created_at ASC LIMIT 1),
  'Invitation — default',
  'You''re invited to {{org_name}} on CSD Call Manager',
  '<p>Hi,</p>'
  '<p>{{inviter_name}} invited you to join <strong>{{org_name}}</strong> on CSD Call Manager '
  'as a <strong>{{role}}</strong>.</p>'
  '<p><a href="{{accept_url}}">Accept invitation</a> — link expires {{expires_at}}.</p>',
  'Hi, {{inviter_name}} invited you to {{org_name}} on CSD Call Manager as {{role}}. '
  'Accept: {{accept_url}} (expires {{expires_at}})',
  'invitation'
WHERE NOT EXISTS (SELECT 1 FROM public.email_templates WHERE trigger = 'invitation');
