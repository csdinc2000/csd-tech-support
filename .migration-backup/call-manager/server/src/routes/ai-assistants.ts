/**
 * /api/ai/assistants — CRUD + test-call.
 *
 * Owner-only writes. All authenticated users can list/read.
 * Every assistant change is mirrored to VAPI (graceful-degraded if VAPI keys
 * are missing).
 */
import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireAuth, requireRole, type AuthRequest } from '../middleware/auth.js';
import {
  upsertVapiAssistant,
  deleteVapiAssistant,
  placeCall,
  isVapiConfigured,
} from '../lib/vapi.js';

export const aiAssistantsRouter = Router();

const ASSISTANT_PURPOSES = ['inbound_receptionist', 'outbound_qualifier', 'callback_scheduler', 'custom'] as const;
const ALLOWED_TOOLS = ['lookup_ticket', 'schedule_callback', 'transfer_to_human', 'check_business_hours'] as const;

const upsertSchema = z.object({
  name: z.string().min(1).max(100),
  purpose: z.enum(ASSISTANT_PURPOSES).default('custom'),
  system_prompt: z.string().max(20_000).default(''),
  first_message: z.string().min(1).max(2_000),
  voice_id: z.string().min(1).max(80).default('jennifer'),
  model: z.string().min(1).max(80).default('gpt-4o-mini'),
  tools_enabled: z.array(z.enum(ALLOWED_TOOLS)).default([]),
  is_active: z.boolean().default(false),
});

// Compliance: every assistant prompt must include disclosure language. We
// auto-prepend it to first_message if missing.
const DISCLOSURE_HINT = 'automated assistant';
const RECORDING_HINT = 'recorded';
function ensureDisclosure(firstMessage: string): string {
  const lower = firstMessage.toLowerCase();
  if (lower.includes(DISCLOSURE_HINT) && lower.includes(RECORDING_HINT)) return firstMessage;
  return `You're speaking with an automated assistant, and this call is being recorded. ${firstMessage}`;
}

// Compliance: every assistant must have transfer_to_human available.
function ensureTransferTool(tools: string[]): string[] {
  return tools.includes('transfer_to_human') ? tools : [...tools, 'transfer_to_human'];
}

aiAssistantsRouter.get('/ai/assistants', requireAuth, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('ai_assistants')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ items: data ?? [], vapi_configured: isVapiConfigured() });
});

aiAssistantsRouter.get('/ai/assistants/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('ai_assistants').select('*').eq('id', req.params.id).maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!data) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(data);
});

aiAssistantsRouter.post('/ai/assistants', requireAuth, requireRole('owner'), async (req: AuthRequest, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const body = {
    ...parsed.data,
    first_message: ensureDisclosure(parsed.data.first_message),
    tools_enabled: ensureTransferTool(parsed.data.tools_enabled),
  };

  // Insert local row first
  const { data: row, error } = await supabaseAdmin
    .from('ai_assistants')
    .insert({ ...body, updated_at: new Date().toISOString() })
    .select('*').single();
  if (error || !row) { res.status(500).json({ error: error?.message ?? 'insert failed' }); return; }

  // Mirror to VAPI (best-effort)
  const sync = await upsertVapiAssistant({ vapi_assistant_id: null, ...body });
  let vapiId: string | null = null;
  if (sync.ok && sync.data && typeof (sync.data as { id?: unknown }).id === 'string') {
    vapiId = (sync.data as { id: string }).id;
    await supabaseAdmin.from('ai_assistants').update({ vapi_assistant_id: vapiId }).eq('id', row.id);
  }
  res.status(201).json({ ...row, vapi_assistant_id: vapiId, vapi_sync: { ok: sync.ok, error: sync.error, suppressed: sync.suppressed } });
});

aiAssistantsRouter.patch('/ai/assistants/:id', requireAuth, requireRole('owner'), async (req: AuthRequest, res) => {
  const parsed = upsertSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const { data: existing } = await supabaseAdmin
    .from('ai_assistants').select('*').eq('id', req.params.id).maybeSingle();
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

  const merged = {
    ...existing,
    ...parsed.data,
    first_message: parsed.data.first_message ? ensureDisclosure(parsed.data.first_message) : existing.first_message,
    tools_enabled: parsed.data.tools_enabled ? ensureTransferTool(parsed.data.tools_enabled) : existing.tools_enabled,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from('ai_assistants').update(merged).eq('id', req.params.id).select('*').single();
  if (error || !data) { res.status(500).json({ error: error?.message ?? 'update failed' }); return; }

  const sync = await upsertVapiAssistant({
    vapi_assistant_id: data.vapi_assistant_id,
    name: data.name,
    first_message: data.first_message,
    system_prompt: data.system_prompt,
    voice_id: data.voice_id,
    model: data.model,
    tools_enabled: data.tools_enabled,
  });
  if (sync.ok && !data.vapi_assistant_id && sync.data && typeof (sync.data as { id?: unknown }).id === 'string') {
    const vapiId = (sync.data as { id: string }).id;
    await supabaseAdmin.from('ai_assistants').update({ vapi_assistant_id: vapiId }).eq('id', data.id);
    data.vapi_assistant_id = vapiId;
  }
  res.json({ ...data, vapi_sync: { ok: sync.ok, error: sync.error, suppressed: sync.suppressed } });
});

aiAssistantsRouter.delete('/ai/assistants/:id', requireAuth, requireRole('owner'), async (req, res) => {
  const { data: existing } = await supabaseAdmin
    .from('ai_assistants').select('vapi_assistant_id').eq('id', req.params.id).maybeSingle();
  if (existing?.vapi_assistant_id) await deleteVapiAssistant(existing.vapi_assistant_id);
  const { error } = await supabaseAdmin.from('ai_assistants').delete().eq('id', req.params.id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

// Test-call: owner provides a target phone (their own) to ring with this assistant.
const testCallSchema = z.object({ to_number: z.string().min(8).max(20) });
aiAssistantsRouter.post('/ai/assistants/:id/test-call', requireAuth, requireRole('owner'), async (req: AuthRequest, res) => {
  const parsed = testCallSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  if (!isVapiConfigured()) {
    res.status(503).json({ error: 'VAPI not configured (VAPI_API_KEY missing)' }); return;
  }
  const { data: a } = await supabaseAdmin
    .from('ai_assistants').select('vapi_assistant_id, is_active').eq('id', req.params.id).maybeSingle();
  if (!a?.vapi_assistant_id) {
    res.status(400).json({ error: 'Assistant has not been synced to VAPI yet — re-save it first.' }); return;
  }
  const result = await placeCall({
    toNumber: parsed.data.to_number,
    vapiAssistantId: a.vapi_assistant_id,
    metadata: { test_call: true, assistant_id: req.params.id, requested_by: req.userId },
  });
  if (!result.ok) { res.status(502).json({ error: result.error ?? 'placeCall failed' }); return; }
  res.json({ ok: true, vapi_call_id: (result.data as { id?: string } | undefined)?.id });
});
