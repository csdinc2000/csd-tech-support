import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';
import { sendEmail, renderEmailTemplate } from '../lib/email.js';

const router = Router();

router.get('/email-templates', requireAuth, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('email_templates')
    .select('*')
    .order('trigger', { ascending: true })
    .order('name', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data ?? []);
});

router.post('/email-templates', requireAuth, requireRole('owner'), async (req, res) => {
  const { name, subject, body_html, body_text, trigger = 'manual', org_id } = req.body as Record<string, string | null | undefined>;
  if (!name || !subject || !body_html || !body_text) {
    return res.status(400).json({ error: 'name, subject, body_html, body_text required' });
  }
  const { data, error } = await supabaseAdmin
    .from('email_templates')
    .insert({ name, subject, body_html, body_text, trigger, org_id: org_id ?? null })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

router.patch('/email-templates/:id', requireAuth, requireRole('owner'), async (req, res) => {
  const allowed = ['name', 'subject', 'body_html', 'body_text', 'trigger', 'org_id'];
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (k in req.body) updates[k] = (req.body as Record<string, unknown>)[k];
  const { data, error } = await supabaseAdmin
    .from('email_templates')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/email-templates/:id', requireAuth, requireRole('owner'), async (req, res) => {
  const { error } = await supabaseAdmin.from('email_templates').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.sendStatus(204);
});

// ── POST /api/email-templates/preview — render with sample context ──────────
router.post('/email-templates/preview', requireAuth, async (req, res) => {
  const { subject, body_html, body_text, context } = req.body as {
    subject?: string; body_html?: string; body_text?: string;
    context?: Record<string, unknown>;
  };
  const ctx = context ?? {};
  res.json({
    subject: renderEmailTemplate(subject ?? '', ctx),
    body_html: renderEmailTemplate(body_html ?? '', ctx),
    body_text: renderEmailTemplate(body_text ?? '', ctx),
  });
});

// ── POST /api/email-templates/:id/test-send ─────────────────────────────────
router.post('/email-templates/:id/test-send', requireAuth, requireRole('owner'), async (req: AuthRequest, res) => {
  const { to, context } = req.body as { to?: string; context?: Record<string, unknown> };
  const { data: tpl } = await supabaseAdmin
    .from('email_templates')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (!tpl) return res.status(404).json({ error: 'Template not found' });

  // Default to the current user's email
  let target = to;
  if (!target) {
    const { data: me } = await supabaseAdmin.from('users').select('email').eq('id', req.userId!).single();
    target = me?.email;
  }
  if (!target) return res.status(400).json({ error: 'No recipient' });

  const ctx = { recipient_name: 'Test', ...context };
  const r = await sendEmail({
    to: target,
    subject: '[TEST] ' + renderEmailTemplate(tpl.subject, ctx),
    html: renderEmailTemplate(tpl.body_html, ctx),
    text: renderEmailTemplate(tpl.body_text, ctx),
  });
  res.json({ ok: r.ok, suppressed: !!r.suppressed, error: r.error ?? null, to: target });
});

export { router as emailTemplatesRouter };
