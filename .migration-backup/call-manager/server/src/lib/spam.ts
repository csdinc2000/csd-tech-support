import { twilioClient } from './twilio.js';
import { supabaseAdmin } from './supabase.js';

export interface SpamCheckResult {
  phone_number: string;
  score: number;
  sources: Record<string, unknown>;
  cached: boolean;
  last_checked: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Score a number by combining Twilio Lookup v2 line-type-intelligence signals
 * into a 0–100 estimate where higher = more spam-like. Heuristic but
 * deterministic, and respects the 24-hour cache. Errors return score=0 with
 * the error captured in `sources`.
 */
export async function checkSpam(rawNumber: string, force = false): Promise<SpamCheckResult> {
  const number = rawNumber.trim();

  if (!force) {
    const { data: cached } = await supabaseAdmin
      .from('spam_scores')
      .select('*')
      .eq('phone_number', number)
      .maybeSingle();
    if (cached) {
      const age = Date.now() - new Date(cached.last_checked).getTime();
      if (age < CACHE_TTL_MS) {
        return {
          phone_number: cached.phone_number,
          score: cached.score,
          sources: cached.sources ?? {},
          cached: true,
          last_checked: cached.last_checked,
        };
      }
    }
  }

  let score = 0;
  const sources: Record<string, unknown> = {};

  try {
    const lookup = await twilioClient.lookups.v2
      .phoneNumbers(number)
      .fetch({ fields: 'line_type_intelligence' });

    const lti = lookup.lineTypeIntelligence as Record<string, unknown> | null;
    sources.line_type_intelligence = lti;

    const type = (lti?.type as string | undefined) ?? '';
    // Voip / non-fixed-voip / toll-free are most associated with spam in our data
    if (type === 'nonFixedVoip') score += 50;
    else if (type === 'voip' || type === 'fixedVoip') score += 30;
    else if (type === 'tollFree') score += 25;
    else if (type === 'personal' || type === 'mobile' || type === 'landline') score += 0;
    else if (!type) score += 10;

    const carrier = (lti?.carrier_name as string | undefined) ?? '';
    if (/spam|robocall|telemarket/i.test(carrier)) score += 30;
    if (carrier === '') score += 5;
  } catch (err) {
    sources.error = err instanceof Error ? err.message : String(err);
  }

  score = Math.min(100, Math.max(0, score));
  const last_checked = new Date().toISOString();

  await supabaseAdmin.from('spam_scores').upsert(
    { phone_number: number, score, sources, last_checked },
    { onConflict: 'phone_number' },
  );

  return { phone_number: number, score, sources, cached: false, last_checked };
}

/**
 * Get a cached score without making a Twilio call. Returns null if no cache row.
 */
export async function getCachedSpamScore(number: string): Promise<number | null> {
  const { data } = await supabaseAdmin
    .from('spam_scores')
    .select('score')
    .eq('phone_number', number)
    .maybeSingle();
  return data?.score ?? null;
}
