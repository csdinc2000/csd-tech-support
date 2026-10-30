import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { normalizePhone } from '../lib/sms.js';

const router = Router();

router.get('/dnc', requireAuth, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('dnc_list')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

router.post('/dnc', requireAuth, requireRole('owner'), async (req, res) => {
  const { phone_number, source = 'manual', notes } = req.body as {
    phone_number?: string;
    source?: 'manual' | 'customer_request' | 'national_dnc';
    notes?: string;
  };
  if (!phone_number) return res.status(400).json({ error: 'phone_number required' });
  const normalized = normalizePhone(phone_number);
  if (!normalized) return res.status(400).json({ error: 'Invalid phone_number' });
  const { data, error } = await supabaseAdmin
    .from('dnc_list')
    .upsert(
      { phone_number: normalized, source, notes: notes ?? null },
      { onConflict: 'phone_number' },
    )
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// CSV bulk import — accepts {csv: "+15551234567,reason\n..."} body
router.post('/dnc/import', requireAuth, requireRole('owner'), async (req, res) => {
  const { csv } = req.body as { csv?: string };
  if (!csv) return res.status(400).json({ error: 'csv body required' });
  const rows: { phone_number: string; source: 'manual'; notes: string | null }[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [numRaw, ...rest] = trimmed.split(',');
    const num = normalizePhone(numRaw);
    if (!num) continue;
    rows.push({ phone_number: num, source: 'manual', notes: rest.join(',').trim() || null });
  }
  if (rows.length === 0) return res.json({ imported: 0 });
  const { error } = await supabaseAdmin.from('dnc_list').upsert(rows, { onConflict: 'phone_number' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ imported: rows.length });
});

router.delete('/dnc/:id', requireAuth, requireRole('owner'), async (req, res) => {
  const { error } = await supabaseAdmin.from('dnc_list').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.sendStatus(204);
});

export { router as dncRouter };
