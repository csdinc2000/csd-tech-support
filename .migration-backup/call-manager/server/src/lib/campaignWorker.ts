/**
 * Outbound-campaign dialer worker.
 *
 * Runs once per minute. For each campaign with status='running':
 *   - Skip entirely if the AI spend cap is hit.
 *   - Compute how many calls we may place this hour (max_calls_per_hour minus
 *     attempts already made within the last 60 minutes).
 *   - For each pending campaign_calls row (oldest scheduled first):
 *       * Check DNC list. If hit → mark dnc_blocked. Move on.
 *       * Check 7-day per-number cooldown (any call to this number in the
 *         last 7 days, in either direction, in the calls table). owner_override
 *         on the row bypasses this check.
 *       * Check call window — both the campaign's [start,end] and the federal
 *         TCPA 8am–9pm in the called party's timezone (resolved by NPA).
 *       * Place the call via VAPI (passes campaign_call_id as metadata).
 *   - When every row is in a terminal state (completed/failed/blocked), mark
 *     the campaign 'completed'.
 */
import { supabaseAdmin } from './supabase.js';
import { isCapPaused } from './spendCap.js';
import { isWithinAllowedWindow } from './tcpa.js';
import { isVapiConfigured, placeCall } from './vapi.js';

const COOLDOWN_DAYS = 7;

interface AssistantRow { id: string; vapi_assistant_id: string | null; is_active: boolean }
interface CampaignRow {
  id: string; name: string; assistant_id: string; status: string;
  call_window_start: string; call_window_end: string; max_calls_per_hour: number;
}
interface CampaignCallRow {
  id: string; phone_number: string; customer_name: string | null;
  attempt_number: number; owner_override: boolean;
}

async function isOnDnc(phone: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('dnc_list')
    .select('phone_number')
    .eq('phone_number', phone)
    .maybeSingle();
  return !!data;
}

async function isWithinCooldown(phone: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - COOLDOWN_DAYS * 86_400_000).toISOString();
  // Check the canonical Twilio call log first.
  const { count: twilioCount } = await supabaseAdmin
    .from('calls')
    .select('id', { count: 'exact', head: true })
    .or(`from_number.eq.${phone},to_number.eq.${phone}`)
    .gte('started_at', cutoff);
  if ((twilioCount ?? 0) > 0) return true;
  // ALSO check Phase-5 outbound attempts. VAPI-bridged campaign calls may
  // not have a corresponding Twilio CallSid synced into `calls` at the time
  // of the next tick, so we fall back to `campaign_calls` to guarantee the
  // 7-day rule cannot be bypassed by timing of the Twilio webhook.
  const { count: ccCount } = await supabaseAdmin
    .from('campaign_calls')
    .select('id', { count: 'exact', head: true })
    .eq('phone_number', phone)
    .in('status', ['dialing', 'completed'])
    .gte('attempted_at', cutoff);
  return (ccCount ?? 0) > 0;
}

async function callsThisHour(campaignId: string): Promise<number> {
  const cutoff = new Date(Date.now() - 60 * 60_000).toISOString();
  const { count } = await supabaseAdmin
    .from('campaign_calls')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .gte('attempted_at', cutoff);
  return count ?? 0;
}

export async function campaignTick(now: Date = new Date()): Promise<void> {
  if (!isVapiConfigured()) return; // graceful: nothing to do
  if (await isCapPaused()) return;

  const { data: campaigns } = await supabaseAdmin
    .from('outbound_campaigns')
    .select('id, name, assistant_id, status, call_window_start, call_window_end, max_calls_per_hour')
    .eq('status', 'running');

  for (const c of (campaigns ?? []) as CampaignRow[]) {
    const { data: assistant } = await supabaseAdmin
      .from('ai_assistants')
      .select('id, vapi_assistant_id, is_active')
      .eq('id', c.assistant_id)
      .maybeSingle();

    const a = assistant as AssistantRow | null;
    if (!a || !a.is_active || !a.vapi_assistant_id) {
      console.warn(`[campaign ${c.id}] assistant unavailable; pausing`);
      await supabaseAdmin.from('outbound_campaigns').update({ status: 'paused' }).eq('id', c.id);
      continue;
    }

    let budget = Math.max(0, c.max_calls_per_hour - (await callsThisHour(c.id)));
    if (budget === 0) continue;

    const { data: pending } = await supabaseAdmin
      .from('campaign_calls')
      .select('id, phone_number, customer_name, attempt_number, owner_override')
      .eq('campaign_id', c.id)
      .eq('status', 'pending')
      .order('scheduled_at', { ascending: true, nullsFirst: true })
      .limit(budget);

    for (const row of (pending ?? []) as CampaignCallRow[]) {
      if (budget <= 0) break;

      // DNC check — non-bypassable
      if (await isOnDnc(row.phone_number)) {
        await supabaseAdmin.from('campaign_calls').update({
          status: 'dnc_blocked', completed_at: new Date().toISOString(),
          failure_reason: 'on DNC list',
        }).eq('id', row.id);
        continue;
      }

      // 7-day per-number cooldown — bypassable only with owner_override
      if (!row.owner_override && (await isWithinCooldown(row.phone_number))) {
        await supabaseAdmin.from('campaign_calls').update({
          status: 'cooldown_blocked', completed_at: new Date().toISOString(),
          failure_reason: 'called within last 7 days',
        }).eq('id', row.id);
        continue;
      }

      // TCPA + campaign window
      if (!isWithinAllowedWindow(row.phone_number, c.call_window_start, c.call_window_end, now)) {
        // Don't burn the row — leave pending; we'll retry next tick. Just log.
        continue;
      }

      // Place the call
      await supabaseAdmin.from('campaign_calls').update({
        status: 'dialing', attempted_at: new Date().toISOString(),
      }).eq('id', row.id);

      const result = await placeCall({
        toNumber: row.phone_number,
        vapiAssistantId: a.vapi_assistant_id,
        metadata: { campaign_call_id: row.id, campaign_id: c.id, customer_name: row.customer_name ?? '' },
      });

      if (!result.ok) {
        await supabaseAdmin.from('campaign_calls').update({
          status: 'failed', failure_reason: result.error ?? 'placeCall failed',
          completed_at: new Date().toISOString(),
        }).eq('id', row.id);
      }
      budget -= 1;
    }

    // If nothing pending, mark campaign completed
    const { count: remaining } = await supabaseAdmin
      .from('campaign_calls')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', c.id)
      .eq('status', 'pending');
    if ((remaining ?? 0) === 0) {
      await supabaseAdmin.from('outbound_campaigns').update({
        status: 'completed', completed_at: new Date().toISOString(),
      }).eq('id', c.id);
    }
  }
}
