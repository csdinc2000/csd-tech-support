/**
 * VAPI integration helpers.
 *
 * Provides:
 *   - vapiFetch(): low-level authenticated HTTP client.
 *   - upsertVapiAssistant(): mirror our local ai_assistants row to VAPI.
 *   - deleteVapiAssistant().
 *   - testCall(): place an outbound test-call to a target number using a
 *     given assistant.
 *   - placeCampaignCall(): place an outbound real-campaign call.
 *   - isVapiConfigured(): graceful-degradation gate.
 *
 * Requirements:
 *   - VAPI_API_KEY     — server-to-server REST key (Bearer)
 *   - VAPI_PRIVATE_KEY — used by the webhook handler to verify VAPI's signed
 *                        webhook calls. We accept this header on /webhooks/vapi.
 *
 * If keys are missing, every external call returns { ok: false, suppressed: true }
 * and the UI shows a clear "VAPI not configured" warning. Database-side state
 * still works so the team can author assistants/campaigns without paying.
 */
import { TWILIO_PHONE_NUMBER, PUBLIC_BASE_URL } from './twilio.js';

const VAPI_API_KEY = process.env.VAPI_API_KEY ?? '';
const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY ?? '';
const VAPI_BASE = 'https://api.vapi.ai';

export function isVapiConfigured(): boolean {
  return !!VAPI_API_KEY;
}

export function vapiWebhookSecret(): string {
  return VAPI_PRIVATE_KEY;
}

export interface VapiResult<T = unknown> {
  ok: boolean;
  suppressed?: boolean;
  status?: number;
  data?: T;
  error?: string;
}

async function vapiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<VapiResult<T>> {
  if (!isVapiConfigured()) {
    return { ok: false, suppressed: true, error: 'VAPI_API_KEY not set' };
  }
  try {
    const res = await fetch(`${VAPI_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const errMsg =
        data && typeof data === 'object' && 'message' in data
          ? String((data as { message: unknown }).message)
          : `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: errMsg, data: data as T };
    }
    return { ok: true, status: res.status, data: data as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'fetch failed' };
  }
}

// ── Assistant CRUD ──────────────────────────────────────────────────────────

export interface VapiAssistantPayload {
  name: string;
  firstMessage: string;
  model: { provider: string; model: string; messages: Array<{ role: string; content: string }> };
  voice: { provider: string; voiceId: string };
  serverUrl?: string;
  serverUrlSecret?: string;
  // VAPI tool registration uses a `tools` field; we register them
  // declaratively here so the LLM can call back to /webhooks/vapi/tool.
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
    };
  }>;
}

const TOOL_DEFINITIONS: Record<string, VapiAssistantPayload['tools'] extends infer T ? (T extends Array<infer U> ? U : never) : never> = {
  transfer_to_human: {
    type: 'function',
    function: {
      name: 'transfer_to_human',
      description: 'Warm-transfer the caller to a human. Use when the caller asks for a person or sounds distressed.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['owner', 'tech_queue'], description: 'Who to transfer to' },
        },
        required: ['target'],
      },
    },
  },
  check_business_hours: {
    type: 'function',
    function: {
      name: 'check_business_hours',
      description: 'Check whether the shop is currently open.',
      parameters: { type: 'object', properties: {} },
    },
  },
  schedule_callback: {
    type: 'function',
    function: {
      name: 'schedule_callback',
      description: 'Record a callback request. The team will follow up at the preferred_time.',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Callback phone number, E.164 if possible' },
          preferred_time: { type: 'string', description: 'Free-text time the caller asked for' },
          notes: { type: 'string', description: 'Brief description of the issue' },
        },
        required: ['phone'],
      },
    },
  },
  lookup_ticket: {
    type: 'function',
    function: {
      name: 'lookup_ticket',
      description: 'Look up an existing service ticket by its ticket number.',
      parameters: {
        type: 'object',
        properties: {
          ticket_number: { type: 'string', description: 'Ticket reference, e.g. CSD-12345' },
        },
        required: ['ticket_number'],
      },
    },
  },
};

function buildAssistantPayload(a: {
  name: string;
  first_message: string;
  system_prompt: string;
  voice_id: string;
  model: string;
  tools_enabled: string[];
}): VapiAssistantPayload {
  return {
    name: a.name,
    firstMessage: a.first_message,
    model: {
      provider: 'openai',
      model: a.model || 'gpt-4o-mini',
      messages: [{ role: 'system', content: a.system_prompt }],
    },
    voice: {
      // VAPI supports several providers; we use 11labs by default and let
      // the operator override voice_id (e.g. 'jennifer', 'rachel').
      provider: '11labs',
      voiceId: a.voice_id || 'jennifer',
    },
    serverUrl: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/webhooks/vapi` : undefined,
    serverUrlSecret: VAPI_PRIVATE_KEY || undefined,
    tools: a.tools_enabled
      .filter((t) => t in TOOL_DEFINITIONS)
      .map((t) => TOOL_DEFINITIONS[t]),
  };
}

export async function upsertVapiAssistant(a: {
  vapi_assistant_id: string | null;
  name: string;
  first_message: string;
  system_prompt: string;
  voice_id: string;
  model: string;
  tools_enabled: string[];
}): Promise<VapiResult<{ id: string }>> {
  const payload = buildAssistantPayload(a);
  if (a.vapi_assistant_id) {
    return vapiFetch(`/assistant/${a.vapi_assistant_id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  }
  return vapiFetch('/assistant', { method: 'POST', body: JSON.stringify(payload) });
}

export async function deleteVapiAssistant(vapiAssistantId: string): Promise<VapiResult> {
  return vapiFetch(`/assistant/${vapiAssistantId}`, { method: 'DELETE' });
}

// ── Outbound calls (test + campaign) ────────────────────────────────────────

export interface PlaceCallOptions {
  toNumber: string;
  vapiAssistantId: string;
  metadata?: Record<string, unknown>;
}

export async function placeCall(opts: PlaceCallOptions): Promise<VapiResult<{ id: string }>> {
  if (!TWILIO_PHONE_NUMBER) {
    return { ok: false, error: 'TWILIO_PHONE_NUMBER not configured' };
  }
  const body = {
    assistantId: opts.vapiAssistantId,
    phoneNumber: { twilioPhoneNumber: TWILIO_PHONE_NUMBER },
    customer: { number: opts.toNumber },
    metadata: opts.metadata ?? {},
  };
  return vapiFetch('/call', { method: 'POST', body: JSON.stringify(body) });
}
