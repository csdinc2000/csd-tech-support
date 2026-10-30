-- CSD Call Manager — Phase 3 Schema
-- Adds: SMS messaging, message templates, blacklist (call/SMS block),
-- Do-Not-Call list (outbound suppression), spam score cache, app settings.
-- Run AFTER 003_phase2_schema.sql. No destructive changes to existing tables.

-- ─── Enums ───────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE message_status AS ENUM (
    'queued','sent','delivered','undelivered','failed','received'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE dnc_source AS ENUM ('manual','customer_request','national_dnc');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Phase 3 also lets a call be marked as 'blocked' (blacklist hit). Add the
-- value to the existing call_status enum if it isn't already there.
DO $$
DECLARE
  enum_oid OID;
BEGIN
  SELECT oid INTO enum_oid FROM pg_type WHERE typname = 'call_status';
  IF enum_oid IS NULL THEN
    -- calls.status is text in Phase 1; nothing to extend.
    NULL;
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_enum WHERE enumtypid = enum_oid AND enumlabel = 'blocked'
  ) THEN
    EXECUTE 'ALTER TYPE call_status ADD VALUE ''blocked''';
  END IF;
END $$;

-- ─── messages ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.messages (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  twilio_message_sid  TEXT UNIQUE,
  direction           message_direction NOT NULL,
  from_number         TEXT NOT NULL,
  to_number           TEXT NOT NULL,
  body                TEXT NOT NULL DEFAULT '',
  status              message_status NOT NULL DEFAULT 'queued',
  error_code          TEXT,
  media_urls          TEXT[],
  sent_by_user_id     UUID REFERENCES public.users(id) ON DELETE SET NULL,
  thread_key          TEXT NOT NULL,
  related_call_id     UUID REFERENCES public.calls(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_from_idx        ON public.messages(from_number);
CREATE INDEX IF NOT EXISTS messages_to_idx          ON public.messages(to_number);
CREATE INDEX IF NOT EXISTS messages_thread_key_idx  ON public.messages(thread_key);
CREATE INDEX IF NOT EXISTS messages_created_at_idx  ON public.messages(created_at DESC);

-- ─── message_templates ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.message_templates (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_by  UUID REFERENCES public.users(id) ON DELETE SET NULL,
  shared      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── blacklist (inbound block) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.blacklist (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone_number  TEXT NOT NULL UNIQUE,
  reason        TEXT,
  blocks_calls  BOOLEAN NOT NULL DEFAULT TRUE,
  blocks_sms    BOOLEAN NOT NULL DEFAULT TRUE,
  added_by      UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS blacklist_number_idx ON public.blacklist(phone_number);

-- ─── dnc_list (outbound suppression) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.dnc_list (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone_number  TEXT NOT NULL UNIQUE,
  source        dnc_source NOT NULL DEFAULT 'manual',
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dnc_number_idx ON public.dnc_list(phone_number);

-- ─── spam_scores (cache) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.spam_scores (
  phone_number  TEXT PRIMARY KEY,
  score         INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  sources       JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_checked  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── app_settings (key/value config; used for spam threshold etc.) ──────────
CREATE TABLE IF NOT EXISTS public.app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.app_settings (key, value)
  VALUES ('spam_threshold', '70'::jsonb)
  ON CONFLICT (key) DO NOTHING;

INSERT INTO public.app_settings (key, value)
  VALUES ('spam_screening_enabled', 'false'::jsonb)
  ON CONFLICT (key) DO NOTHING;

-- ─── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blacklist         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dnc_list          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.spam_scores       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings      ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS; these policies cover authenticated browser reads.
DO $$ BEGIN
  CREATE POLICY messages_read ON public.messages
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY templates_read ON public.message_templates
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY blacklist_read ON public.blacklist
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY dnc_read ON public.dnc_list
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY spam_read ON public.spam_scores
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE POLICY settings_read ON public.app_settings
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN null; END $$;
