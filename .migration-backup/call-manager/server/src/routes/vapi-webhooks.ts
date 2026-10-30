/**
 * VAPI server webhook + tool dispatcher.
 *
 * Receives:
 *   - tool-calls (LLM function-calling): respond inline with tool result.
 *   - end-of-call-report: persist transcript, summary, cost, outcome.
 *   - status updates: best-effort logging.
 *
 * Authentication: VAPI signs every request with the assistant's
 * `serverUrlSecret` (we set this to VAPI_PRIVATE_KEY at assistant creation).
 * VAPI sends the secret back in the `x-vapi-secret` header. We compare it to
 * env. If VAPI_PRIVATE_KEY is empty, we skip the check (dev mode).
 */
import { Router } from 'express';
import express from 'express';
import { supabaseAdmin } from '../lib/supabase.js';
import { recordSpend } from '../lib/spendCap.js';
import { vapiWebhookSecret } from '../lib/vapi.js';
import { isOpenNow } from './_businessHoursHelper.js';
import { TWILIO_OWNER_FORWARD_NUMBER } from '../lib/twilio.js';

export const vapiWebhookRouter = Router();

// VAPI sends JSON bodies; the global '/webhooks' bodyParser is urlencoded
// (for Twilio), so attach a JSON parser locally.
vapiWebhookRouter.use('/vapi', express.json({ limit: '5mb' }));

function verify(req: express.Request): boolean {
  const expected = vapiWebhookSecret();
  if (!expected) {
    // Production hardening: refuse to process unsigned VAPI webhooks unless
    // we are explicitly running in development. The /webhooks/vapi endpoint
    // mutates billing-relevant DB state (sessions, callbacks, ai_spend_log),
    // so an unauthenticated path is a serious security issue.
    if (process.env.NODE_ENV === 'production') {
      console.error('[vapi] VAPI_PRIVATE_KEY missing in production — rejecting webhook');
      return false;
    }
    console.warn('[vapi] VAPI_PRIVATE_KEY not set — accepting unsigned webhook (dev only)');
    return true;
  }
  const provided = req.header('x-vapi-secret') || req.header('x-vapi-signature') || '';
  return provided === expected;
}

