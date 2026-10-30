import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';
import { sendEmail, renderEmailTemplate, loadTemplateByTrigger } from '../lib/email.js';
import { PUBLIC_BASE_URL } from '../lib/twilio.js';

const router = Router();

// ── GET /api/invitations ────────────────────────────────────────────────────
router.get('/invitations', requireAuth, requireRole('owner'), async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('invitations')
    .select('*, org:organizations!org_id(id, name)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

// ── POST /api/invitations (owner) ───────────────────────────────────────────
router.post('/invitations', requireAuth, requireRole('owner'), async (req: AuthRequest, res) => {
  const { email, role = 'viewer', org_id } = req.body as {
    email?: string; role?: string; org_id?: string;
  };
  if (!email) return res.status(400).json({ error: 'email required' });

  // Default to first org if none provided
  let targetOrgId = org_id;
  if (!targetOrgId) {
    const { data: firstOrg } = await supabaseAdmin
      .from('organizations')
      .select('id')
      .order('created_at', { ascending: true })
      .limit(1)
      .single();
    targetOrgId = firstOrg?.id;
  }
  if (!targetOrgId) return res.status(400).json({ error: 'No organization found' });

  const { data: inv, error } = await supabaseAdmin
    .from('invitations')
    .insert({
      email: email.toLowerCase(),
      org_id: targetOrgId,
      role,
      invited_by: req.userId,
    })
    .select('*, org:organizations!org_id(id, name)')
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Get inviter's name for the email
  const { data: inviter } = await supabaseAdmin
    .from('users')
    .select('full_name, email')
    .eq('id', req.userId!)
    .single();

  const acceptUrl = `${PUBLIC_BASE_URL}/accept-invite?token=${inv.token}`;
  const ctx = {
    inviter_name: inviter?.full_name || inviter?.email || 'A team member',
    org_name: (inv.org as { name: string } | null)?.name ?? 'CSD Call Manager',
    role,
    accept_url: acceptUrl,
    expires_at: new Date(inv.expires_at).toLocaleDateString(),
  };

  const tpl = await loadTemplateByTrigger('invitation', targetOrgId);
  let sendResult: { ok: boolean; error?: string; suppressed?: boolean } = { ok: false };
  if (tpl) {
    sendResult = await sendEmail({
      to: email,
      subject: renderEmailTemplate(tpl.subject, ctx),
      html: renderEmailTemplate(tpl.body_html, ctx),
      text: renderEmailTemplate(tpl.body_text, ctx),
    });
  }

  res.status(201).json({
    invitation: inv,
    accept_url: acceptUrl,
    email_sent: sendResult.ok,
    email_suppressed: !!sendResult.suppressed,
    email_error: sendResult.error ?? null,
  });
});

// ── POST /api/invitations/accept (public — token-based) ─────────────────────
router.post('/invitations/accept', async (req, res) => {
  const { token, password, full_name } = req.body as {
    token?: string; password?: string; full_name?: string;
  };
  if (!token || !password) return res.status(400).json({ error: 'token and password required' });

  const { data: inv } = await supabaseAdmin
    .from('invitations')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (!inv) return res.status(404).json({ error: 'Invalid invitation token' });
  if (inv.accepted_at) return res.status(400).json({ error: 'Invitation already accepted' });
  if (new Date(inv.expires_at) < new Date()) {
    return res.status(400).json({ error: 'Invitation has expired' });
  }

  // Create the auth user
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email: inv.email,
    password,
    email_confirm: true,
    user_metadata: { full_name: full_name ?? '', role: inv.role },
  });
  if (createErr || !created.user) {
    return res.status(500).json({ error: createErr?.message ?? 'Failed to create user' });
  }

  // Upsert profile
  await supabaseAdmin.from('users').upsert({
    id: created.user.id,
    email: inv.email,
    full_name: full_name ?? '',
    role: inv.role === 'admin' ? 'owner' : inv.role,
  });

  // Add to org
  await supabaseAdmin.from('org_memberships').upsert(
    { org_id: inv.org_id, user_id: created.user.id, role: inv.role },
    { onConflict: 'org_id,user_id' },
  );

  // Default notification settings
  await supabaseAdmin.from('notification_settings').upsert(
    { user_id: created.user.id },
    { onConflict: 'user_id' },
  );

  // Mark accepted
  await supabaseAdmin
    .from('invitations')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', inv.id);

  res.status(201).json({ ok: true, user_id: created.user.id });
});

// ── DELETE /api/invitations/:id ─────────────────────────────────────────────
router.delete('/invitations/:id', requireAuth, requireRole('owner'), async (req, res) => {
  const { error } = await supabaseAdmin.from('invitations').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.sendStatus(204);
});

export { router as invitationsRouter };
