import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';

const router = Router();

// ── GET /api/me ──────────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req: AuthRequest, res) => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('id', req.userId!)
    .single();

  if (error || !data) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.json(data);
});

// ── GET /api/users ───────────────────────────────────────────────────────────
router.get('/users', requireAuth, requireRole('owner'), async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data ?? []);
});

// ── PATCH /api/users/:id ─────────────────────────────────────────────────────
router.patch('/users/:id', requireAuth, async (req: AuthRequest, res) => {
  const { id } = req.params;

  // Only owner can update others; anyone can update themselves
  if (req.userRole !== 'owner' && req.userId !== id) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const { full_name, phone, role, timezone, is_active } = req.body as {
    full_name?: string;
    phone?: string;
    role?: string;
    timezone?: string;
    is_active?: boolean;
  };

  // Only owners can change roles or active state
  const update: Record<string, unknown> = {};
  if (full_name !== undefined) update.full_name = full_name;
  if (phone !== undefined) update.phone = phone || null;
  if (timezone !== undefined) update.timezone = timezone;
  if (role !== undefined && req.userRole === 'owner') update.role = role;
  if (is_active !== undefined && req.userRole === 'owner') {
    update.is_active = is_active;
    update.deactivated_at = is_active ? null : new Date().toISOString();
  }

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: 'No updatable fields provided' });
    return;
  }

  // If role is changing, look up old role for the audit log
  let oldRole: string | null = null;
  if (role !== undefined && req.userRole === 'owner') {
    const { data: existing } = await supabaseAdmin
      .from('users').select('role').eq('id', id).single();
    oldRole = existing?.role ?? null;
  }

  const { data, error } = await supabaseAdmin
    .from('users')
    .update(update)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Audit role changes
  if (role !== undefined && req.userRole === 'owner' && oldRole !== role) {
    await supabaseAdmin.from('role_audit').insert({
      user_id: id,
      changed_by: req.userId,
      old_role: oldRole,
      new_role: role,
      scope: 'global',
    });
  }

  res.json(data);
});

// ── GET /api/users/:id/role-audit ───────────────────────────────────────────
router.get('/users/:id/role-audit', requireAuth, requireRole('owner'), async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('role_audit')
    .select('*, changer:users!changed_by(id, email, full_name)')
    .eq('user_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

// ── POST /api/users/invite ───────────────────────────────────────────────────
router.post('/users/invite', requireAuth, requireRole('owner'), async (req: AuthRequest, res) => {
  const { email, role = 'viewer', full_name = '' } = req.body as {
    email?: string;
    role?: string;
    full_name?: string;
  };

  if (!email) {
    res.status(400).json({ error: 'email is required' });
    return;
  }

  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    data: { role, full_name },
    redirectTo: `${process.env.PUBLIC_BASE_URL}/login`,
  });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // The trigger will create the users row; upgrade role if needed
  if (data.user) {
    await supabaseAdmin.from('users').upsert({
      id: data.user.id,
      email: data.user.email!,
      full_name,
      role,
    });
  }

  res.status(201).json({ message: `Invite sent to ${email}` });
});

export { router as usersRouter };
