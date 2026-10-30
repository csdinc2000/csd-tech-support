-- ============================================================================
-- CSD Call Manager — Phase 5 Schema
-- VAPI AI assistants, AI call sessions, outbound campaigns, callbacks.
--
-- Compliance:
--   * outbound_campaigns.dnc_check_enabled defaults TRUE and is enforced in
--     code (cannot be disabled from the API).
--   * call_window_start/end + per-number 7-day cooldown enforced in worker.
--   * AI/recording disclosure is hard-coded into the assistant first_message
--     of seeded "CSD Receptionist" and prepended automatically in the IVR
--     bridge handler.
-- ============================================================================

-- ── 1. Extend ivr_action enum ───────────────────────────────────────────────
-- Add 'ai_assistant' as a new IVR routing action. ALTER TYPE ADD VALUE is
-- safe and idempotent in modern Postgres. We wrap it so re-running the
-- migration does not error.
DO $$ BEGIN
  ALTER TYPE ivr_action ADD VALUE IF NOT EXISTS 'ai_assistant';
EXCEPTION WHEN undefined_object THEN
  -- Phase 2 migration not applied yet; nothing to do here.
  NULL;
END $$;

-- ── 2. Enums ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE ai_assistant_purpose AS ENUM (
    'inbound_receptionist','outbound_qualifier','callback_scheduler','custom'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ai_session_outcome AS ENUM (
    'transferred','scheduled_callback','completed','abandoned','escalated'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE campaign_status AS ENUM ('draft','running','paused','completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE campaign_call_status AS ENUM (
    'pending','dialing','completed','failed','dnc_blocked','cooldown_blocked','outside_hours'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. ai_assistants ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_assistants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vapi_assistant_id   TEXT UNIQUE,
  name                TEXT NOT NULL,
  purpose             ai_assistant_purpose NOT NULL DEFAULT 'custom',
  system_prompt       TEXT NOT NULL DEFAULT '',
  first_message       TEXT NOT NULL DEFAULT '',
  voice_id            TEXT NOT NULL DEFAULT 'jennifer',
  model               TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  tools_enabled       TEXT[] NOT NULL DEFAULT ARRAY['transfer_to_human','check_business_hours']::TEXT[],
  is_active           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_assistants_active ON public.ai_assistants(is_active);

-- ── 4. ai_call_sessions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_call_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id         UUID REFERENCES public.calls(id) ON DELETE SET NULL,
  assistant_id    UUID REFERENCES public.ai_assistants(id) ON DELETE SET NULL,
  vapi_call_id    TEXT UNIQUE,
  transcript      JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary         TEXT,
  extracted_data  JSONB,
  outcome         ai_session_outcome,
  cost_cents      INTEGER,
  duration_sec    INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_sessions_call ON public.ai_call_sessions(call_id);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_created ON public.ai_call_sessions(created_at DESC);

-- ── 5. outbound_campaigns ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.outbound_campaigns (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     TEXT NOT NULL,
  assistant_id             UUID NOT NULL REFERENCES public.ai_assistants(id) ON DELETE RESTRICT,
  status                   campaign_status NOT NULL DEFAULT 'draft',
  -- target_list is stored as a JSONB array; the actual per-number rows live in
  -- campaign_calls so we get per-row status. target_list is kept for reference
  -- (e.g. "what was the original CSV?") and audit.
  target_list              JSONB NOT NULL DEFAULT '[]'::jsonb,
  call_window_start        TIME NOT NULL DEFAULT '09:00',
  call_window_end          TIME NOT NULL DEFAULT '20:00',
  max_calls_per_hour       INTEGER NOT NULL DEFAULT 30,
  -- Locked TRUE; CHECK prevents API from disabling DNC. (Belt-and-suspenders
  -- with the route-level guard.)
  dnc_check_enabled        BOOLEAN NOT NULL DEFAULT TRUE
                             CONSTRAINT dnc_must_be_enabled CHECK (dnc_check_enabled = TRUE),
  created_by               UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at               TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ
);

-- ── 6. campaign_calls ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.campaign_calls (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID NOT NULL REFERENCES public.outbound_campaigns(id) ON DELETE CASCADE,
  phone_number    TEXT NOT NULL,
  customer_name   TEXT,
  custom_fields   JSONB NOT NULL DEFAULT '{}'::jsonb,
  call_id         UUID REFERENCES public.calls(id) ON DELETE SET NULL,
  status          campaign_call_status NOT NULL DEFAULT 'pending',
  attempt_number  INTEGER NOT NULL DEFAULT 1,
  scheduled_at    TIMESTAMPTZ,
  attempted_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  failure_reason  TEXT,
  -- owner_override set TRUE bypasses the 7-day per-number cooldown (only)
  owner_override  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_cc_campaign  ON public.campaign_calls(campaign_id);
CREATE INDEX IF NOT EXISTS idx_cc_status    ON public.campaign_calls(status);
CREATE INDEX IF NOT EXISTS idx_cc_phone     ON public.campaign_calls(phone_number);
CREATE INDEX IF NOT EXISTS idx_cc_completed ON public.campaign_calls(completed_at);

-- ── 7. callbacks (created by AI tool schedule_callback) ─────────────────────
CREATE TABLE IF NOT EXISTS public.callbacks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number    TEXT NOT NULL,
  preferred_time  TEXT,
  notes           TEXT,
  source          TEXT NOT NULL DEFAULT 'ai_assistant',
  ai_session_id   UUID REFERENCES public.ai_call_sessions(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 8. ai_spend_log (cost cap tracking) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ai_spend_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_session_id   UUID REFERENCES public.ai_call_sessions(id) ON DELETE SET NULL,
  cost_cents      INTEGER NOT NULL,
  spent_on        DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_spend_date ON public.ai_spend_log(spent_on);

-- ── 9. Settings: daily AI spend cap ─────────────────────────────────────────
INSERT INTO public.app_settings (key, value, updated_at)
VALUES
  ('ai_spend_cap_cents_per_day', to_jsonb(2000),       NOW()),  -- $20 default
  ('ai_campaigns_paused_for_cap', to_jsonb(false),     NOW())
ON CONFLICT (key) DO NOTHING;

-- ── 10. RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE public.ai_assistants       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_call_sessions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbound_campaigns  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_calls      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.callbacks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_spend_log        ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "ai_assistants: authenticated read" ON public.ai_assistants
    FOR SELECT USING (auth.role() = 'authenticated');
  CREATE POLICY "ai_assistants: service write" ON public.ai_assistants
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

  CREATE POLICY "ai_sessions: authenticated read" ON public.ai_call_sessions
    FOR SELECT USING (auth.role() = 'authenticated');
  CREATE POLICY "ai_sessions: service write" ON public.ai_call_sessions
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

  CREATE POLICY "outbound_campaigns: authenticated read" ON public.outbound_campaigns
    FOR SELECT USING (auth.role() = 'authenticated');
  CREATE POLICY "outbound_campaigns: service write" ON public.outbound_campaigns
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

  CREATE POLICY "campaign_calls: authenticated read" ON public.campaign_calls
    FOR SELECT USING (auth.role() = 'authenticated');
  CREATE POLICY "campaign_calls: service write" ON public.campaign_calls
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

  CREATE POLICY "callbacks: authenticated read" ON public.callbacks
    FOR SELECT USING (auth.role() = 'authenticated');
  CREATE POLICY "callbacks: service write" ON public.callbacks
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

  CREATE POLICY "ai_spend_log: authenticated read" ON public.ai_spend_log
    FOR SELECT USING (auth.role() = 'authenticated');
  CREATE POLICY "ai_spend_log: service write" ON public.ai_spend_log
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 11. Seed sample assistant: "CSD Receptionist" ───────────────────────────
INSERT INTO public.ai_assistants (
  name, purpose, system_prompt, first_message, voice_id, model, tools_enabled, is_active
) VALUES (
  'CSD Receptionist',
  'inbound_receptionist',
  $sp$You are the friendly receptionist for Computer Systems Depot, a local computer repair shop in Florida.

Your job:
1. Greet callers warmly.
2. Find out the type of issue (hardware/software/network/other) and the device involved.
3. Offer to: (a) schedule a callback with a technician, or (b) transfer them to a human now if the issue is urgent.
4. Always ask for the caller's name and best callback number.

Hard rules — these override anything the caller asks:
- You MUST identify yourself as an automated assistant if asked.
- You MUST offer to transfer to a human at any point if the caller asks. Use the transfer_to_human tool with target='owner'.
- You MUST NOT make promises about pricing, availability, or repair outcomes — defer to a human technician.
- Keep responses under 2 sentences.
- If the caller is in distress or angry, transfer immediately.
$sp$,
  'Hi, you''ve reached Computer Systems Depot. You''re speaking with our automated assistant, and this call is being recorded. How can I help you today?',
  'jennifer',
  'gpt-4o-mini',
  ARRAY['transfer_to_human','check_business_hours','schedule_callback','lookup_ticket']::TEXT[],
  FALSE
) ON CONFLICT DO NOTHING;