interface ToolCall {
  id?: string;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { vapi_call_id: string | null; assistant_id: string | null },
): Promise<unknown> {
  switch (name) {
    case 'transfer_to_human': {
      const target = String(args.target ?? 'owner');
      const number = TWILIO_OWNER_FORWARD_NUMBER || null;
      // Mark the matching session, if any, as transferred.
      if (ctx.vapi_call_id) {
        await supabaseAdmin.from('ai_call_sessions')
          .update({ outcome: 'transferred' })
          .eq('vapi_call_id', ctx.vapi_call_id);
      }
      return {
        action: 'transfer',
        target, number,
        message: number
          ? `Transferring you to a team member now.`
          : `I'm sorry, no human is available to transfer to right now. I'll have someone call you back.`,
      };
    }
    case 'check_business_hours': {
      const open = await isOpenNow();
      return { open };
    }
    case 'schedule_callback': {
      const phone = String(args.phone ?? '').trim();
      if (!phone) return { ok: false, error: 'phone required' };
      const sessionLookup = ctx.vapi_call_id
        ? await supabaseAdmin.from('ai_call_sessions').select('id').eq('vapi_call_id', ctx.vapi_call_id).maybeSingle()
        : { data: null };
      const { data, error } = await supabaseAdmin.from('callbacks').insert({
        phone_number: phone,
        preferred_time: args.preferred_time ? String(args.preferred_time) : null,
        notes: args.notes ? String(args.notes) : null,
        source: 'ai_assistant',
        ai_session_id: sessionLookup.data?.id ?? null,
      }).select('id').single();
      if (error) return { ok: false, error: error.message };
      if (ctx.vapi_call_id) {
        await supabaseAdmin.from('ai_call_sessions')
          .update({ outcome: 'scheduled_callback' })
          .eq('vapi_call_id', ctx.vapi_call_id);
      }
      return { ok: true, callback_id: data?.id, message: 'Got it. A technician will reach out shortly.' };
    }
    case 'lookup_ticket': {
      const num = String(args.ticket_number ?? '').trim();
      if (!num) return { ok: false, error: 'ticket_number required' };
      // Phase 5 stub. Phase 6 will swap in real RMM lookup.
      return {
        ok: true,
        ticket_number: num,
        status: 'in_progress',
        opened_on: '2026-01-12',
        device: 'Custom gaming PC',
        notes: '(stub) waiting on parts',
      };
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}

// ── Main webhook ──────────────────────────────────────────────────────────
vapiWebhookRouter.post('/vapi', async (req, res) => {
  if (!verify(req)) { res.status(401).json({ error: 'invalid signature' }); return; }

  const message = (req.body?.message ?? req.body) as Record<string, unknown>;
  const type = String(message.type ?? '');

  try {
    switch (type) {
      case 'tool-calls': {
        const call = (message.call ?? {}) as { id?: string; assistantId?: string };
        const toolCalls = (message.toolCalls ?? message.toolCallList ?? []) as ToolCall[];
        const results: Array<{ toolCallId: string; result: unknown }> = [];
        for (const tc of toolCalls) {
          const name = tc.function?.name ?? '';
          let args: Record<string, unknown> = {};
          const raw = tc.function?.arguments;
          if (typeof raw === 'string') {
            try { args = JSON.parse(raw); } catch { args = {}; }
          } else if (raw && typeof raw === 'object') {
            args = raw;
          }
          const r = await runTool(name, args, {
            vapi_call_id: call.id ?? null,
            assistant_id: call.assistantId ?? null,
          });
          results.push({ toolCallId: tc.id ?? '', result: r });
        }
        res.json({ results });
        return;
      }

      case 'end-of-call-report': {
        const call = (message.call ?? {}) as { id?: string; assistantId?: string; customer?: { number?: string }; phoneNumber?: { twilioPhoneNumber?: string } };
        const summary = (message.summary as string | undefined) ?? null;
        const transcript = message.transcript ?? message.messages ?? [];
        const cost = typeof message.cost === 'number' ? Math.round(message.cost * 100) : null;
        const duration = typeof message.durationSeconds === 'number' ? Math.round(message.durationSeconds) : null;
        const endedReason = String(message.endedReason ?? '');
        const metadata = (message.call as { metadata?: Record<string, unknown> } | undefined)?.metadata ?? {};
        const analysis = (message.analysis ?? {}) as { structuredData?: Record<string, unknown>; summary?: string };

        // Resolve our local assistant row (by VAPI assistant id)
        const { data: assistantRow } = call.assistantId
          ? await supabaseAdmin.from('ai_assistants').select('id').eq('vapi_assistant_id', call.assistantId).maybeSingle()
          : { data: null };

        // Resolve outcome
        let outcome: 'transferred' | 'scheduled_callback' | 'completed' | 'abandoned' | 'escalated' = 'completed';
        if (endedReason.includes('customer-ended') && (duration ?? 0) < 8) outcome = 'abandoned';

        // Upsert by vapi_call_id
        const sessionPayload = {
          vapi_call_id: call.id ?? null,
          assistant_id: assistantRow?.id ?? null,
          transcript: transcript as unknown,
          summary: analysis.summary ?? summary,
          extracted_data: analysis.structuredData ?? null,
          outcome,
          cost_cents: cost,
          duration_sec: duration,
          ended_at: new Date().toISOString(),
        };

        const { data: existing } = call.id
          ? await supabaseAdmin.from('ai_call_sessions').select('id, outcome').eq('vapi_call_id', call.id).maybeSingle()
          : { data: null };

        let sessionId: string | null = existing?.id ?? null;
        if (existing) {
          // Don't downgrade outcome — if a tool already set 'transferred' or 'scheduled_callback', keep it
          const finalOutcome = existing.outcome && existing.outcome !== 'completed' ? existing.outcome : outcome;
          await supabaseAdmin.from('ai_call_sessions')
            .update({ ...sessionPayload, outcome: finalOutcome })
            .eq('id', existing.id);
        } else {
          const { data: ins } = await supabaseAdmin.from('ai_call_sessions').insert(sessionPayload).select('id').single();
          sessionId = ins?.id ?? null;
        }

        // Record spend
        if (cost && cost > 0) await recordSpend(sessionId, cost);

        // If this was a campaign call, update the matching campaign_calls row
        const campaignCallId = typeof metadata.campaign_call_id === 'string' ? metadata.campaign_call_id : null;
        if (campaignCallId) {
          await supabaseAdmin.from('campaign_calls').update({
            status: 'completed',
            completed_at: new Date().toISOString(),
          }).eq('id', campaignCallId);
        }

        // Try to capture customer name from extracted data
        if (analysis.structuredData && typeof analysis.structuredData['customer_name'] === 'string') {
          const phone = call.customer?.number;
          if (phone) {
            await supabaseAdmin.from('calls')
              .update({ customer_name: String(analysis.structuredData['customer_name']) })
              .eq('from_number', phone)
              .is('customer_name', null);
          }
        }

        res.json({ ok: true });
        return;
      }

      case 'status-update':
      case 'speech-update':
      case 'hang':
      case 'transcript':
      default: {
        res.json({ ok: true });
        return;
      }
    }
  } catch (err) {
    console.error('[vapi-webhook]', err);
    res.status(500).json({ error: 'internal error' });
  }
});
