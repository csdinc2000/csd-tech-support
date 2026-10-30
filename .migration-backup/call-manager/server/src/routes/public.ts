import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';

const router = Router();

// ── GET /unsubscribe/:token (public) — disables daily_digest_email ──────────
// Returns a simple HTML confirmation page so the link works straight from email.
router.get('/unsubscribe/:token', async (req, res) => {
  const token = req.params.token;
  const { data } = await supabaseAdmin
    .from('notification_settings')
    .select('user_id')
    .eq('unsubscribe_token', token)
    .maybeSingle();

  if (!data) {
    res.status(404).type('html').send(htmlPage('Unsubscribe link not recognized.', false));
    return;
  }

  await supabaseAdmin
    .from('notification_settings')
    .update({ daily_digest_email: false, updated_at: new Date().toISOString() })
    .eq('user_id', data.user_id);

  res.type('html').send(
    htmlPage(
      'You have been unsubscribed from CSD Call Manager daily digest emails. ' +
        'You can re-enable them anytime in Settings → Notifications.',
      true,
    ),
  );
});

function htmlPage(message: string, ok: boolean): string {
  const color = ok ? '#10b981' : '#ef4444';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>CSD Call Manager</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b1220; color: #e2e8f0; margin: 0;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
  .card { background: #111a2e; border: 1px solid #1e293b; border-radius: 12px; padding: 32px; max-width: 480px; }
  h1 { margin-top: 0; color: ${color}; font-size: 18px; }
  p { line-height: 1.5; }
</style></head>
<body><div class="card">
  <h1>${ok ? 'Unsubscribed' : 'Could not unsubscribe'}</h1>
  <p>${message}</p>
</div></body></html>`;
}

export { router as publicRouter };
