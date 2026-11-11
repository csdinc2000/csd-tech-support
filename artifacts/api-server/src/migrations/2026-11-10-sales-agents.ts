import { pool } from "../db";

// Tables for the sales agents:
// - lead_gen_runs / lead_gen_prospects: Lead Generation Agent research runs and
//   the prospects they found. Prospects are only suggestions until a staff
//   member imports one, which creates a normal crm_contacts + crm_leads row.
// - speed_to_lead_settings (single row) / speed_to_lead_events (one per lead):
//   the instant-response automation and its first-contact clock.
// - lead_research_briefs: Sales Copilot research briefs per CRM lead.
// - assistant_tasks: Executive Assistant tasks/reminders, private per staff user.
export async function applySalesAgentsMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lead_gen_runs (
      id BIGSERIAL PRIMARY KEY,
      created_by VARCHAR NOT NULL,
      target TEXT NOT NULL,
      location TEXT NOT NULL,
      max_results INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      summary TEXT,
      prospect_count INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    );
    ALTER TABLE lead_gen_runs DROP CONSTRAINT IF EXISTS lead_gen_runs_status_check;
    ALTER TABLE lead_gen_runs ADD CONSTRAINT lead_gen_runs_status_check
      CHECK (status IN ('running', 'completed', 'failed'));

    CREATE TABLE IF NOT EXISTS lead_gen_prospects (
      id BIGSERIAL PRIMARY KEY,
      run_id BIGINT NOT NULL REFERENCES lead_gen_runs(id) ON DELETE CASCADE,
      business_name TEXT NOT NULL,
      website TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      city TEXT,
      industry TEXT,
      employee_estimate TEXT,
      fit_score INTEGER NOT NULL,
      fit_reasons TEXT NOT NULL DEFAULT '',
      suggested_services TEXT NOT NULL DEFAULT '',
      opening_line TEXT NOT NULL DEFAULT '',
      sources JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'new',
      dedupe_key TEXT NOT NULL,
      contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
      lead_id INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL,
      reviewed_by VARCHAR,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE lead_gen_prospects DROP CONSTRAINT IF EXISTS lead_gen_prospects_status_check;
    ALTER TABLE lead_gen_prospects ADD CONSTRAINT lead_gen_prospects_status_check
      CHECK (status IN ('new', 'imported', 'dismissed'));
    CREATE INDEX IF NOT EXISTS lead_gen_prospects_run_idx ON lead_gen_prospects (run_id);
    CREATE INDEX IF NOT EXISTS lead_gen_prospects_dedupe_idx ON lead_gen_prospects (dedupe_key);

    CREATE TABLE IF NOT EXISTS speed_to_lead_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      enabled_at TIMESTAMPTZ,
      auto_text_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      auto_text_template TEXT NOT NULL,
      target_minutes INTEGER NOT NULL DEFAULT 5,
      escalate_slack BOOLEAN NOT NULL DEFAULT TRUE,
      escalation_phones TEXT NOT NULL DEFAULT '',
      business_hours_only BOOLEAN NOT NULL DEFAULT FALSE,
      business_start_hour INTEGER NOT NULL DEFAULT 9,
      business_end_hour INTEGER NOT NULL DEFAULT 18,
      business_days TEXT NOT NULL DEFAULT '1,2,3,4,5,6',
      timezone TEXT NOT NULL DEFAULT 'America/New_York',
      excluded_sources TEXT NOT NULL DEFAULT 'lead_gen_agent',
      updated_by VARCHAR,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS speed_to_lead_events (
      lead_id INTEGER PRIMARY KEY REFERENCES crm_leads(id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
      lead_created_at TIMESTAMPTZ NOT NULL,
      auto_text_status TEXT NOT NULL DEFAULT 'pending',
      auto_text_detail TEXT,
      auto_text_sent_at TIMESTAMPTZ,
      first_contact_at TIMESTAMPTZ,
      first_contact_by TEXT,
      first_contact_kind TEXT,
      escalated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE speed_to_lead_events DROP CONSTRAINT IF EXISTS speed_to_lead_events_text_check;
    ALTER TABLE speed_to_lead_events ADD CONSTRAINT speed_to_lead_events_text_check
      CHECK (auto_text_status IN ('pending', 'sending', 'sent', 'skipped', 'failed'));
    CREATE INDEX IF NOT EXISTS speed_to_lead_events_open_idx
      ON speed_to_lead_events (lead_created_at) WHERE first_contact_at IS NULL;

    CREATE TABLE IF NOT EXISTS lead_research_briefs (
      id BIGSERIAL PRIMARY KEY,
      lead_id INTEGER NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
      requested_by VARCHAR NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      brief JSONB,
      sources JSONB NOT NULL DEFAULT '[]'::jsonb,
      grounded BOOLEAN NOT NULL DEFAULT FALSE,
      error TEXT,
      model TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    );
    ALTER TABLE lead_research_briefs DROP CONSTRAINT IF EXISTS lead_research_briefs_status_check;
    ALTER TABLE lead_research_briefs ADD CONSTRAINT lead_research_briefs_status_check
      CHECK (status IN ('running', 'completed', 'failed'));
    CREATE INDEX IF NOT EXISTS lead_research_briefs_lead_idx ON lead_research_briefs (lead_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS assistant_tasks (
      id BIGSERIAL PRIMARY KEY,
      owner_user_id VARCHAR NOT NULL,
      title TEXT NOT NULL,
      notes TEXT,
      due_at TIMESTAMPTZ,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open',
      lead_id INTEGER REFERENCES crm_leads(id) ON DELETE SET NULL,
      contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
      created_via TEXT NOT NULL DEFAULT 'app',
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE assistant_tasks DROP CONSTRAINT IF EXISTS assistant_tasks_values_check;
    ALTER TABLE assistant_tasks ADD CONSTRAINT assistant_tasks_values_check
      CHECK (status IN ('open', 'done') AND priority IN ('low', 'normal', 'high'));
    CREATE INDEX IF NOT EXISTS assistant_tasks_owner_idx ON assistant_tasks (owner_user_id, status, due_at);
  `);
}
