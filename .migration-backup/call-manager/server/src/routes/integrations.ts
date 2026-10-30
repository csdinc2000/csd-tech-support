import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { twilioClient, TWILIO_PHONE_NUMBER } from '../lib/twilio.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { isEmailConfigured, sendEmail } from '../lib/email.js';

const router = Router();

// ── GET /api/integrations/health ────────────────────────────────────────────
router.get('/integrations/health', requireAuth, async (_req, res) => {
  const out: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
  };

  // Supabase
  try {
    const { error } = await supabaseAdmin.from('users').select('id', { head: true, count: 'exact' }).limit(1);
    out.supabase = { ok: !error, error: error?.message ?? null };
  } catch (e: unknown) {
    out.supabase = { ok: false, error: e instanceof Error ? e.message : 'unknown' };
  }

  // Twilio (cheap account read)
  try {
    const acct = await twilioClient.api.accounts(twilioClient.accountSid).fetch();
    out.twilio = {
      ok: true,
      account_sid: acct.sid,
      friendly_name: acct.friendlyName,
      status: acct.status,
      phone_number: TWILIO_PHONE_NUMBER,
    };
  } catch (e: unknown) {
    out.twilio = { ok: false, error: e instanceof Error ? e.message : 'unknown' };
  }

  // Email
  out.email = { ok: isEmailConfigured(), provider: 'resend' };

  // Last webhook received — pull from call_events
  const { data: lastEvent } = await supabaseAdmin
    .from('call_events')
    .select('created_at, event_type')
    .eq('event_type', 'webhook_received')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  out.last_voice_webhook = lastEvent?.created_at ?? null;

  // Last inbound SMS
  const { data: lastSms } = await supabaseAdmin
    .from('messages')
    .select('created_at')
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  out.last_inbound_sms = lastSms?.created_at ?? null;

  res.json(out);
});

// ── POST /api/integrations/twilio/test ──────────────────────────────────────
router.post('/integrations/twilio/test', requireAuth, requireRole('owner'), async (_req, res) => {
  try {
    const acct = await twilioClient.api.accounts(twilioClient.accountSid).fetch();
    res.json({
      ok: true,
      account_sid: acct.sid,
      friendly_name: acct.friendlyName,
      status: acct.status,
    });
  } catch (e: unknown) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'unknown' });
  }
});

// ── POST /api/integrations/email/test ───────────────────────────────────────
router.post('/integrations/email/test', requireAuth, requireRole('owner'), async (req, res) => {
  const { to } = req.body as { to?: string };
  if (!to) return res.status(400).json({ error: 'to required' });
  const r = await sendEmail({
    to,
    subject: 'CSD Call Manager — email test',
    html: '<p>This is a test email from CSD Call Manager.</p>',
    text: 'This is a test email from CSD Call Manager.',
  });
  res.json(r);
});

export { router as integrationsRouter };
