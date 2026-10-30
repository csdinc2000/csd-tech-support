-- CSD Call Manager — Initial Schema
-- Run in Supabase SQL Editor

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enums
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('owner', 'tech', 'viewer');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE call_direction AS ENUM ('inbound', 'outbound');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE call_status AS ENUM (
    'queued', 'ringing', 'in-progress', 'completed',
    'busy', 'no-answer', 'failed', 'canceled'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Users profile table (extends auth.users)
CREATE TABLE IF NOT EXISTS public.users (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT UNIQUE NOT NULL,
  full_name   TEXT NOT NULL DEFAULT '',
  role        user_role NOT NULL DEFAULT 'viewer',
  phone       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Calls table
CREATE TABLE IF NOT EXISTS public.calls (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  twilio_call_sid       TEXT UNIQUE NOT NULL,
  direction             call_direction NOT NULL,
  from_number           TEXT NOT NULL,
  to_number             TEXT NOT NULL,
  status                call_status NOT NULL DEFAULT 'queued',
  duration_seconds      INTEGER,
  recording_url         TEXT,
  recording_sid         TEXT,
  ivr_selection         TEXT,
  assigned_to_user_id   UUID REFERENCES public.users(id) ON DELETE SET NULL,
  customer_name         TEXT,
  ticket_number         TEXT,
  notes                 TEXT,
  tags                  TEXT[],
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at              TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calls_twilio_call_sid ON public.calls(twilio_call_sid);
CREATE INDEX IF NOT EXISTS idx_calls_from_number    ON public.calls(from_number);
CREATE INDEX IF NOT EXISTS idx_calls_to_number      ON public.calls(to_number);
CREATE INDEX IF NOT EXISTS idx_calls_started_at     ON public.calls(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_status         ON public.calls(status);

-- Call events (audit trail)
CREATE TABLE IF NOT EXISTS public.call_events (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id        UUID NOT NULL REFERENCES public.calls(id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}',
  actor_user_id  UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_events_call_id ON public.call_events(call_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_calls_updated_at ON public.calls;
CREATE TRIGGER update_calls_updated_at
  BEFORE UPDATE ON public.calls
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-create user profile on sign-up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE((NEW.raw_user_meta_data->>'role')::user_role, 'viewer')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ─────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────
ALTER TABLE public.users       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calls       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_events ENABLE ROW LEVEL SECURITY;

-- Helper: get role of calling user (SECURITY DEFINER bypasses RLS loop)
CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS user_role AS $$
  SELECT role FROM public.users WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- USERS policies
CREATE POLICY "users: own row read/update"
  ON public.users FOR ALL
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "users: owner full access"
  ON public.users FOR ALL
  USING (public.current_user_role() = 'owner');

CREATE POLICY "users: tech/viewer read all"
  ON public.users FOR SELECT
  USING (public.current_user_role() IN ('tech', 'viewer'));

-- CALLS policies
CREATE POLICY "calls: owner full access"
  ON public.calls FOR ALL
  USING (public.current_user_role() = 'owner');

CREATE POLICY "calls: tech read all + write limited fields"
  ON public.calls FOR SELECT
  USING (public.current_user_role() = 'tech');

CREATE POLICY "calls: tech update allowed"
  ON public.calls FOR UPDATE
  USING (public.current_user_role() = 'tech');

CREATE POLICY "calls: viewer read only"
  ON public.calls FOR SELECT
  USING (public.current_user_role() = 'viewer');

-- CALL_EVENTS policies
CREATE POLICY "call_events: owner full access"
  ON public.call_events FOR ALL
  USING (public.current_user_role() = 'owner');

CREATE POLICY "call_events: tech read + insert"
  ON public.call_events FOR SELECT
  USING (public.current_user_role() = 'tech');

CREATE POLICY "call_events: tech insert"
  ON public.call_events FOR INSERT
  WITH CHECK (public.current_user_role() = 'tech');

CREATE POLICY "call_events: viewer read only"
  ON public.call_events FOR SELECT
  USING (public.current_user_role() = 'viewer');

-- Service role bypasses RLS automatically — webhooks use service role key.
