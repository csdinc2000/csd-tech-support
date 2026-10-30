import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { supabaseAdmin } from '../lib/supabase.js';
import { twilioClient, TWILIO_PHONE_NUMBER, PUBLIC_BASE_URL } from '../lib/twilio.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import type { AuthRequest } from '../middleware/auth.js';
import { isOnDnc, normalizePhone } from '../lib/sms.js';

const router = Router();

const outboundLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  keyGenerator: (req) => (req as AuthRequest).userId ?? req.ip ?? 'unknown',
  message: { error: 'Rate limit exceeded: max 30 outbound calls per minute' },
});

// ── GET /api/calls ───────────────────────────────────────────────────────────
router.get('/calls', requireAuth, async (req, res) => {
  const {
    from: fromDate,
    to: toDate,
    direction,
    status,
    search,
    page = '1',
    limit = '50',
  } = req.query as Record<string, string>;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const offset = (pageNum - 1) * limitNum;

  let query = supabaseAdmin
    .from('calls')
    .select(
      `*, assigned_user:users!assigned_to_user_id(id, email, full_name, role)`,
      { count: 'exact' },
    );

  if (fromDate) query = query.gte('started_at', fromDate);
  if (toDate) query = query.lte('started_at', toDate);
  if (direction) query = query.eq('direction', direction);
  if (status) query = query.eq('status', status);

  if (search) {
    query = query.or(
      `from_number.ilike.%${search}%,to_number.ilike.%${search}%,customer_name.ilike.%${search}%,ticket_number.ilike.%${search}%`,
    );
  }

  const { data, error, count } = await query
    .order('started_at', { ascending: false })
    .range(offset, offset + limitNum - 1);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ data: data ?? [], total: count ?? 0, page: pageNum, limit: limitNum });
});

// ── GET /api/calls/export.csv ────────────────────────────────────────────────
router.get('/calls/export.csv', requireAuth, async (req, res) => {
  const {
    from: fromDate,
    to: toDate,
    direction,
    status,
    search,
  } = req.query as Record<string, string>;

  let query = supabaseAdmin.from('calls').select('*');

  if (fromDate) query = query.gte('started_at', fromDate);
  if (toDate) query = query.lte('started_at', toDate);
  if (direction) query = query.eq('direction', direction);
  if (status) query = query.eq('status', status);
  if (search) {
    query = query.or(
      `from_number.ilike.%${search}%,to_number.ilike.%${search}%,customer_name.ilike.%${search}%,ticket_number.ilike.%${search}%`,
    );
  }

  const { data, error } = await query.order('started_at', { ascending: false }).limit(10000);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const cols = [
    'id', 'direction', 'from_number', 'to_number', 'status',
    'duration_seconds', 'ivr_selection', 'customer_name',
    'ticket_number', 'notes', 'tags', 'started_at', 'ended_at',
  ];

  const escape = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = Array.isArray(v) ? v.join(';') : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };

  const rows = [cols.join(',')];
  for (const row of data ?? []) {
    rows.push(cols.map((c) => escape((row as Record<string, unknown>)[c])).join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="csd-calls-${Date.now()}.csv"`);
  res.send(rows.join('\r\n'));
});

// ── GET /api/calls/:id ───────────────────────────────────────────────────────
router.get('/calls/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  const { data: call, error } = await supabaseAdmin
    .from('calls')
    .select(`*, assigned_user:users!assigned_to_user_id(id, email, full_name, role)`)
    .eq('id', id)
    .single();

  if (error || !call) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }

  const { data: events } = await supabaseAdmin
    .from('call_events')
    .select('*')
    .eq('call_id', id)
    .order('created_at', { ascending: true });

  // Generate signed URL for recording if present
  let recordingSignedUrl: string | null = null;
  if (call.recording_url) {
    const { data: signed } = await supabaseAdmin.storage
      .from('call-recordings')
      .createSignedUrl(call.recording_url, 3600); // 1h expiry
    recordingSignedUrl = signed?.signedUrl ?? null;
  }

  res.json({ ...call, recording_signed_url: recordingSignedUrl, events: events ?? [] });
});

// ── PATCH /api/calls/:id ─────────────────────────────────────────────────────
router.patch('/calls/:id', requireAuth, async (req: AuthRequest, res) => {
  const { id } = req.params;
  const { notes, tags, customer_name, ticket_number, assigned_to_user_id } = req.body as {
    notes?: string;
    tags?: string[];
    customer_name?: string;
    ticket_number?: string;
    assigned_to_user_id?: string | null;
  };

  const allowedFields: Record<string, unknown> = {};
  if (notes !== undefined) allowedFields.notes = notes;
  if (tags !== undefined) allowedFields.tags = tags;
  if (customer_name !== undefined) allowedFields.customer_name = customer_name;
  if (ticket_number !== undefined) allowedFields.ticket_number = ticket_number;
  if (assigned_to_user_id !== undefined) allowedFields.assigned_to_user_id = assigned_to_user_id;

  if (Object.keys(allowedFields).length === 0) {
    res.status(400).json({ error: 'No updatable fields provided' });
    return;
  }

  const { data, error } = await supabaseAdmin
    .from('calls')
    .update(allowedFields)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Audit event
  await supabaseAdmin.from('call_events').insert({
    call_id: id,
    event_type: 'call_updated',
    payload: allowedFields,
    actor_user_id: req.userId,
  });

  res.json(data);
});

// ── POST /api/calls/outbound ─────────────────────────────────────────────────
router.post('/calls/outbound', requireAuth, requireRole('owner', 'tech'), outboundLimiter, async (req: AuthRequest, res) => {
  const { to_number } = req.body as { to_number?: string };

  if (!to_number) {
    res.status(400).json({ error: 'to_number required' });
    return;
  }
  const normalizedTo = normalizePhone(to_number);
  if (!normalizedTo) {
    res.status(400).json({ error: 'Invalid to_number — use E.164 format, e.g. +15551234567' });
    return;
  }

  // DNC check — block outbound calls to numbers on the Do Not Call list
  if (await isOnDnc(normalizedTo)) {
    res.status(403).json({ error: 'Number is on the Do Not Call list — outbound calls blocked' });
    return;
  }

  try {
    const call = await twilioClient.calls.create({
      to: normalizedTo,
      from: TWILIO_PHONE_NUMBER,
      url: `${PUBLIC_BASE_URL}/webhooks/voice/gather`,
      method: 'POST',
      statusCallback: `${PUBLIC_BASE_URL}/webhooks/voice/status`,
      statusCallbackMethod: 'POST',
      record: true,
      recordingStatusCallback: `${PUBLIC_BASE_URL}/webhooks/voice/recording`,
      recordingStatusCallbackMethod: 'POST',
    });

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('calls')
      .insert({
        twilio_call_sid: call.sid,
        direction: 'outbound',
        from_number: TWILIO_PHONE_NUMBER,
        to_number: normalizedTo,
        status: 'queued',
        assigned_to_user_id: req.userId,
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) console.error('[Outbound] insert error:', insertError);

    res.status(201).json({ call_sid: call.sid, call_id: inserted?.id });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Twilio error';
    res.status(500).json({ error: message });
  }
});

export { router as callsRouter };
