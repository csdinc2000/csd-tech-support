import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';

const router = Router();

// ── GET /api/voicemails ──────────────────────────────────────────────────────
router.get('/voicemails', requireAuth, async (req, res) => {
  const { unlistened, from, to } = req.query as Record<string, string | undefined>;

  let query = supabaseAdmin
    .from('voicemails')
    .select('*, call:calls!call_id(id, from_number, to_number, started_at)')
    .order('created_at', { ascending: false });

  if (unlistened === 'true') query = query.eq('is_listened', false);
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);

  const { data, error } = await query.limit(500);
  if (error) return res.status(500).json({ error: error.message });

  // Generate signed URLs for playback
  const items = await Promise.all(
    (data ?? []).map(async (vm) => {
      let signed: string | null = null;
      if (vm.recording_url) {
        const { data: s } = await supabaseAdmin.storage
          .from('call-recordings')
          .createSignedUrl(vm.recording_url, 3600);
        signed = s?.signedUrl ?? null;
      }
      return { ...vm, recording_signed_url: signed };
    }),
  );

  res.json(items);
});

// ── PATCH /api/voicemails/:id ────────────────────────────────────────────────
router.patch('/voicemails/:id', requireAuth, async (req: AuthRequest, res) => {
  const { is_listened, notes } = req.body as { is_listened?: boolean; notes?: string };

  const update: Record<string, unknown> = {};
  if (is_listened !== undefined) {
    update.is_listened = is_listened;
    if (is_listened) {
      update.listened_at = new Date().toISOString();
      update.listened_by = req.userId;
    } else {
      update.listened_at = null;
      update.listened_by = null;
    }
  }
  if (notes !== undefined) update.notes = notes;

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  const { data, error } = await supabaseAdmin
    .from('voicemails')
    .update(update)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

export { router as voicemailsRouter };
