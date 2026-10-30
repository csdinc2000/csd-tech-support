import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';
import { normalizePhone } from '../lib/sms.js';

const router = Router();

router.get('/blacklist', requireAuth, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('blacklist')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

router.post('/blacklist', requireAuth, requireRole('owner'), async (req: AuthRequest, res) => {
  const { phone_number, reason, blocks_calls = true, blocks_sms = true } = req.body as {
    phone_number?: string;
    reason?: string;
    blocks_calls?: boolean;
    blocks_sms?: boolean;
  };
  if (!phone_number) return res.status(400).json({ error: 'phone_number required' });
  const normalized = normalizePhone(phone_number);
  if (!normalized) return res.status(400).json({ error: 'Invalid phone_number' });

  const { data, error } = await supabaseAdmin
    .from('blacklist')
    .upsert(
      {
        phone_number: normalized,
        reason: reason ?? null,
        blocks_calls,
        blocks_sms,
        added_by: req.userId,
      },
      { onConflict: 'phone_number' },
    )
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.delete('/blacklist/:id', requireAuth, requireRole('owner'), async (req, res) => {
  const { error } = await supabaseAdmin.from('blacklist').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.sendStatus(204);
});

export { router as blacklistRouter };
