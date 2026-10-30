import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../lib/supabase.js';
import { twilioClient, TWILIO_PHONE_NUMBER, PUBLIC_BASE_URL } from '../lib/twilio.js';
import { requireAuth, requireAuthSse, requireRole } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';
import { addSseClient, broadcastSse } from '../lib/sse.js';
import {
  normalizePhone,
  threadKeyFor,
  renderTemplate,
  lookupContactForNumber,
  isOnDnc,
} from '../lib/sms.js';

const router = Router();

const sendLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  keyGenerator: (req) => (req as AuthRequest).userId ?? req.ip ?? 'unknown',
  message: { error: 'Rate limit exceeded: max 60 outbound SMS per minute' },
});

// ── GET /api/messages — list threads (one row per partner) ───────────────────
router.get('/messages', requireAuth, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(2000);

  if (error) return res.status(500).json({ error: error.message });

  const byThread = new Map<string, {
    thread_key: string;
    last_message: typeof data[number];
    unread_count: number;
    total: number;
  }>();

  for (const m of data ?? []) {
    const tk = m.thread_key;
    const existing = byThread.get(tk);
    if (!existing) {
      byThread.set(tk, { thread_key: tk, last_message: m, unread_count: 0, total: 1 });
    } else {
      existing.total++;
    }
  }

  const threads = Array.from(byThread.values()).sort(
    (a, b) => +new Date(b.last_message.created_at) - +new Date(a.last_message.created_at),
  );

  res.json(threads);
});

// ── GET /api/messages/thread/:thread_key ─────────────────────────────────────
router.get('/messages/thread/:threadKey', requireAuth, async (req, res) => {
  const threadKey = req.params.threadKey as string;
  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('*')
    .eq('thread_key', threadKey)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) return res.status(500).json({ error: error.message });

  const contact = await lookupContactForNumber(threadKey);
  res.json({ thread_key: threadKey, messages: data ?? [], contact });
});

// ── GET /api/messages/stream — SSE for real-time updates ─────────────────────
router.get('/messages/stream', requireAuthSse, async (req: AuthRequest, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 5000\n\n');
  res.write('event: hello\ndata: {"ok":true}\n\n');
  addSseClient(res, req.userId!);
});

// ── POST /api/messages — send SMS ────────────────────────────────────────────
router.post('/messages', requireAuth, requireRole('owner', 'tech'), sendLimiter, async (req: AuthRequest, res) => {
  const { to_number, body, template_id, media_urls } = req.body as {
    to_number?: string;
    body?: string;
    template_id?: string;
    media_urls?: string[];
  };

  if (!to_number) return res.status(400).json({ error: 'to_number required' });
  const normalized = normalizePhone(to_number);
  if (!normalized) return res.status(400).json({ error: 'Invalid to_number — use E.164' });

  // DNC check
  if (await isOnDnc(normalized)) {
    return res.status(403).json({ error: 'Number is on the Do Not Call list — outbound blocked' });
  }

  // Render template if provided
  let resolvedBody = body ?? '';
  if (template_id) {
    const { data: tpl } = await supabaseAdmin
      .from('message_templates')
      .select('body')
      .eq('id', template_id)
      .maybeSingle();
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    const contact = await lookupContactForNumber(normalized);
    resolvedBody = renderTemplate(tpl.body, {
      customer_name: contact.customer_name,
      ticket_number: contact.ticket_number,
    });
  }

  if (!resolvedBody.trim() && (!media_urls || media_urls.length === 0)) {
    return res.status(400).json({ error: 'Message body or media required' });
  }

  try {
    const tw = await twilioClient.messages.create({
      to: normalized,
      from: TWILIO_PHONE_NUMBER,
      body: resolvedBody,
      ...(media_urls && media_urls.length ? { mediaUrl: media_urls } : {}),
      statusCallback: `${PUBLIC_BASE_URL}/webhooks/sms/status`,
    });

    const threadKey = threadKeyFor('outbound', TWILIO_PHONE_NUMBER, normalized);

    // Upsert (not insert) on the SID — the /webhooks/sms/status callback
    // can race ahead and create a placeholder row before this code runs.
    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('messages')
      .upsert(
        {
          twilio_message_sid: tw.sid,
          direction: 'outbound',
          from_number: TWILIO_PHONE_NUMBER,
          to_number: normalized,
          body: resolvedBody,
          status: 'queued',
          media_urls: media_urls && media_urls.length ? media_urls : null,
          sent_by_user_id: req.userId,
          thread_key: threadKey,
        },
        { onConflict: 'twilio_message_sid' },
      )
      .select()
      .single();

    if (insertError) console.error('[Messages] insert error:', insertError);
    if (inserted) broadcastSse('message:new', inserted);

    res.status(201).json(inserted);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Twilio error';
    res.status(500).json({ error: message });
  }
});

export { router as messagesRouter };
