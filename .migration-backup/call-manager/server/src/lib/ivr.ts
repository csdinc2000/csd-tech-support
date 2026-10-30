import twilio from 'twilio';
import { supabaseAdmin } from './supabase.js';
import { PUBLIC_BASE_URL, TWILIO_OWNER_FORWARD_NUMBER, TWILIO_PHONE_NUMBER } from './twilio.js';

type BusinessHoursState = 'open' | 'closed' | 'either';
type IvrAction = 'forward' | 'voicemail' | 'submenu' | 'queue' | 'hangup' | 'ai_assistant';
type QueueStrategy = 'ring_all' | 'round_robin' | 'least_recent';

interface IvrOption {
  id: string;
  menu_id: string;
  digit: string;
  label: string;
  action: IvrAction;
  target: string | null;
  sort_order: number;
}

interface IvrMenu {
  id: string;
  name: string;
  greeting_text: string;
  greeting_audio_url: string | null;
  timeout_seconds: number;
  is_default: boolean;
  business_hours_state: BusinessHoursState;
}

interface CallQueue {
  id: string;
  name: string;
  strategy: QueueStrategy;
  max_wait_seconds: number;
  on_timeout_action: 'voicemail' | 'forward';
  on_timeout_target: string | null;
}

const VoiceResponse = twilio.twiml.VoiceResponse;

export type MenuWithOptions = IvrMenu & { options: IvrOption[] };

export async function loadDefaultMenu(state: BusinessHoursState): Promise<MenuWithOptions | null> {
  const { data: menu } = await supabaseAdmin
    .from('ivr_menus')
    .select('*')
    .eq('is_default', true)
    .eq('business_hours_state', state)
    .maybeSingle();

  if (!menu) return null;

  const { data: options } = await supabaseAdmin
    .from('ivr_options')
    .select('*')
    .eq('menu_id', menu.id)
    .order('sort_order', { ascending: true });

  return { ...menu, options: options ?? [] } as MenuWithOptions;
}

export async function loadMenu(menuId: string): Promise<MenuWithOptions | null> {
  const { data: menu } = await supabaseAdmin
    .from('ivr_menus')
    .select('*')
    .eq('id', menuId)
    .maybeSingle();

  if (!menu) return null;

  const { data: options } = await supabaseAdmin
    .from('ivr_options')
    .select('*')
    .eq('menu_id', menu.id)
    .order('sort_order', { ascending: true });

  return { ...menu, options: options ?? [] } as MenuWithOptions;
}

/**
 * Render a TwiML <Gather> for the menu.
 * If the menu has a single voicemail option (e.g. after-hours), drop straight to <Record>.
 */
export function renderMenuTwiml(menu: MenuWithOptions): string {
  const twiml = new VoiceResponse();

  const onlyVoicemail =
    menu.options.length === 1 && menu.options[0].action === 'voicemail';

  if (onlyVoicemail) {
    if (menu.greeting_audio_url) {
      twiml.play(menu.greeting_audio_url);
    } else if (menu.greeting_text) {
      twiml.say({ voice: 'Polly.Joanna', language: 'en-US' }, menu.greeting_text);
    }
    startVoicemailRecord(twiml);
    return twiml.toString();
  }

  const gather = twiml.gather({
    numDigits: 1,
    action: `${PUBLIC_BASE_URL}/webhooks/voice/menu/${menu.id}/select`,
    method: 'POST',
    timeout: menu.timeout_seconds,
  });

  if (menu.greeting_audio_url) {
    gather.play(menu.greeting_audio_url);
  } else if (menu.greeting_text) {
    gather.say({ voice: 'Polly.Joanna', language: 'en-US' }, menu.greeting_text);
  }

  // Fallback if no input: redirect into the select endpoint with no digit (handled there)
  twiml.redirect(`${PUBLIC_BASE_URL}/webhooks/voice/menu/${menu.id}/select`);
  return twiml.toString();
}

