/**
 * AI-call daily spend cap.
 *
 * - Cap is stored in app_settings as `ai_spend_cap_cents_per_day` (integer).
 * - When today's total exceeds the cap:
 *     1. Set `ai_campaigns_paused_for_cap` to true.
 *     2. Pause every running outbound_campaign.
 *     3. Email the owner via the standard email helper (suppressed if Resend
 *        is not configured — same graceful-degrade pattern as Phase 4).
 * - Anyone can read both settings; only owners can change the cap.
 */
import { supabaseAdmin } from './supabase.js';
import { sendEmail } from './email.js';

const CAP_KEY = 'ai_spend_cap_cents_per_day';
const PAUSED_KEY = 'ai_campaigns_paused_for_cap';

export async function getDailyCapCents(): Promise<number> {
  const { data } = await supabaseAdmin
    .from('app_settings')
    .select('value')
    .eq('key', CAP_KEY)
    .maybeSingle();
  const v = data?.value;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseInt(v, 10) || 0;
  return 2000; // $20 default
}

export async function getTodaySpendCents(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabaseAdmin
    .from('ai_spend_log')
    .select('cost_cents')
    .eq('spent_on', today);
  return (data ?? []).reduce((sum, r) => sum + (r.cost_cents ?? 0), 0);
}

export async function isCapPaused(): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('app_settings')
    .select('value')
    .eq('key', PAUSED_KEY)
    .maybeSingle();
  return data?.value === true;
}

async function setPaused(paused: boolean): Promise<void> {
  await supabaseAdmin
    .from('app_settings')
    .upsert({ key: PAUSED_KEY, value: paused, updated_at: new Date().toISOString() });
}

export async function recordSpend(aiSessionId: string | null, costCents: number): Promise<void> {
  if (!Number.isFinite(costCents) || costCents <= 0) return;
  await supabaseAdmin.from('ai_spend_log').insert({
    ai_session_id: aiSessionId,
    cost_cents: Math.round(costCents),
    spent_on: new Date().toISOString().slice(0, 10),
  });
  await checkCapAndPauseIfNeeded();
}

export async function checkCapAndPauseIfNeeded(): Promise<{
  capCents: number;
  spentCents: number;
  paused: boolean;
  justPaused: boolean;
}> {
  const [cap, spent, alreadyPaused] = await Promise.all([
    getDailyCapCents(),
    getTodaySpendCents(),
    isCapPaused(),
  ]);

  const overCap = cap > 0 && spent >= cap;
  if (overCap && !alreadyPaused) {
    await setPaused(true);
    // Pause every running campaign
    await supabaseAdmin
      .from('outbound_campaigns')
      .update({ status: 'paused' })
      .eq('status', 'running');
    // Notify the owner(s)
    const { data: owners } = await supabaseAdmin
      .from('users')
      .select('email, full_name')
      .eq('role', 'owner')
      .eq('is_active', true);
    for (const o of owners ?? []) {
      await sendEmail({
        to: o.email,
        subject: 'CSD Call Manager: AI spend cap reached — campaigns paused',
        html: `<p>Today's AI-call spend has reached <b>$${(spent / 100).toFixed(2)}</b>, which meets or exceeds the configured daily cap of <b>$${(cap / 100).toFixed(2)}</b>.</p>
<p>All running outbound campaigns have been paused. To resume, raise the cap in <b>Integrations → AI Spend</b> or wait for tomorrow.</p>`,
        text: `Today's AI spend ($${(spent / 100).toFixed(2)}) has hit the daily cap ($${(cap / 100).toFixed(2)}). Outbound campaigns paused.`,
      });
    }
    return { capCents: cap, spentCents: spent, paused: true, justPaused: true };
  }

  // Auto-unpause when a new day starts and we're below cap (the cron tick
  // calls this; the date-keyed query naturally drops to 0 at midnight).
  if (!overCap && alreadyPaused) {
    await setPaused(false);
  }

  return { capCents: cap, spentCents: spent, paused: overCap, justPaused: false };
}

export async function setDailyCapCents(cents: number): Promise<void> {
  if (!Number.isFinite(cents) || cents < 0) throw new Error('cap must be a non-negative integer');
  await supabaseAdmin
    .from('app_settings')
    .upsert({ key: CAP_KEY, value: Math.round(cents), updated_at: new Date().toISOString() });
}
