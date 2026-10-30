import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';

const router = Router();

// ── GET /api/organizations ───────────────────────────────────────────────────
router.get('/organizations', requireAuth, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('organizations')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

// ── GET /api/me/organizations — orgs the current user belongs to ────────────
router.get('/me/organizations', requireAuth, async (req: AuthRequest, res) => {
  const { data, error } = await supabaseAdmin
    .from('org_memberships')
    .select('role, org:organizations!org_id(id, name, parent_org_id, settings, created_at)')
    .eq('user_id', req.userId!);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

// ── POST /api/organizations (owner only) ────────────────────────────────────
router.post('/organizations', requireAuth, requireRole('owner'), async (req: AuthRequest, res) => {
  const { name, parent_org_id, twilio_subaccount_sid, settings } = req.body as {
    name?: string;
    parent_org_id?: string | null;
    twilio_subaccount_sid?: string | null;
    settings?: Record<string, unknown>;
  };
  if (!name) return res.status(400).json({ error: 'name required' });
  const { data, error } = await supabaseAdmin
    .from('organizations')
    .insert({
      name,
      parent_org_id: parent_org_id ?? null,
      twilio_subaccount_sid: twilio_subaccount_sid ?? null,
      settings: settings ?? {},
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Auto-add the creating user as owner of the new org
  await supabaseAdmin.from('org_memberships').insert({
    org_id: data.id,
    user_id: req.userId!,
    role: 'owner',
  });

  res.status(201).json(data);
});

// ── PATCH /api/organizations/:id ────────────────────────────────────────────
router.patch('/organizations/:id', requireAuth, requireRole('owner'), async (req, res) => {
  const updates: Record<string, unknown> = {};
  const { name, parent_org_id, twilio_subaccount_sid, settings } = req.body as Record<string, unknown>;
  if (name !== undefined) updates.name = name;
  if (parent_org_id !== undefined) updates.parent_org_id = parent_org_id;
  if (twilio_subaccount_sid !== undefined) updates.twilio_subaccount_sid = twilio_subaccount_sid;
  if (settings !== undefined) updates.settings = settings;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No fields' });
  const { data, error } = await supabaseAdmin
    .from('organizations')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE /api/organizations/:id ───────────────────────────────────────────
router.delete('/organizations/:id', requireAuth, requireRole('owner'), async (req, res) => {
  // Refuse to delete the very first / default org
  const { data: first } = await supabaseAdmin
    .from('organizations')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(1)
    .single();
  if (first?.id === req.params.id) {
    return res.status(400).json({ error: 'Cannot delete the default organization' });
  }
  const { error } = await supabaseAdmin.from('organizations').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.sendStatus(204);
});

// ── GET /api/organizations/:id/members ──────────────────────────────────────
router.get('/organizations/:id/members', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('org_memberships')
    .select('role, user:users!user_id(id, email, full_name, phone, is_active)')
    .eq('org_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

// ── POST /api/organizations/:id/members ─────────────────────────────────────
router.post('/organizations/:id/members', requireAuth, requireRole('owner'), async (req, res) => {
  const { user_id, role = 'viewer' } = req.body as { user_id?: string; role?: string };
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  const { data, error } = await supabaseAdmin
    .from('org_memberships')
    .upsert({ org_id: req.params.id, user_id, role }, { onConflict: 'org_id,user_id' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ── DELETE /api/organizations/:orgId/members/:userId ────────────────────────
router.delete('/organizations/:orgId/members/:userId', requireAuth, requireRole('owner'), async (req, res) => {
  const { error } = await supabaseAdmin
    .from('org_memberships')
    .delete()
    .eq('org_id', req.params.orgId)
    .eq('user_id', req.params.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.sendStatus(204);
});

export { router as organizationsRouter };