/**
 * Render TwiML for executing a chosen IVR option.
 * Returns the XML string so the webhook handler can write it to the response.
 */
export async function renderOptionTwiml(
  option: IvrOption,
  callSid: string,
): Promise<string> {
  const twiml = new VoiceResponse();

  switch (option.action) {
    case 'forward': {
      const target = resolveForwardTarget(option.target);
      if (!target) {
        twiml.say({ voice: 'Polly.Joanna' }, 'No agents are available. Please leave a message.');
        startVoicemailRecord(twiml);
        break;
      }
      twiml.say({ voice: 'Polly.Joanna' }, 'Please hold while we connect your call.');
      const dial = twiml.dial({
        action: `${PUBLIC_BASE_URL}/webhooks/voice/status`,
        method: 'POST',
        timeout: 25,
        record: 'record-from-answer-dual',
        recordingStatusCallback: `${PUBLIC_BASE_URL}/webhooks/voice/recording`,
        recordingStatusCallbackMethod: 'POST',
        callerId: TWILIO_PHONE_NUMBER,
      });
      dial.number({}, target);
      break;
    }

    case 'voicemail': {
      twiml.say(
        { voice: 'Polly.Joanna' },
        'Please leave a message after the tone. Press pound when finished.',
      );
      startVoicemailRecord(twiml);
      break;
    }

    case 'submenu': {
      if (option.target) {
        twiml.redirect(`${PUBLIC_BASE_URL}/webhooks/voice/menu/${option.target}`);
      } else {
        twiml.hangup();
      }
      break;
    }

    case 'queue': {
      if (!option.target) {
        twiml.say({ voice: 'Polly.Joanna' }, 'No queue is configured. Please leave a message.');
        startVoicemailRecord(twiml);
        break;
      }
      const queue = await loadQueueWithMembers(option.target);
      if (!queue || !queue.members || queue.members.length === 0) {
        twiml.say({ voice: 'Polly.Joanna' }, 'No agents are available. Please leave a message.');
        startVoicemailRecord(twiml);
        break;
      }

      const numbers = queue.members
        .map((m) => m.user?.phone)
        .filter((p): p is string => !!p);

      if (numbers.length === 0) {
        twiml.say({ voice: 'Polly.Joanna' }, 'No agents are available. Please leave a message.');
        startVoicemailRecord(twiml);
        break;
      }

      // Determine call list per strategy
      const dialNumbers = pickQueueOrder(numbers, queue.strategy);

      twiml.say({ voice: 'Polly.Joanna' }, 'Please hold while we connect you to the next available technician.');
      const dial = twiml.dial({
        action: `${PUBLIC_BASE_URL}/webhooks/voice/status?queue_id=${queue.id}`,
        method: 'POST',
        timeout: queue.max_wait_seconds,
        record: 'record-from-answer-dual',
        recordingStatusCallback: `${PUBLIC_BASE_URL}/webhooks/voice/recording`,
        recordingStatusCallbackMethod: 'POST',
        callerId: TWILIO_PHONE_NUMBER,
      });

      if (queue.strategy === 'ring_all') {
        for (const n of dialNumbers) dial.number({}, n);
      } else {
        // round_robin / least_recent → dial the first in the chosen order only
        dial.number({}, dialNumbers[0]);
      }
      break;
    }

    case 'ai_assistant': {
      // Bridge inbound call to a VAPI assistant. Compliance: the assistant's
      // first_message is REQUIRED to contain the AI/recording disclosure
      // (enforced at create/edit time in routes/ai-assistants.ts).
      if (!option.target) {
        twiml.say({ voice: 'Polly.Joanna' }, 'No AI assistant is configured. Please leave a message.');
        startVoicemailRecord(twiml);
        break;
      }
      const { data: assistant } = await supabaseAdmin
        .from('ai_assistants')
        .select('vapi_assistant_id, is_active')
        .eq('id', option.target)
        .maybeSingle();
      if (!assistant?.vapi_assistant_id || !assistant.is_active) {
        twiml.say(
          { voice: 'Polly.Joanna' },
          'Our automated assistant is unavailable. Please leave a message.',
        );
        startVoicemailRecord(twiml);
        break;
      }
      // Mark the call as routed to AI for the call log
      await supabaseAdmin
        .from('calls')
        .update({ ivr_selection: `ai_assistant:${option.target}` })
        .eq('twilio_call_sid', callSid);
      // Bridge to VAPI via SIP. VAPI provisions a SIP URI per assistant of the
      // form sip:<assistant_id>@sip.vapi.ai. We use <Dial><Sip> rather than the
      // <Stream> WebSocket path so existing Twilio call recording continues to
      // work and the call still hits /voice/status normally.
      twiml.say({ voice: 'Polly.Joanna' }, 'Connecting you to our automated assistant.');
      const dial = twiml.dial({
        action: `${PUBLIC_BASE_URL}/webhooks/voice/status`,
        method: 'POST',
        timeout: 30,
        record: 'record-from-answer-dual',
        recordingStatusCallback: `${PUBLIC_BASE_URL}/webhooks/voice/recording`,
        recordingStatusCallbackMethod: 'POST',
        callerId: TWILIO_PHONE_NUMBER,
      });
      dial.sip(`sip:${assistant.vapi_assistant_id}@sip.vapi.ai`);
      break;
    }

    case 'hangup':
    default: {
      twiml.say({ voice: 'Polly.Joanna' }, 'Goodbye.');
      twiml.hangup();
      break;
    }
  }

  return twiml.toString();
}

