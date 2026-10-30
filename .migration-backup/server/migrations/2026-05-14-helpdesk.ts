/**
 * Helpdesk migration: adds osTicket-style columns to `tickets`,
 * plus new tables for departments, teams, help topics, SLA plans,
 * messages, activity, attachments, canned responses, email templates,
 * filters, and global settings.
 *
 * Idempotent — safe to re-run on every boot.
 */
import { pool } from "../db";

export const HELPDESK_MIGRATION_SQL = `
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS ticket_number text,
  ADD COLUMN IF NOT EXISTS access_token text,
  ADD COLUMN IF NOT EXISTS requester_name text,
  ADD COLUMN IF NOT EXISTS requester_email text,
  ADD COLUMN IF NOT EXISTS requester_phone text,
  ADD COLUMN IF NOT EXISTS source text DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS department_id integer,
  ADD COLUMN IF NOT EXISTS team_id integer,
  ADD COLUMN IF NOT EXISTS help_topic_id integer,
  ADD COLUMN IF NOT EXISTS sla_plan_id integer,
  ADD COLUMN IF NOT EXISTS due_at timestamp,
  ADD COLUMN IF NOT EXISTS sla_due_at timestamp,
  ADD COLUMN IF NOT EXISTS first_response_at timestamp,
  ADD COLUMN IF NOT EXISTS locked_by integer,
  ADD COLUMN IF NOT EXISTS locked_at timestamp,
  ADD COLUMN IF NOT EXISTS overdue_alert_sent boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS closed_at timestamp;

CREATE UNIQUE INDEX IF NOT EXISTS tickets_ticket_number_uidx ON tickets(ticket_number) WHERE ticket_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS tickets_requester_email_idx ON tickets(requester_email);
CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets(status);
CREATE INDEX IF NOT EXISTS tickets_department_idx ON tickets(department_id);

CREATE TABLE IF NOT EXISTS ticket_departments (
  id serial PRIMARY KEY,
  name text NOT NULL,
  email text,
  is_default boolean DEFAULT false,
  autoresponder_enabled boolean DEFAULT true,
  sign_off text,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_teams (
  id serial PRIMARY KEY,
  department_id integer REFERENCES ticket_departments(id),
  name text NOT NULL,
  lead_user_id integer REFERENCES users(id),
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_team_members (
  id serial PRIMARY KEY,
  team_id integer NOT NULL REFERENCES ticket_teams(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamp DEFAULT now(),
  UNIQUE(team_id, user_id)
);

CREATE TABLE IF NOT EXISTS sla_plans (
  id serial PRIMARY KEY,
  name text NOT NULL,
  response_time_minutes integer NOT NULL DEFAULT 60,
  resolve_time_minutes integer NOT NULL DEFAULT 1440,
  business_hours_only boolean DEFAULT false,
  grace_period_minutes integer DEFAULT 0,
  escalate_priority boolean DEFAULT true,
  is_active boolean DEFAULT true,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_help_topics (
  id serial PRIMARY KEY,
  name text NOT NULL,
  department_id integer REFERENCES ticket_departments(id),
  sla_plan_id integer REFERENCES sla_plans(id),
  auto_assign_team_id integer REFERENCES ticket_teams(id),
  auto_assign_user_id integer REFERENCES users(id),
  priority text DEFAULT 'medium',
  is_active boolean DEFAULT true,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id serial PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_type text NOT NULL,
  author_id integer,
  author_name text,
  author_email text,
  body text NOT NULL,
  is_internal boolean DEFAULT false,
  canned_response_id integer,
  created_at timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_messages_ticket_idx ON ticket_messages(ticket_id);

CREATE TABLE IF NOT EXISTS ticket_activity (
  id serial PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_type text NOT NULL,
  actor_id integer,
  actor_name text,
  action text NOT NULL,
  details text,
  created_at timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_activity_ticket_idx ON ticket_activity(ticket_id);

CREATE TABLE IF NOT EXISTS ticket_attachments (
  id serial PRIMARY KEY,
  ticket_id integer NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  message_id integer REFERENCES ticket_messages(id) ON DELETE SET NULL,
  filename text NOT NULL,
  mime_type text,
  size_bytes integer DEFAULT 0,
  storage_path text NOT NULL,
  uploaded_by_type text DEFAULT 'staff',
  uploaded_by_id integer,
  created_at timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_attachments_ticket_idx ON ticket_attachments(ticket_id);

CREATE TABLE IF NOT EXISTS canned_responses (
  id serial PRIMARY KEY,
  name text NOT NULL,
  body text NOT NULL,
  department_id integer REFERENCES ticket_departments(id),
  is_active boolean DEFAULT true,
  created_by integer REFERENCES users(id),
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_templates (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_filters (
  id serial PRIMARY KEY,
  name text NOT NULL,
  is_active boolean DEFAULT true,
  priority integer DEFAULT 100,
  match_type text NOT NULL DEFAULT 'all',
  conditions jsonb NOT NULL,
  actions jsonb NOT NULL,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_settings (
  id serial PRIMARY KEY,
  autoresponder_enabled boolean DEFAULT true,
  default_department_id integer REFERENCES ticket_departments(id),
  default_sla_plan_id integer REFERENCES sla_plans(id),
  max_attachment_bytes integer DEFAULT 10485760,
  allowed_mime_types text DEFAULT 'image/png,image/jpeg,image/gif,application/pdf,text/plain,application/zip',
  lock_expiry_minutes integer DEFAULT 15,
  overdue_alert_enabled boolean DEFAULT true,
  portal_enabled boolean DEFAULT true,
  ticket_number_prefix text DEFAULT 'CSD',
  updated_at timestamp DEFAULT now()
);
`;

