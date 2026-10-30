-- CSD Call Manager — Phase 2 Schema
-- Adds: business hours, holidays, IVR menus/options, queues, voicemails
-- Run AFTER 001_initial_schema.sql. No destructive changes to existing tables.

-- ─── Enums ───────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE business_hours_state AS ENUM ('open', 'closed', 'either');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE ivr_action AS ENUM ('forward', 'voicemail', 'submenu', 'queue', 'hangup');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE queue_strategy AS ENUM ('ring_all', 'round_robin', 'least_recent');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE queue_timeout_action AS ENUM ('voicemail', 'forward');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─── business_hours ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.business_hours (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  day_of_week   SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  open_time     TIME,
  close_time    TIME,
  timezone      TEXT NOT NULL DEFAULT 'America/New_York',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (day_of_week)
);

-- ─── holidays ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.holidays (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  date        DATE NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  closed      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_holidays_date ON public.holidays(date);

-- ─── ivr_menus ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ivr_menus (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                  TEXT NOT NULL UNIQUE,
  greeting_text         TEXT NOT NULL DEFAULT '',
  greeting_audio_url    TEXT,
  timeout_seconds       INTEGER NOT NULL DEFAULT 7 CHECK (timeout_seconds BETWEEN 1 AND 60),
  is_default            BOOLEAN NOT NULL DEFAULT FALSE,
  business_hours_state  business_hours_state NOT NULL DEFAULT 'either',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one default per state
CREATE UNIQUE INDEX IF NOT EXISTS idx_ivr_menus_default_per_state
  ON public.ivr_menus(business_hours_state)
  WHERE is_default = TRUE;

DROP TRIGGER IF EXISTS update_ivr_menus_updated_at ON public.ivr_menus;
CREATE TRIGGER update_ivr_menus_updated_at
  BEFORE UPDATE ON public.ivr_menus
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── ivr_options ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ivr_options (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  menu_id     UUID NOT NULL REFERENCES public.ivr_menus(id) ON DELETE CASCADE,
  digit       TEXT NOT NULL CHECK (digit ~ '^[0-9*#]$'),
  label       TEXT NOT NULL,
  action      ivr_action NOT NULL,
  target      TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (menu_id, digit)
);

CREATE INDEX IF NOT EXISTS idx_ivr_options_menu_id ON public.ivr_options(menu_id);

-- ─── call_queues ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.call_queues (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                TEXT NOT NULL UNIQUE,
  strategy            queue_strategy NOT NULL DEFAULT 'ring_all',
  max_wait_seconds    INTEGER NOT NULL DEFAULT 60 CHECK (max_wait_seconds BETWEEN 5 AND 600),
  on_timeout_action   queue_timeout_action NOT NULL DEFAULT 'voicemail',
  on_timeout_target   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── queue_members ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.queue_members (
  queue_id    UUID NOT NULL REFERENCES public.call_queues(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  priority    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (queue_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_queue_members_user_id ON public.queue_members(user_id);

-- ─── voicemails ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.voicemails (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id           UUID NOT NULL REFERENCES public.calls(id) ON DELETE CASCADE,
  recording_sid     TEXT,
  recording_url     TEXT NOT NULL,
  transcription     TEXT,
  duration_seconds  INTEGER NOT NULL DEFAULT 0,
  is_listened       BOOLEAN NOT NULL DEFAULT FALSE,
  listened_at       TIMESTAMPTZ,
  listened_by       UUID REFERENCES public.users(id) ON DELETE SET NULL,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voicemails_call_id        ON public.voicemails(call_id);
CREATE INDEX IF NOT EXISTS idx_voicemails_is_listened    ON public.voicemails(is_listened);
CREATE INDEX IF NOT EXISTS idx_voicemails_created_at     ON public.voicemails(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_voicemails_recording_sid
  ON public.voicemails(recording_sid) WHERE recording_sid IS NOT NULL;

-- ─── Row Level Security ──────────────────────────────────────────────────────
ALTER TABLE public.business_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holidays       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ivr_menus      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ivr_options    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_queues    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voicemails     ENABLE ROW LEVEL SECURITY;

-- Owner full access on configuration tables
CREATE POLICY "business_hours: owner full access" ON public.business_hours FOR ALL
  USING (public.current_user_role() = 'owner');
CREATE POLICY "business_hours: read for tech/viewer" ON public.business_hours FOR SELECT
  USING (public.current_user_role() IN ('tech', 'viewer'));

CREATE POLICY "holidays: owner full access" ON public.holidays FOR ALL
  USING (public.current_user_role() = 'owner');
CREATE POLICY "holidays: read for tech/viewer" ON public.holidays FOR SELECT
  USING (public.current_user_role() IN ('tech', 'viewer'));

CREATE POLICY "ivr_menus: owner full access" ON public.ivr_menus FOR ALL
  USING (public.current_user_role() = 'owner');
CREATE POLICY "ivr_menus: read for tech/viewer" ON public.ivr_menus FOR SELECT
  USING (public.current_user_role() IN ('tech', 'viewer'));

CREATE POLICY "ivr_options: owner full access" ON public.ivr_options FOR ALL
  USING (public.current_user_role() = 'owner');
CREATE POLICY "ivr_options: read for tech/viewer" ON public.ivr_options FOR SELECT
  USING (public.current_user_role() IN ('tech', 'viewer'));

CREATE POLICY "call_queues: owner full access" ON public.call_queues FOR ALL
  USING (public.current_user_role() = 'owner');
CREATE POLICY "call_queues: read for tech/viewer" ON public.call_queues FOR SELECT
  USING (public.current_user_role() IN ('tech', 'viewer'));

CREATE POLICY "queue_members: owner full access" ON public.queue_members FOR ALL
  USING (public.current_user_role() = 'owner');
CREATE POLICY "queue_members: read for tech/viewer" ON public.queue_members FOR SELECT
  USING (public.current_user_role() IN ('tech', 'viewer'));

-- Voicemails: owner + tech full read, owner full update
CREATE POLICY "voicemails: owner full access" ON public.voicemails FOR ALL
  USING (public.current_user_role() = 'owner');
CREATE POLICY "voicemails: tech read + update" ON public.voicemails FOR SELECT
  USING (public.current_user_role() = 'tech');
CREATE POLICY "voicemails: tech update" ON public.voicemails FOR UPDATE
  USING (public.current_user_role() = 'tech');
CREATE POLICY "voicemails: viewer read" ON public.voicemails FOR SELECT
  USING (public.current_user_role() = 'viewer');
