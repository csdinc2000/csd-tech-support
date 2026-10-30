import { supabaseAdmin } from './supabase.js';
import { dispatchNotification, processQueuedNotifications } from './notifications.js';
import { PUBLIC_BASE_URL } from './twilio.js';
import { campaignTick } from './campaignWorker.js';
import { checkCapAndPauseIfNeeded } from './spendCap.js';

/**
 * In-process scheduler. Runs two loops:
 *
 *   1. processQueuedNotifications() — every 60 seconds, drains any quiet-hours
 *      messages whose deliver_after has elapsed.
 *
 *   2. dailyDigestTick() — every minute, finds users whose
 *      notification_settings.daily_digest_email is true AND whose local clock
 *      currently matches their daily_digest_time (HH:MM, in their timezone),
 *      and dispatches a "daily_digest" notification with yesterday's stats.
 *      A simple in-memory dedupe prevents double-sends within the same minute.
 */

const sentDigestKey = (userId: string, ymd: string) => `${userId}:${ymd}`;
const sentDigests = new Set<string>();

function localHHMM(timezone: string, now: Date): string {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = f.formatToParts(now);
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h}:${m}`;
}

function localYMD(timezone: string, now: Date): string {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return f.format(now); // YYYY-MM-DD
}

async function dailyDigestTick() {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayIso = yesterday.toISOString();
  const todayIso = now.toISOString();

  const { data: users } = await supabaseAdmin
    .from('users')
    .select('id, timezone, is_active')
    .eq('is_active', true);

  if (!users) return;

  const { data: settings } = await supabaseAdmin
    .from('notification_settings')
    .select('user_id, daily_digest_email, daily_digest_time')
    .eq('daily_digest_email', true);

  if (!settings || settings.length === 0) return;

  // Pre-compute yesterday's totals once (single tenant)
  const [callsRes, voicemailsRes, messagesRes] = await Promise.all([
    supabaseAdmin
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .gte('started_at', yesterdayIso)
      .lt('started_at', todayIso),
    supabaseAdmin
      .from('voicemails')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', yesterdayIso)
      .lt('created_at', todayIso),
    supabaseAdmin
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', yesterdayIso)
      .lt('created_at', todayIso),
  ]);

  const ctxBase = {
    date: localYMD('UTC', yesterday),
    call_count: callsRes.count ?? 0,
    voicemail_count: voicemailsRes.count ?? 0,
    message_count: messagesRes.count ?? 0,
    dashboard_url: `${PUBLIC_BASE_URL}/`,
  };

  for (const s of settings) {
    const u = users.find((x) => x.id === s.user_id);
    if (!u) continue;
    const tz = u.timezone || 'America/New_York';
    const targetHHMM = (s.daily_digest_time as string).slice(0, 5); // 'HH:MM'
    if (localHHMM(tz, now) !== targetHHMM) continue;

    const ymd = localYMD(tz, now);
    const key = sentDigestKey(u.id, ymd);
    if (sentDigests.has(key)) continue;
    sentDigests.add(key);

    await dispatchNotification({
      trigger: 'daily_digest',
      recipientUserId: u.id,
      context: ctxBase,
    });
  }

  // GC: keep only the last 200 entries
  if (sentDigests.size > 200) {
    const arr = Array.from(sentDigests).slice(-200);
    sentDigests.clear();
    arr.forEach((k) => sentDigests.add(k));
  }
}

let started = false;
export function startScheduler() {
  if (started) return;
  started = true;

  // Process the queue every 60 seconds
  setInterval(() => {
    processQueuedNotifications().catch((e) =>
      console.error('[scheduler] processQueuedNotifications error:', e),
    );
  }, 60_000);

  // Tick the digest every minute
  setInterval(() => {
    dailyDigestTick().catch((e) =>
      console.error('[scheduler] dailyDigestTick error:', e),
    );
  }, 60_000);

  // Phase 5: AI outbound campaign worker — every 60 seconds.
  setInterval(() => {
    campaignTick().catch((e) =>
      console.error('[scheduler] campaignTick error:', e),
    );
  }, 60_000);

  // Phase 5: re-check spend cap every 5 minutes (lets the daily reset
  // auto-unpause campaigns shortly after midnight).
  setInterval(() => {
    checkCapAndPauseIfNeeded().catch((e) =>
      console.error('[scheduler] checkCapAndPauseIfNeeded error:', e),
    );
  }, 5 * 60_000);

  console.log('[scheduler] in-process scheduler started (queue + daily digest + AI campaigns + spend cap)');
}
