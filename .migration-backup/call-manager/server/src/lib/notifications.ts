import { supabaseAdmin } from './supabase.js';
import { twilioClient, TWILIO_PHONE_NUMBER, PUBLIC_BASE_URL } from './twilio.js';
import { sendEmail, renderEmailTemplate, loadTemplateByTrigger } from './email.js';

type Trigger = 'manual' | 'missed_call' | 'voicemail_received' | 'new_customer' | 'daily_digest' | 'invitation';

interface UserRow {
  id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  is_active: boolean;
  timezone: string;
}

interface SettingsRow {
  user_id: string;
  missed_call_email: boolean;
  missed_call_sms: boolean;
  voicemail_email: boolean;
  voicemail_sms: boolean;
  daily_digest_email: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  unsubscribe_token: string;
}

/**
 * Returns true if "now" (in the user's timezone) falls inside their quiet hours.
 * Handles overnight ranges (e.g. 22:00 → 07:00).
 */
export function isInQuietHours(
  startStr: string | null,
  endStr: string | null,
  timezone: string,
  now: Date = new Date(),
): boolean {
  if (!startStr || !endStr) return false;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const hh = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const mm = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const nowMin = hh * 60 + mm;
  const [sH, sM] = startStr.split(':').map((s) => parseInt(s, 10));
  const [eH, eM] = endStr.split(':').map((s) => parseInt(s, 10));
  const startMin = sH * 60 + sM;
  const endMin = eH * 60 + eM;
  if (startMin === endMin) return false;
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  // Overnight wrap (e.g. 22:00 → 07:00)
  return nowMin >= startMin || nowMin < endMin;
}

/**
 * Compute the next deliver_after timestamp (UTC) when the user's local clock
 * reaches their quiet_hours_end. We approximate by adding minutes-until-end to
 * "now", which is correct since DST/offsets cancel out at the same instant.
 */
function deliverAfterEndOfQuiet(endStr: string, timezone: string, now: Date = new Date()): Date {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const hh = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const mm = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const nowMin = hh * 60 + mm;
  const [eH, eM] = endStr.split(':').map((s) => parseInt(s, 10));
  const endMin = eH * 60 + eM;
  let diff = endMin - nowMin;
  if (diff <= 0) diff += 24 * 60;
  return new Date(now.getTime() + diff * 60_000);
}

interface DispatchOptions {
  trigger: Trigger;
  recipientUserId?: string;     // dispatch to a specific user
  recipientUserIds?: string[];  // …or many
  context: Record<string, unknown>;
  forceChannels?: { email?: boolean; sms?: boolean }; // for test-send
}

/**
 * Dispatch a notification to one or more users. Honors per-user
 * notification_settings + quiet hours + email template lookup. Always logs to
 * notifications_log; returns the rows that were created/queued.
 */
export async function dispatchNotification(opts: DispatchOptions): Promise<{ queued: number; sent: number; failed: number }> {
  const userIds = opts.recipientUserIds ?? (opts.recipientUserId ? [opts.recipientUserId] : []);
  if (userIds.length === 0) return { queued: 0, sent: 0, failed: 0 };

  const { data: users } = await supabaseAdmin
    .from('users')
    .select('id, email, full_name, phone, is_active, timezone')
    .in('id', userIds);
  const { data: settings } = await supabaseAdmin
    .from('notification_settings')
    .select('*')
    .in('user_id', userIds);

  const tally = { queued: 0, sent: 0, failed: 0 };
  for (const user of (users ?? []) as UserRow[]) {
    if (!user.is_active) continue;
    const s = (settings ?? []).find((x) => x.user_id === user.id) as SettingsRow | undefined;
    const channels = decideChannels(opts.trigger, s, opts.forceChannels);
    if (!channels.email && !channels.sms) continue;

    const inQuiet = s
      ? isInQuietHours(s.quiet_hours_start, s.quiet_hours_end, user.timezone)
      : false;
    const deliverAfter = inQuiet && s?.quiet_hours_end
      ? deliverAfterEndOfQuiet(s.quiet_hours_end, user.timezone)
      : new Date();

    const ctx = {
      ...opts.context,
      recipient_name: user.full_name || user.email.split('@')[0],
      unsubscribe_url: s
        ? `${PUBLIC_BASE_URL}/unsubscribe/${s.unsubscribe_token}`
        : '',
    };

    if (channels.email) {
      const r = await deliverEmail(user, opts.trigger, ctx, deliverAfter, inQuiet);
      bumpTally(tally, r);
    }
    if (channels.sms && user.phone) {
      const r = await deliverSms(user, opts.trigger, ctx, deliverAfter, inQuiet);
      bumpTally(tally, r);
    }
  }
  return tally;
}

function decideChannels(
  trigger: Trigger,
  s: SettingsRow | undefined,
  force?: { email?: boolean; sms?: boolean },
): { email: boolean; sms: boolean } {
  if (force) return { email: !!force.email, sms: !!force.sms };
  if (!s) {
    // No settings row = use sensible defaults
    if (trigger === 'missed_call') return { email: true, sms: false };
    if (trigger === 'voicemail_received') return { email: true, sms: false };
    if (trigger === 'daily_digest') return { email: false, sms: false };
    return { email: true, sms: false };
  }
  switch (trigger) {
    case 'missed_call':
      return { email: s.missed_call_email, sms: s.missed_call_sms };
    case 'voicemail_received':
      return { email: s.voicemail_email, sms: s.voicemail_sms };
    case 'daily_digest':
      return { email: s.daily_digest_email, sms: false };
    default:
      return { email: true, sms: false };
  }
}

