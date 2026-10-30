import { supabaseAdmin } from './supabase.js';

/**
 * Normalize a US-style phone number to E.164. Returns null if it can't.
 * - Already-E.164 strings (starting with +) are accepted as-is after stripping
 *   common formatting characters.
 * - 10-digit US numbers get a +1 prefix.
 * - 11-digit numbers starting with 1 get a + prefix.
 */
export function normalizePhone(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    return digits.length >= 10 ? `+${digits}` : null;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 11) return `+${digits}`;
  return null;
}

/**
 * Compute the conversation thread key for an SMS. The thread key is always the
 * "other party" — i.e. the customer's phone number — so inbound and outbound
 * messages collate correctly.
 */
export function threadKeyFor(direction: 'inbound' | 'outbound', from: string, to: string): string {
  return direction === 'inbound' ? from : to;
}

/**
 * Render a template body. Supported placeholders: {{customer_name}}, {{ticket_number}}.
 * If a value isn't provided it's replaced with an empty string.
 */
export function renderTemplate(body: string, vars: Record<string, string | null | undefined>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => String(vars[key] ?? ''));
}

/**
 * Look up the most recent customer_name + ticket_number known for a given
 * partner number, by scanning the calls table. Returns nulls when unknown.
 */
export async function lookupContactForNumber(partnerNumber: string): Promise<{
  customer_name: string | null;
  ticket_number: string | null;
}> {
  // Pull the most recent few calls involving this partner, then return the
  // first one that actually has a customer_name or ticket_number set. Doing
  // the "has values" filter in JS avoids brittle nested OR queries that
  // PostgREST can't reliably combine with another OR filter.
  const { data } = await supabaseAdmin
    .from('calls')
    .select('customer_name, ticket_number, started_at')
    .or(`from_number.eq.${partnerNumber},to_number.eq.${partnerNumber}`)
    .order('started_at', { ascending: false })
    .limit(20);

  const withInfo = (data ?? []).find((r) => r.customer_name || r.ticket_number);
  return {
    customer_name: withInfo?.customer_name ?? null,
    ticket_number: withInfo?.ticket_number ?? null,
  };
}

/**
 * Returns true if the given E.164 number is on the DNC list.
 */
export async function isOnDnc(number: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('dnc_list')
    .select('id')
    .eq('phone_number', number)
    .maybeSingle();
  return !!data;
}

/**
 * Returns the blacklist entry for a number, or null.
 */
export async function getBlacklistEntry(number: string): Promise<{
  blocks_calls: boolean;
  blocks_sms: boolean;
  reason: string | null;
} | null> {
  const { data } = await supabaseAdmin
    .from('blacklist')
    .select('blocks_calls, blocks_sms, reason')
    .eq('phone_number', number)
    .maybeSingle();
  return data ?? null;
}

/**
 * Read an app_settings row. Returns the parsed value or `fallback`.
 */
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const { data } = await supabaseAdmin
    .from('app_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (!data) return fallback;
  return data.value as T;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await supabaseAdmin.from('app_settings').upsert(
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
}
