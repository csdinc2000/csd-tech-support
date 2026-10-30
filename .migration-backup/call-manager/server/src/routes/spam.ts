import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { normalizePhone, getSetting, setSetting } from '../lib/sms.js';
import { checkSpam } from '../lib/spam.js';

const router = Router();

// ── POST /api/spam/check ─────────────────────────────────────────────────────
router.post('/spam/check', requireAuth, async (req, res) => {
  const { phone_number, force } = req.body as { phone_number?: string; force?: boolean };
  if (!phone_number) return res.status(400).json({ error: 'phone_number required' });
  const normalized = normalizePhone(phone_number);
  if (!normalized) return res.status(400).json({ error: 'Invalid phone_number' });
  try {
    const result = await checkSpam(normalized, !!force);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Lookup error' });
  }
});

// ── GET /api/spam/recent ─────────────────────────────────────────────────────
router.get('/spam/recent', requireAuth, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('spam_scores')
    .select('*')
    .order('last_checked', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

// ── GET /api/spam/settings ───────────────────────────────────────────────────
router.get('/spam/settings', requireAuth, async (_req, res) => {
  const threshold = await getSetting<number>('spam_threshold', 70);
  const enabled = await getSetting<boolean>('spam_screening_enabled', false);
  res.json({ threshold, screening_enabled: enabled });
});

// ── PUT /api/spam/settings (owner) ───────────────────────────────────────────
router.put('/spam/settings', requireAuth, requireRole('owner'), async (req, res) => {
  const { threshold, screening_enabled } = req.body as {
    threshold?: number;
    screening_enabled?: boolean;
  };
  if (threshold !== undefined) {
    const t = Math.max(0, Math.min(100, Math.round(threshold)));
    await setSetting('spam_threshold', t);
  }
  if (screening_enabled !== undefined) {
    await setSetting('spam_screening_enabled', !!screening_enabled);
  }
  res.json({ ok: true });
});

export { router as spamRouter };
