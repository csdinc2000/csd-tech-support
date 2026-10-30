/**
 * /api/ai/campaigns — create/manage outbound AI campaigns + per-call rows.
 *
 * Compliance:
 *   - dnc_check_enabled is forced TRUE by both the route and the DB CHECK.
 *   - call_window must be a strict subset of TCPA 8am–9pm.
 *   - The actual dial decisions (DNC, cooldown, window) live in the worker.
 */
import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth, requireRole, type AuthRequest } from '../middleware/auth.js';

export const aiCampaignsRouter = Router();

const HHMM = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);

const targetSchema = z.object({
  phone_number: z.string().min(8).max(20),
  customer_name: z.string().max(120).optional(),
  custom_fields: z.record(z.string(), z.unknown()).optional(),
  owner_override: z.boolean().optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  assistant_id: z.string().uuid(),
  call_window_start: HHMM.default('09:00'),
  call_window_end: HHMM.default('20:00'),
  max_calls_per_hour: z.number().int().min(1).max(500).default(30),
  targets: z.array(targetSchema).min(1).max(10_000),
});

function withinTcpa(start: string, end: string): boolean {
  return start.slice(0, 5) >= '08:00' && end.slice(0, 5) <= '21:00' && start < end;
}

aiCampaignsRouter.get('/ai/campaigns', requireAuth, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('outbound_campaigns').select('*').order('created_at', { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ items: data ?? [] });
});

aiCampaignsRouter.get('/ai/campaigns/:id', requireAuth, async (req, res) => {
  const { data: campaign, error } = await supabaseAdmin
    .from('outbound_campaigns').select('*').eq('id', req.params.id).maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!campaign) { res.status(404).json({ error: 'Not found' }); return; }
  const { data: calls } = await supabaseAdmin
    .from('campaign_calls').select('*').eq('campaign_id', req.params.id)
    .order('attempted_at', { ascending: false, nullsFirst: false }).limit(1000);
  res.json({ ...campaign, calls: calls ?? [] });
});

aiCampaignsRouter.post('/ai/campaigns', requireAuth, requireRole('owner'), async (req: AuthRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!withinTcpa(parsed.data.call_window_start, parsed.data.call_window_end)) {
    res.status(400).json({ error: 'Call window must be within 08:00–21:00 (TCPA)' });
    return;
  }
  const body = parsed.data;
  const { data: campaign, error } = await supabaseAdmin
    .from('outbound_campaigns').insert({
      name: body.name, assistant_id: body.assistant_id, status: 'draft',
      call_window_start: body.call_window_start, call_window_end: body.call_window_end,
      max_calls_per_hour: body.max_calls_per_hour,
      dnc_check_enabled: true,                       // hard-locked
      target_list: body.targets,
      created_by: req.userId,
    }).select('*').single();
  if (error || !campaign) { res.status(500).json({ error: error?.message ?? 'insert failed' }); return; }

  const rows = body.targets.map((t) => ({
    campaign_id: campaign.id,
    phone_number: t.phone_number,
    customer_name: t.customer_name ?? null,
    custom_fields: t.custom_fields ?? {},
    owner_override: !!t.owner_override,
    status: 'pending' as const,
    scheduled_at: new Date().toISOString(),
  }));
  if (rows.length) await supabaseAdmin.from('campaign_calls').insert(rows);
  res.status(201).json(campaign);
});

const statusSchema = z.object({ status: z.enum(['draft', 'running', 'paused', 'completed']) });
aiCampaignsRouter.post('/ai/campaigns/:id/status', requireAuth, requireRole('owner'), async (req: AuthRequest, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Block resuming if cap is hit
  if (parsed.data.status === 'running') {
    const { isCapPaused } = await import('../lib/spendCap.js');
    if (await isCapPaused()) {
      res.status(409).json({ error: 'AI spend cap reached for today. Raise the cap or wait until tomorrow.' });
      return;
    }
  }

  const update: Record<string, unknown> = { status: parsed.data.status };
  if (parsed.data.status === 'running') update.started_at = new Date().toISOString();
  if (parsed.data.status === 'completed') update.completed_at = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from('outbound_campaigns').update(update).eq('id', req.params.id).select('*').single();
  if (error || !data) { res.status(500).json({ error: error?.message ?? 'update failed' }); return; }
  res.json(data);
});

aiCampaignsRouter.delete('/ai/campaigns/:id', requireAuth, requireRole('owner'), async (req, res) => {
  const { error } = await supabaseAdmin.from('outbound_campaigns').delete().eq('id', req.params.id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});
