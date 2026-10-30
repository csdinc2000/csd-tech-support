/**
 * /api/ai/sessions — list & detail of AI call transcripts.
 */
import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { getDailyCapCents, getTodaySpendCents, isCapPaused, setDailyCapCents } from '../lib/spendCap.js';
import { requireRole } from '../middleware/auth.js';
import { z } from 'zod';

export const aiSessionsRouter = Router();

aiSessionsRouter.get('/ai/sessions', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const search = (req.query.search as string | undefined)?.trim();
  let q = supabaseAdmin
    .from('ai_call_sessions')
    .select('id, call_id, assistant_id, vapi_call_id, summary, outcome, cost_cents, duration_sec, created_at, ended_at, extracted_data')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (search) q = q.or(`summary.ilike.%${search}%,extracted_data->>customer_name.ilike.%${search}%`);
  const { data, error } = await q;
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ items: data ?? [] });
});

aiSessionsRouter.get('/ai/sessions/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('ai_call_sessions').select('*').eq('id', req.params.id).maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!data) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(data);
});

// ── Spend-cap config ───────────────────────────────────────────────────────
aiSessionsRouter.get('/ai/spend', requireAuth, async (_req, res) => {
  const [cap, spent, paused] = await Promise.all([
    getDailyCapCents(), getTodaySpendCents(), isCapPaused(),
  ]);
  res.json({ cap_cents: cap, spent_today_cents: spent, paused_for_cap: paused });
});

const capSchema = z.object({ cap_cents: z.number().int().nonnegative() });
aiSessionsRouter.post('/ai/spend/cap', requireAuth, requireRole('owner'), async (req, res) => {
  const parsed = capSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  await setDailyCapCents(parsed.data.cap_cents);
  res.json({ ok: true, cap_cents: parsed.data.cap_cents });
});