function startVoicemailRecord(twiml: InstanceType<typeof VoiceResponse>) {
  twiml.record({
    maxLength: 180,
    playBeep: true,
    finishOnKey: '#',
    transcribe: true,
    transcribeCallback: `${PUBLIC_BASE_URL}/webhooks/voice/transcription`,
    recordingStatusCallback: `${PUBLIC_BASE_URL}/webhooks/voice/voicemail-recording`,
    recordingStatusCallbackMethod: 'POST',
    action: `${PUBLIC_BASE_URL}/webhooks/voice/voicemail-finish`,
    method: 'POST',
  });
  twiml.hangup();
}

function resolveForwardTarget(target: string | null): string | null {
  if (!target) return TWILIO_OWNER_FORWARD_NUMBER || null;
  if (target === 'OWNER_FORWARD') return TWILIO_OWNER_FORWARD_NUMBER || null;
  return target;
}

interface QueueMemberWithUser {
  queue_id: string;
  user_id: string;
  priority: number;
  user?: { id: string; phone: string | null; full_name: string };
}

type QueueWithMembers = CallQueue & { members: QueueMemberWithUser[] };

async function loadQueueWithMembers(queueId: string): Promise<QueueWithMembers | null> {
  const { data: queue } = await supabaseAdmin
    .from('call_queues')
    .select('*')
    .eq('id', queueId)
    .maybeSingle();
  if (!queue) return null;

  const { data: members } = await supabaseAdmin
    .from('queue_members')
    .select('queue_id, user_id, priority, user:users!user_id(id, phone, full_name)')
    .eq('queue_id', queueId)
    .order('priority', { ascending: false });

  return {
    ...(queue as CallQueue),
    members: (members ?? []) as unknown as QueueMemberWithUser[],
  };
}

// In-memory rotation pointer for round_robin (resets on server restart — good enough for Phase 2)
const rrPointers: Record<string, number> = {};

function pickQueueOrder(numbers: string[], strategy: string): string[] {
  if (strategy === 'ring_all') return numbers;
  const key = numbers.join('|');
  if (strategy === 'round_robin') {
    const idx = (rrPointers[key] ?? -1) + 1;
    rrPointers[key] = idx % numbers.length;
    const start = rrPointers[key];
    return [...numbers.slice(start), ...numbers.slice(0, start)];
  }
  // least_recent: same as round_robin in Phase 2 (would need DB tracking for true LR)
  return numbers;
}