const SEED_DEFAULTS_SQL = `
INSERT INTO ticket_departments (name, email, is_default, autoresponder_enabled)
SELECT 'Support', 'support@computersystemsdepot.com', true, true
WHERE NOT EXISTS (SELECT 1 FROM ticket_departments);

INSERT INTO sla_plans (name, response_time_minutes, resolve_time_minutes, is_active)
SELECT 'Standard', 60, 1440, true
WHERE NOT EXISTS (SELECT 1 FROM sla_plans);

INSERT INTO ticket_settings (id, autoresponder_enabled)
SELECT 1, true
WHERE NOT EXISTS (SELECT 1 FROM ticket_settings WHERE id = 1);

INSERT INTO email_templates (code, name, subject, body) VALUES
  ('ticket.autoreply', 'New Ticket Auto-Reply',
   '[{{ticket_number}}] We received your request: {{subject}}',
   'Hi {{requester_name}},\n\nWe have received your ticket #{{ticket_number}}. A member of our team will respond within {{response_time}}.\n\nSubject: {{subject}}\n\nDescription:\n{{description}}\n\nYou can view and reply to this ticket at any time:\n{{portal_url}}\n\nThank you,\n{{department_name}}'),
  ('ticket.new_reply', 'New Reply Notification',
   '[{{ticket_number}}] Update on your ticket: {{subject}}',
   'Hi {{requester_name}},\n\nA new reply has been posted to your ticket #{{ticket_number}}.\n\n{{message_body}}\n\nView the full thread at:\n{{portal_url}}'),
  ('ticket.assigned', 'Ticket Assigned (Staff)',
   '[{{ticket_number}}] Assigned to you: {{subject}}',
   'Hi {{assignee_name}},\n\nTicket #{{ticket_number}} has been assigned to you.\n\nSubject: {{subject}}\nPriority: {{priority}}\nRequester: {{requester_name}} <{{requester_email}}>'),
  ('ticket.overdue', 'Ticket Overdue Alert',
   '[{{ticket_number}}] OVERDUE: {{subject}}',
   'Ticket #{{ticket_number}} is past its SLA due date ({{sla_due_at}}).\n\nSubject: {{subject}}\nAssignee: {{assignee_name}}\nDepartment: {{department_name}}'),
  ('ticket.resolved', 'Ticket Resolved',
   '[{{ticket_number}}] Resolved: {{subject}}',
   'Hi {{requester_name}},\n\nYour ticket #{{ticket_number}} has been resolved. If the issue is not fully fixed, reply to this email and the ticket will be reopened.\n\nThank you,\n{{department_name}}'),
  ('ticket.staff_new', 'New Ticket (Staff Notice)',
   '[{{ticket_number}}] New ticket: {{subject}}',
   'A new ticket has been created.\n\n#{{ticket_number}} - {{subject}}\nFrom: {{requester_name}} <{{requester_email}}>\nPriority: {{priority}}\nDepartment: {{department_name}}\n\n{{description}}')
ON CONFLICT (code) DO NOTHING;
`;

export async function applyHelpdeskMigration() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(HELPDESK_MIGRATION_SQL);
    await client.query(SEED_DEFAULTS_SQL);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function run() {
  try {
    await applyHelpdeskMigration();
    console.log("✓ Helpdesk migration applied");
  } catch (err) {
    console.error("✗ Helpdesk migration failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1]?.endsWith("2026-05-14-helpdesk.ts") ?? false;
if (isDirectRun) {
  run();
}