function bumpTally(t: { queued: number; sent: number; failed: number }, status: 'queued' | 'sent' | 'failed') {
  t[status]++;
}

async function deliverEmail(
  user: UserRow,
  trigger: Trigger,
  ctx: Record<string, unknown>,
  deliverAfter: Date,
  isQueued: boolean,
): Promise<'queued' | 'sent' | 'failed'> {
  const tpl = await loadTemplateByTrigger(trigger);
  if (!tpl) {
    await logNotification({
      user_id: user.id,
      channel: 'email',
      trigger,
      to_address: user.email,
      subject: '(no template)',
      body: '',
      status: 'failed',
      context: ctx,
      deliver_after: deliverAfter.toISOString(),
      error_message: `No email template for trigger "${trigger}"`,
    });
    return 'failed';
  }
  const subject = renderEmailTemplate(tpl.subject, ctx);
  const html = renderEmailTemplate(tpl.body_html, ctx);
  const text = renderEmailTemplate(tpl.body_text, ctx);

  if (isQueued) {
    await logNotification({
      user_id: user.id,
      channel: 'email',
      trigger,
      to_address: user.email,
      subject, body: text,
      status: 'queued',
      context: ctx,
      deliver_after: deliverAfter.toISOString(),
    });
    return 'queued';
  }

  const r = await sendEmail({ to: user.email, subject, html, text });
  await logNotification({
    user_id: user.id,
    channel: 'email',
    trigger,
    to_address: user.email,
    subject, body: text,
    status: r.ok ? 'sent' : r.suppressed ? 'suppressed' : 'failed',
    context: ctx,
    deliver_after: deliverAfter.toISOString(),
    delivered_at: r.ok ? new Date().toISOString() : null,
    error_message: r.error ?? null,
  });
  return r.ok ? 'sent' : 'failed';
}

async function deliverSms(
  user: UserRow,
  trigger: Trigger,
  ctx: Record<string, unknown>,
  deliverAfter: Date,
  isQueued: boolean,
): Promise<'queued' | 'sent' | 'failed'> {
  if (!user.phone) return 'failed';
  // Use the email template's plain-text body as the SMS body (with a sane truncation)
  const tpl = await loadTemplateByTrigger(trigger);
  const raw = tpl ? renderEmailTemplate(tpl.body_text, ctx) : `[${trigger}] notification`;
  const body = raw.length > 1500 ? raw.slice(0, 1497) + '...' : raw;

  if (isQueued) {
    await logNotification({
      user_id: user.id,
      channel: 'sms',
      trigger,
      to_address: user.phone,
      body,
      status: 'queued',
      context: ctx,
      deliver_after: deliverAfter.toISOString(),
    });
    return 'queued';
  }

  try {
    await twilioClient.messages.create({
      to: user.phone,
      from: TWILIO_PHONE_NUMBER,
      body,
    });
    await logNotification({
      user_id: user.id,
      channel: 'sms',
      trigger,
      to_address: user.phone,
      body,
      status: 'sent',
      context: ctx,
      deliver_after: deliverAfter.toISOString(),
      delivered_at: new Date().toISOString(),
    });
    return 'sent';
  } catch (err: unknown) {
    await logNotification({
      user_id: user.id,
      channel: 'sms',
      trigger,
      to_address: user.phone,
      body,
      status: 'failed',
      context: ctx,
      deliver_after: deliverAfter.toISOString(),
      error_message: err instanceof Error ? err.message : 'twilio error',
    });
    return 'failed';
  }
}

interface LogRow {
  user_id: string | null;
  channel: 'email' | 'sms';
  trigger: Trigger;
  to_address: string;
  subject?: string;
  body?: string;
  status: 'queued' | 'sent' | 'failed' | 'suppressed';
  context: Record<string, unknown>;
  deliver_after: string;
  delivered_at?: string | null;
  error_message?: string | null;
}
async function logNotification(row: LogRow) {
  await supabaseAdmin.from('notifications_log').insert(row);
}

/**
 * Process all queued notifications whose deliver_after has passed. Called by
 * the in-process scheduler.
 */
export async function processQueuedNotifications(): Promise<{ processed: number }> {
  const { data: queued } = await supabaseAdmin
    .from('notifications_log')
    .select('*')
    .eq('status', 'queued')
    .lte('deliver_after', new Date().toISOString())
    .limit(100);

  let processed = 0;
  for (const row of queued ?? []) {
    if (row.channel === 'email') {
      const r = await sendEmail({
        to: row.to_address,
        subject: row.subject ?? '(no subject)',
        html: row.body ?? '',
        text: row.body ?? '',
      });
      await supabaseAdmin
        .from('notifications_log')
        .update({
          status: r.ok ? 'sent' : r.suppressed ? 'suppressed' : 'failed',
          delivered_at: r.ok ? new Date().toISOString() : null,
          error_message: r.error ?? null,
        })
        .eq('id', row.id);
    } else {
      try {
        await twilioClient.messages.create({
          to: row.to_address,
          from: TWILIO_PHONE_NUMBER,
          body: row.body ?? '',
        });
        await supabaseAdmin
          .from('notifications_log')
          .update({ status: 'sent', delivered_at: new Date().toISOString() })
          .eq('id', row.id);
      } catch (err: unknown) {
        await supabaseAdmin
          .from('notifications_log')
          .update({
            status: 'failed',
            error_message: err instanceof Error ? err.message : 'twilio error',
          })
          .eq('id', row.id);
      }
    }
    processed++;
  }
  return { processed };
}
