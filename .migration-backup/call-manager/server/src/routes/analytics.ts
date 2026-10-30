import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

interface CallRow {
  id: string;
  direction: 'inbound' | 'outbound';
  status: string;
  duration_seconds: number | null;
}

const router = Router();

function parseRange(req: { query: Record<string, unknown> }) {
  const to = (req.query.to as string) || new Date().toISOString();
  const from =
    (req.query.from as string) ||
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

// ── GET /api/analytics/summary ───────────────────────────────────────────────
router.get('/analytics/summary', requireAuth, async (req, res) => {
  const { from, to } = parseRange(req);

  const { data: calls, error } = await supabaseAdmin
    .from('calls')
    .select('id, direction, status, duration_seconds, started_at')
    .gte('started_at', from)
    .lte('started_at', to);
  if (error) return res.status(500).json({ error: error.message });

  const all = (calls ?? []) as CallRow[];
  const inbound = all.filter((c) => c.direction === 'inbound');
  const outbound = all.filter((c) => c.direction === 'outbound');
  const inboundAnswered = inbound.filter((c) => c.status === 'completed' || c.status === 'in-progress');
  const inboundMissed = inbound.filter((c) => ['no-answer', 'busy', 'failed', 'canceled'].includes(c.status));
  const completedDur = all.filter((c) => c.duration_seconds && c.duration_seconds > 0);
  const avgDur = completedDur.length
    ? Math.round(completedDur.reduce((s, c) => s + (c.duration_seconds ?? 0), 0) / completedDur.length)
    : 0;

  const { count: vmCount } = await supabaseAdmin
    .from('voicemails')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', from)
    .lte('created_at', to);

  res.json({
    from,
    to,
    total_calls: all.length,
    inbound_total: inbound.length,
    inbound_answered: inboundAnswered.length,
    inbound_missed: inboundMissed.length,
    outbound_total: outbound.length,
    answered_pct: inbound.length ? Math.round((inboundAnswered.length / inbound.length) * 100) : 0,
    missed_pct: inbound.length ? Math.round((inboundMissed.length / inbound.length) * 100) : 0,
    avg_duration_seconds: avgDur,
    voicemails: vmCount ?? 0,
  });
});

// ── GET /api/analytics/timeseries ────────────────────────────────────────────
router.get('/analytics/timeseries', requireAuth, async (req, res) => {
  const { from, to } = parseRange(req);
  const granularity = ((req.query.granularity as string) || 'day') as 'hour' | 'day';

  const { data: calls, error } = await supabaseAdmin
    .from('calls')
    .select('direction, status, started_at')
    .gte('started_at', from)
    .lte('started_at', to)
    .order('started_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const buckets = new Map<string, { inbound_answered: number; inbound_missed: number; outbound: number }>();

  for (const c of calls ?? []) {
    const d = new Date(c.started_at as string);
    const key = bucketKey(d, granularity);
    const b = buckets.get(key) ?? { inbound_answered: 0, inbound_missed: 0, outbound: 0 };
    if (c.direction === 'outbound') b.outbound++;
    else if (c.status === 'completed' || c.status === 'in-progress') b.inbound_answered++;
    else b.inbound_missed++;
    buckets.set(key, b);
  }

  // Hour-of-day heatmap distribution (independent of date range for the heatmap chart)
  const hourOfDay = new Array(24).fill(0).map((_, h) => ({ hour: h, calls: 0 }));
  for (const c of calls ?? []) {
    const h = new Date(c.started_at as string).getHours();
    hourOfDay[h].calls++;
  }

  const points = Array.from(buckets.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([bucket, v]) => ({ bucket, ...v }));

  res.json({ granularity, points, hour_of_day: hourOfDay });
});

// ── GET /api/analytics/ivr-distribution ──────────────────────────────────────
router.get('/analytics/ivr-distribution', requireAuth, async (req, res) => {
  const { from, to } = parseRange(req);
  const { data, error } = await supabaseAdmin
    .from('calls')
    .select('ivr_selection')
    .gte('started_at', from)
    .lte('started_at', to)
    .not('ivr_selection', 'is', null);
  if (error) return res.status(500).json({ error: error.message });

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const sel = (row.ivr_selection as string) || 'unknown';
    counts.set(sel, (counts.get(sel) ?? 0) + 1);
  }

  const entries = Array.from(counts.entries())
    .map(([selection, count]) => ({ selection, count }))
    .sort((a, b) => b.count - a.count);

  res.json(entries);
});

// ── GET /api/analytics/top-numbers ───────────────────────────────────────────
router.get('/analytics/top-numbers', requireAuth, async (req, res) => {
  const { from, to } = parseRange(req);
  const { data, error } = await supabaseAdmin
    .from('calls')
    .select('from_number, started_at')
    .eq('direction', 'inbound')
    .gte('started_at', from)
    .lte('started_at', to);
  if (error) return res.status(500).json({ error: error.message });

  const map = new Map<string, { count: number; last_call: string }>();
  for (const r of data ?? []) {
    const num = r.from_number as string;
    const ts = r.started_at as string;
    const cur = map.get(num) ?? { count: 0, last_call: ts };
    cur.count++;
    if (ts > cur.last_call) cur.last_call = ts;
    map.set(num, cur);
  }
  const entries = Array.from(map.entries())
    .map(([number, v]) => ({ number, ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  res.json(entries);
});

// ── GET /api/analytics/tech-performance (owner-only) ─────────────────────────
router.get('/analytics/tech-performance', requireAuth, requireRole('owner'), async (req, res) => {
  const { from, to } = parseRange(req);

  const { data: calls } = await supabaseAdmin
    .from('calls')
    .select('assigned_to_user_id, duration_seconds')
    .gte('started_at', from)
    .lte('started_at', to)
    .not('assigned_to_user_id', 'is', null);

  const { data: users } = await supabaseAdmin
    .from('users')
    .select('id, full_name, email, role')
    .in('role', ['owner', 'tech']);

  const { data: vmReturns } = await supabaseAdmin
    .from('voicemails')
    .select('listened_by')
    .gte('listened_at', from)
    .lte('listened_at', to)
    .not('listened_by', 'is', null);

  const out = (users ?? []).map((u) => {
    const handled = (calls ?? []).filter((c) => c.assigned_to_user_id === u.id);
    const dur = handled.filter((c) => c.duration_seconds && c.duration_seconds > 0);
    const avg = dur.length
      ? Math.round(dur.reduce((s, c) => s + (c.duration_seconds ?? 0), 0) / dur.length)
      : 0;
    const vms = (vmReturns ?? []).filter((v) => v.listened_by === u.id).length;
    return {
      user_id: u.id,
      full_name: u.full_name,
      email: u.email,
      calls_handled: handled.length,
      avg_duration_seconds: avg,
      voicemails_returned: vms,
    };
  });

  res.json(out);
});

// ── GET /api/analytics/export.csv ────────────────────────────────────────────
router.get('/analytics/export.csv', requireAuth, async (req, res) => {
  const { from, to } = parseRange(req);
  const { data, error } = await supabaseAdmin
    .from('calls')
    .select('started_at, direction, from_number, to_number, status, duration_seconds, ivr_selection, assigned_to_user_id')
    .gte('started_at', from)
    .lte('started_at', to)
    .order('started_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const cols = ['started_at', 'direction', 'from_number', 'to_number', 'status', 'duration_seconds', 'ivr_selection', 'assigned_to_user_id'];
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return '';
    return `"${String(v).replace(/"/g, '""')}"`;
  };
  const rows = [cols.join(',')];
  for (const r of data ?? []) {
    rows.push(cols.map((c) => escape((r as Record<string, unknown>)[c])).join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="csd-analytics-${Date.now()}.csv"`);
  res.send(rows.join('\r\n'));
});

function bucketKey(d: Date, granularity: 'hour' | 'day'): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  if (granularity === 'day') return `${yyyy}-${mm}-${dd}`;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:00`;
}

export { router as analyticsRouter };
