import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';
import { dispatchNotification } from '../lib/notifications.js';

const router = Router();

// ── GET /api/notification-settings ──────────────────────────────────────────
router.get('/notification-settings', requireAuth, async (req: AuthRequest, res) => {
  const { data } = await supabaseAdmin
    .from('notification_settings')
    .select('*')
    .eq('user_id', req.userId!)
    .maybeSingle();

  if (data) return res.json(data);

  // Auto-create defaults if missing
  const { data: created, error } = await supabaseAdmin
    .from('notification_settings')
    .insert({ user_id: req.userId! })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(created);
});

// ── PATCH /api/notification-settings ────────────────────────────────────────
router.patch('/notification-settings', requireAuth, async (req: AuthRequest, res) => {
  const allowed = [
    'missed_call_email', 'missed_call_sms',
    'voicemail_email', 'voicemail_sms',
    'daily_digest_email', 'daily_digest_time',
    'quiet_hours_start', 'quiet_hours_end',
  ];
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of allowed) {
    if (k in req.body) {
      const v = (req.body as Record<string, unknown>)[k];
      // Empty string → null for time columns
      updates[k] = v === '' ? null : v;
    }
  }
  const { data, error } = await supabaseAdmin
    .from('notification_settings')
    .upsert({ user_id: req.userId!, ...updates }, { onConflict: 'user_id' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/notifications/test — send test email + optional SMS to me ─────
router.post('/notifications/test', requireAuth, async (req: AuthRequest, res) => {
  const { channels } = req.body as { channels?: { email?: boolean; sms?: boolean } };
  const ch = channels ?? { email: true, sms: false };
  const result = await dispatchNotification({
    trigger: 'manual',
    recipientUserId: req.userId!,
    forceChannels: ch,
    context: {
      test: true,
      from_number: '+15555550100',
      call_time: new Date().toLocaleString(),
      call_url: '#',
      voicemail_url: '#',
      duration: 12,
      date: new Date().toLocaleDateString(),
      call_count: 0, voicemail_count: 0, message_count: 0,
      dashboard_url: '#',
    },
  });
  res.json(result);
});

// ── GET /api/notifications/log — current user's last 100 ────────────────────
router.get('/notifications/log', requireAuth, async (req: AuthRequest, res) => {
  const { data, error } = await supabaseAdmin
    .from('notifications_log')
    .select('*')
    .eq('user_id', req.userId!)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

export { router as notificationSettingsRouter };
