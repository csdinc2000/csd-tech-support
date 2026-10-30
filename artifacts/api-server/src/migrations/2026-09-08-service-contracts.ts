import { pool } from "../db";

export async function applyServiceContractsMigration(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS service_contracts (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','viewed','signed','void')),
      contract_type TEXT NOT NULL,
      annual_value_cents INTEGER NOT NULL CHECK (annual_value_cents >= 0),
      monthly_payment_cents INTEGER NOT NULL CHECK (monthly_payment_cents >= 0),
      effective_date DATE NOT NULL,
      renewal_type TEXT NOT NULL DEFAULT 'auto_annual',
      response_time_sla TEXT NOT NULL,
      support_hours TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      provider_address TEXT NOT NULL,
      client_name TEXT NOT NULL,
      client_address TEXT NOT NULL,
      signer_name TEXT,
      signer_title TEXT,
      signer_email TEXT,
      terms JSONB NOT NULL DEFAULT '{}'::jsonb,
      signing_token_hash TEXT NOT NULL UNIQUE,
      token_expires_at TIMESTAMPTZ NOT NULL,
      sent_at TIMESTAMPTZ,
      signed_at TIMESTAMPTZ,
      signature_text TEXT,
      signature_consent BOOLEAN NOT NULL DEFAULT FALSE,
      signed_document_hash TEXT,
      signed_ip_address TEXT,
      signed_user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS service_contracts_client_idx ON service_contracts(client_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS service_contract_events (
      id SERIAL PRIMARY KEY,
      contract_id INTEGER NOT NULL REFERENCES service_contracts(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_identity TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS service_contract_events_contract_idx ON service_contract_events(contract_id, created_at);
  `);
}