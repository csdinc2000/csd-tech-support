import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

// All admin routes are owner-only
router.use(requireAuth, requireRole('owner'));

// ─── Business Hours ──────────────────────────────────────────────────────────
router.get('/admin/business-hours', async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('business_hours')
    .select('*')
    .order('day_of_week', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

router.put('/admin/business-hours', async (req, res) => {
  // Bulk upsert all 7 days
  const rows = req.body as Array<{
    day_of_week: number;
    open_time: string | null;
    close_time: string | null;
    timezone?: string;
  }>;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'Body must be an array' });

  const cleaned = rows.map((r) => ({
    day_of_week: r.day_of_week,
    open_time: r.open_time || null,
    close_time: r.close_time || null,
    timezone: r.timezone || 'America/New_York',
  }));

  const { error } = await supabaseAdmin.from('business_hours').upsert(cleaned, { onConflict: 'day_of_week' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── Holidays ────────────────────────────────────────────────────────────────
router.get('/admin/holidays', async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('holidays')
    .select('*')
    .order('date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

router.post('/admin/holidays', async (req, res) => {
  const { date, label, closed = true } = req.body as { date?: string; label?: string; closed?: boolean };
  if (!date || !label) return res.status(400).json({ error: 'date and label required' });
  const { data, error } = await supabaseAdmin
    .from('holidays')
    .insert({ date, label, closed })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.delete('/admin/holidays/:id', async (req, res) => {
  const { error } = await supabaseAdmin.from('holidays').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.sendStatus(204);
});

// ─── IVR Menus ───────────────────────────────────────────────────────────────
router.get('/admin/ivr-menus', async (_req, res) => {
  const { data: menus, error } = await supabaseAdmin
    .from('ivr_menus')
    .select('*')
    .order('name', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const { data: opts } = await supabaseAdmin
    .from('ivr_options')
    .select('*')
    .order('sort_order', { ascending: true });

  const grouped = (menus ?? []).map((m) => ({
    ...m,
    options: (opts ?? []).filter((o) => o.menu_id === m.id),
  }));
  res.json(grouped);
});

router.post('/admin/ivr-menus', async (req, res) => {
  const { name, greeting_text, greeting_audio_url, timeout_seconds, is_default, business_hours_state } = req.body as {
    name?: string;
    greeting_text?: string;
    greeting_audio_url?: string | null;
    timeout_seconds?: number;
    is_default?: boolean;
    business_hours_state?: 'open' | 'closed' | 'either';
  };
  if (!name) return res.status(400).json({ error: 'name required' });

  // If marking as default, unmark other defaults of the same state first
  if (is_default && business_hours_state) {
    await supabaseAdmin
      .from('ivr_menus')
      .update({ is_default: false })
      .eq('business_hours_state', business_hours_state)
      .eq('is_default', true);
  }

  const { data, error } = await supabaseAdmin
    .from('ivr_menus')
    .insert({
      name,
      greeting_text: greeting_text ?? '',
      greeting_audio_url: greeting_audio_url ?? null,
      timeout_seconds: timeout_seconds ?? 7,
      is_default: !!is_default,
      business_hours_state: business_hours_state ?? 'either',
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/admin/ivr-menus/:id', async (req, res) => {
  const updates = req.body as Record<string, unknown>;
  if (updates.is_default && updates.business_hours_state) {
    await supabaseAdmin
      .from('ivr_menus')
      .update({ is_default: false })
      .eq('business_hours_state', updates.business_hours_state)
      .eq('is_default', true)
      .neq('id', req.params.id);
  }
  const { data, error } = await supabaseAdmin
    .from('ivr_menus')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/admin/ivr-menus/:id', async (req, res) => {
  const { error } = await supabaseAdmin.from('ivr_menus').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.sendStatus(204);
});

// ─── IVR Options ─────────────────────────────────────────────────────────────
router.post('/admin/ivr-options', async (req, res) => {
  const { menu_id, digit, label, action, target, sort_order } = req.body as {
    menu_id?: string;
    digit?: string;
    label?: string;
    action?: string;
    target?: string | null;
    sort_order?: number;
  };
  if (!menu_id || !digit || !label || !action) {
    return res.status(400).json({ error: 'menu_id, digit, label, action required' });
  }
  const { data, error } = await supabaseAdmin
    .from('ivr_options')
    .insert({ menu_id, digit, label, action, target: target ?? null, sort_order: sort_order ?? 0 })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/admin/ivr-options/:id', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('ivr_options')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/admin/ivr-options/:id', async (req, res) => {
  const { error } = await supabaseAdmin.from('ivr_options').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.sendStatus(204);
});

// ─── Call Queues ─────────────────────────────────────────────────────────────
router.get('/admin/queues', async (_req, res) => {
  const { data: queues, error } = await supabaseAdmin
    .from('call_queues')
    .select('*')
    .order('name', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const { data: members } = await supabaseAdmin
    .from('queue_members')
    .select('queue_id, user_id, priority, user:users!user_id(id, email, full_name, phone, role)');

  const grouped = (queues ?? []).map((q) => ({
    ...q,
    members: (members ?? []).filter((m: { queue_id: string }) => m.queue_id === q.id),
  }));
  res.json(grouped);
});

router.post('/admin/queues', async (req, res) => {
  const { name, strategy = 'ring_all', max_wait_seconds = 60, on_timeout_action = 'voicemail', on_timeout_target } = req.body as Record<string, unknown>;
  if (!name) return res.status(400).json({ error: 'name required' });
  const { data, error } = await supabaseAdmin
    .from('call_queues')
    .insert({ name, strategy, max_wait_seconds, on_timeout_action, on_timeout_target: on_timeout_target ?? null })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/admin/queues/:id', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('call_queues')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/admin/queues/:id', async (req, res) => {
  const { error } = await supabaseAdmin.from('call_queues').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.sendStatus(204);
});

// Queue members
router.post('/admin/queues/:id/members', async (req, res) => {
  const { user_id, priority = 0 } = req.body as { user_id?: string; priority?: number };
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  const { data, error } = await supabaseAdmin
    .from('queue_members')
    .insert({ queue_id: req.params.id, user_id, priority })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.delete('/admin/queues/:id/members/:userId', async (req, res) => {
  const { error } = await supabaseAdmin
    .from('queue_members')
    .delete()
    .eq('queue_id', req.params.id)
    .eq('user_id', req.params.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.sendStatus(204);
});

export { router as adminRouter };
