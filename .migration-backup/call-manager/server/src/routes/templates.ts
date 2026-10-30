import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';

const router = Router();

router.get('/templates', requireAuth, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('message_templates')
    .select('*')
    .order('name', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

router.post('/templates', requireAuth, async (req: AuthRequest, res) => {
  const { name, body, shared = true } = req.body as { name?: string; body?: string; shared?: boolean };
  if (!name || !body) return res.status(400).json({ error: 'name and body required' });
  const { data, error } = await supabaseAdmin
    .from('message_templates')
    .insert({ name, body, shared, created_by: req.userId })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/templates/:id', requireAuth, async (req, res) => {
  const { name, body, shared } = req.body as { name?: string; body?: string; shared?: boolean };
  const updates: Record<string, unknown> = {};
  if (name !== undefined) updates.name = name;
  if (body !== undefined) updates.body = body;
  if (shared !== undefined) updates.shared = shared;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No fields' });
  const { data, error } = await supabaseAdmin
    .from('message_templates')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/templates/:id', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin.from('message_templates').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.sendStatus(204);
});

export { router as templatesRouter };
