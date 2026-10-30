import { Router } from 'express';
import twilio from 'twilio';
import axios from 'axios';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireTwilioSignature } from '../middleware/twilioSignature.js';
import { PUBLIC_BASE_URL, TWILIO_PHONE_NUMBER, TWILIO_OWNER_FORWARD_NUMBER } from '../lib/twilio.js';
import { getCurrentBusinessHoursState } from '../lib/businessHours.js';
import { loadDefaultMenu, loadMenu, renderMenuTwiml, renderOptionTwiml } from '../lib/ivr.js';
import { getBlacklistEntry, getSetting } from '../lib/sms.js';
import { getCachedSpamScore } from '../lib/spam.js';
import { dispatchNotification } from '../lib/notifications.js';

// ── Helper: who should be notified about a given call ───────────────────────
async function notifyRecipientsForCall(callId: string): Promise<string[]> {
  const ids = new Set<string>();
  const { data: call } = await supabaseAdmin
    .from('calls')
    .select('assigned_to_user_id')
    .eq('id', callId)
    .maybeSingle();
  if (call?.assigned_to_user_id) ids.add(call.assigned_to_user_id);
  const { data: owners } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('role', 'owner')
    .eq('is_active', true);
  for (const o of owners ?? []) ids.add(o.id);
  return Array.from(ids);
}

const router = Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

// ── POST /webhooks/voice/incoming ────────────────────────────────────────────
// Florida 2-party consent: disclosure plays before recording starts.
// Phase 2: Routes to the open or closed default IVR menu based on business hours / holidays.
router.post('/voice/incoming', requireTwilioSignature, async (req, res) => {
  const callSid: string = req.body.CallSid;
  const from: string = req.body.From;
  const to: string = req.body.To;
  const screened = req.query.screened === '1';

  // Insert initial call record (idempotent on twilio_call_sid unique index)
  await supabaseAdmin
    .from('calls')
    .upsert(
      {
        twilio_call_sid: callSid,
        direction: 'inbound',
        from_number: from,
        to_number: to,
        status: 'ringing',
        started_at: new Date().toISOString(),
      },
      { onConflict: 'twilio_call_sid' },
    );

  const callId = await getCallIdBySid(callSid);
  if (callId) {
    await supabaseAdmin.from('call_events').insert({
      call_id: callId,
      event_type: 'webhook_received',
      payload: req.body,
    });
  }

  // ── Phase 3: blacklist hard-block (skip when caller has already passed screen)
  if (!screened) {
    const black = await getBlacklistEntry(from);
    if (black?.blocks_calls) {
      const blockTwiml = new VoiceResponse();
      blockTwiml.hangup();
      await supabaseAdmin
        .from('calls')
        .update({ status: 'failed', ended_at: new Date().toISOString(), notes: `Blocked: ${black.reason ?? 'blacklisted'}` })
        .eq('twilio_call_sid', callSid);
      if (callId) {
        await supabaseAdmin.from('call_events').insert({
          call_id: callId,
          event_type: 'call_blocked',
          payload: { reason: black.reason, source: 'blacklist' },
        });
      }
      res.type('text/xml').send(blockTwiml.toString());
      return;
    }

    // ── Phase 3: spam screening (cached score only — no live Lookup on the hot path)
    const screeningEnabled = await getSetting<boolean>('spam_screening_enabled', false);
    if (screeningEnabled) {
      const threshold = await getSetting<number>('spam_threshold', 70);
      const score = await getCachedSpamScore(from);
      if (score !== null && score >= threshold) {
        const screen = new VoiceResponse();
        const gather = screen.gather({
          numDigits: 1,
          timeout: 8,
          action: `${PUBLIC_BASE_URL}/webhooks/voice/screen?callSid=${encodeURIComponent(callSid)}`,
          method: 'POST',
        });
        gather.say(
          { voice: 'Polly.Joanna', language: 'en-US' },
          'This number has been flagged as potential spam. ' +
            'To confirm you are a human caller, please press any digit.',
        );
        // No input → hang up
        screen.hangup();
        if (callId) {
          await supabaseAdmin.from('call_events').insert({
            call_id: callId,
            event_type: 'spam_screen_prompt',
            payload: { score, threshold },
          });
        }
        res.type('text/xml').send(screen.toString());
        return;
      }
    }
  }

  const twiml = new VoiceResponse();

  // Florida two-party consent disclosure
  twiml.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    'Thank you for calling Computer Systems Depot. ' +
      'This call may be recorded for quality and training purposes.',
  );

  // Determine business state and route to the matching default menu
  const state = await getCurrentBusinessHoursState();
  const menu = await loadDefaultMenu(state);

  if (!menu) {
    // No configured menu — emergency fallback to owner forward, then voicemail
    twiml.say({ voice: 'Polly.Joanna' }, 'Please hold while we connect your call.');
    if (TWILIO_OWNER_FORWARD_NUMBER) {
      const dial = twiml.dial({
        action: `${PUBLIC_BASE_URL}/webhooks/voice/status`,
        method: 'POST',
        timeout: 25,
        record: 'record-from-answer-dual',
        recordingStatusCallback: `${PUBLIC_BASE_URL}/webhooks/voice/recording`,
        recordingStatusCallbackMethod: 'POST',
        callerId: TWILIO_PHONE_NUMBER,
      });
      dial.number({}, TWILIO_OWNER_FORWARD_NUMBER);
    } else {
      twiml.say({ voice: 'Polly.Joanna' }, 'No agents are available. Please leave a message.');
      twiml.record({
        maxLength: 180,
        action: `${PUBLIC_BASE_URL}/webhooks/voice/voicemail-finish`,
        recordingStatusCallback: `${PUBLIC_BASE_URL}/webhooks/voice/voicemail-recording`,
        transcribe: true,
        transcribeCallback: `${PUBLIC_BASE_URL}/webhooks/voice/transcription`,
      });
      twiml.hangup();
    }
    res.type('text/xml').send(twiml.toString());
    return;
  }

  // Track which menu was chosen as the entry point
  await supabaseAdmin
    .from('calls')
    .update({ ivr_selection: `entry:${state}:${menu.name}` })
    .eq('twilio_call_sid', callSid);

  twiml.redirect(`${PUBLIC_BASE_URL}/webhooks/voice/menu/${menu.id}`);
  res.type('text/xml').send(twiml.toString());
});

// ── POST /webhooks/voice/screen ──────────────────────────────────────────────
// Spam-screen pass-through. Any digit lets the caller continue into the normal
// inbound flow (with ?screened=1 so we don't loop). Timeout already hung up.
router.post('/voice/screen', requireTwilioSignature, async (req, res) => {
  const digit: string | undefined = req.body.Digits;
  const twiml = new VoiceResponse();
  if (!digit) {
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
    return;
  }
  twiml.redirect(`${PUBLIC_BASE_URL}/webhooks/voice/incoming?screened=1`);
  res.type('text/xml').send(twiml.toString());
});

// ── POST /webhooks/voice/menu/:menuId ────────────────────────────────────────
// Renders a menu's <Gather> (or drops to voicemail if the menu has one option).
router.post('/voice/menu/:menuId', requireTwilioSignature, async (req, res) => {
  const menuId = req.params.menuId as string;
  const menu = await loadMenu(menuId);
  if (!menu) {
    const twiml = new VoiceResponse();
    twiml.say({ voice: 'Polly.Joanna' }, 'Menu not found. Goodbye.');
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
    return;
  }
  res.type('text/xml').send(renderMenuTwiml(menu));
});

// ── POST /webhooks/voice/menu/:menuId/select ─────────────────────────────────
// Handles digit entry for a menu and executes the selected option's action.
router.post('/voice/menu/:menuId/select', requireTwilioSignature, async (req, res) => {
  const menuId = req.params.menuId as string;
  const callSid: string = req.body.CallSid;
  const digit: string | undefined = req.body.Digits;

  const menu = await loadMenu(menuId);
  if (!menu) {
    const twiml = new VoiceResponse();
    twiml.say({ voice: 'Polly.Joanna' }, 'Menu not found. Goodbye.');
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
    return;
  }

  // No digit (timeout) — for an after-hours single-voicemail menu, drop to voicemail.
  // For other menus, repeat the menu once then drop to voicemail.
  if (!digit) {
    const onlyVoicemail =
      menu.options.length === 1 && menu.options[0].action === 'voicemail';
    if (onlyVoicemail) {
      res
        .type('text/xml')
        .send(await renderOptionTwiml(menu.options[0], callSid));
      return;
    }
    const twiml = new VoiceResponse();
    twiml.say({ voice: 'Polly.Joanna' }, "We didn't receive your selection. Please leave a message.");
    twiml.record({
      maxLength: 180,
      action: `${PUBLIC_BASE_URL}/webhooks/voice/voicemail-finish`,
      recordingStatusCallback: `${PUBLIC_BASE_URL}/webhooks/voice/voicemail-recording`,
      transcribe: true,
      transcribeCallback: `${PUBLIC_BASE_URL}/webhooks/voice/transcription`,
    });
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
    return;
  }

  const option = menu.options.find((o) => o.digit === digit);

  if (!option) {
    // Invalid digit — replay the menu
    const twiml = new VoiceResponse();
    twiml.say({ voice: 'Polly.Joanna' }, 'Invalid selection. Please try again.');
    twiml.redirect(`${PUBLIC_BASE_URL}/webhooks/voice/menu/${menu.id}`);
    res.type('text/xml').send(twiml.toString());
    return;
  }

  // Persist the selection
  await supabaseAdmin
    .from('calls')
    .update({ ivr_selection: `${menu.name}:${option.label}` })
    .eq('twilio_call_sid', callSid);

  res.type('text/xml').send(await renderOptionTwiml(option, callSid));
});

// ── POST /webhooks/voice/gather (legacy, still used by outbound calls) ───────
// Outbound calls created via /api/calls/outbound point at this URL. We keep the
// handler so nothing breaks. For inbound calls, the new /menu/:id flow is used.
router.post('/voice/gather', requireTwilioSignature, async (req, res) => {
  const digit: string | undefined = req.body.Digits;
  const callSid: string = req.body.CallSid;

  const twiml = new VoiceResponse();

  if (!digit) {
    // Outbound call: just dial the owner forward (Phase 1 fallback behavior)
    if (TWILIO_OWNER_FORWARD_NUMBER) {
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
      dial.number({}, TWILIO_OWNER_FORWARD_NUMBER);
    } else {
      twiml.hangup();
    }
    res.type('text/xml').send(twiml.toString());
    return;
  }

  // If a digit was provided to legacy /voice/gather, route via the open default menu
  await supabaseAdmin
    .from('calls')
    .update({ ivr_selection: `legacy:digit:${digit}` })
    .eq('twilio_call_sid', callSid);

  const menu = await loadDefaultMenu('open');
  const option = menu?.options.find((o) => o.digit === digit);
  if (option) {
    res.type('text/xml').send(await renderOptionTwiml(option, callSid));
    return;
  }

  twiml.say({ voice: 'Polly.Joanna' }, 'Please hold while we connect your call.');
  if (TWILIO_OWNER_FORWARD_NUMBER) {
    const dial = twiml.dial({
      action: `${PUBLIC_BASE_URL}/webhooks/voice/status`,
      method: 'POST',
      timeout: 25,
      record: 'record-from-answer-dual',
      recordingStatusCallback: `${PUBLIC_BASE_URL}/webhooks/voice/recording`,
      recordingStatusCallbackMethod: 'POST',
      callerId: TWILIO_PHONE_NUMBER,
    });
    dial.number({}, TWILIO_OWNER_FORWARD_NUMBER);
  }
  res.type('text/xml').send(twiml.toString());
});

// ── POST /webhooks/voice/status ──────────────────────────────────────────────
router.post('/voice/status', requireTwilioSignature, async (req, res) => {
  const callSid: string = req.body.CallSid;
  const callStatus: string = req.body.CallStatus || req.body.DialCallStatus;
  const dialCallStatus: string | undefined = req.body.DialCallStatus;
  const dialCallSid: string | undefined = req.body.DialCallSid;
  const duration: string | undefined = req.body.CallDuration;
  const queueId = (req.query.queue_id as string | undefined) ?? undefined;

  const updateData: Record<string, unknown> = {
    status: normalizeStatus(callStatus),
  };
  if (duration) updateData.duration_seconds = parseInt(duration, 10);
  if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(callStatus)) {
    updateData.ended_at = new Date().toISOString();
  }

  await supabaseAdmin.from('calls').update(updateData).eq('twilio_call_sid', callSid);

  // If <Dial> answered and we know the dialed leg, attempt to resolve the answering user
  if (dialCallStatus === 'completed' && dialCallSid) {
    const dialedNumber = req.body.Called as string | undefined;
    if (dialedNumber) {
      const { data: user } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('phone', dialedNumber)
        .maybeSingle();
      if (user) {
        await supabaseAdmin
          .from('calls')
          .update({ assigned_to_user_id: user.id })
          .eq('twilio_call_sid', callSid);
      }
    }
  }

  const callId = await getCallIdBySid(callSid);
  if (callId) {
    await supabaseAdmin.from('call_events').insert({
      call_id: callId,
      event_type: 'status_updated',
      payload: req.body,
    });
  }

  const twiml = new VoiceResponse();

  // No-answer / failed dial → run the queue's timeout action (or generic voicemail)
  if (dialCallStatus === 'no-answer' || dialCallStatus === 'busy' || dialCallStatus === 'failed') {
    if (queueId) {
      const { data: queue } = await supabaseAdmin
        .from('call_queues')
        .select('*')
        .eq('id', queueId)
        .maybeSingle();

      if (queue?.on_timeout_action === 'forward' && queue.on_timeout_target) {
        twiml.say({ voice: 'Polly.Joanna' }, 'Please hold, transferring your call.');
        const dial = twiml.dial({
          action: `${PUBLIC_BASE_URL}/webhooks/voice/status`,
          method: 'POST',
          timeout: 25,
          record: 'record-from-answer-dual',
          recordingStatusCallback: `${PUBLIC_BASE_URL}/webhooks/voice/recording`,
          callerId: TWILIO_PHONE_NUMBER,
        });
        dial.number({}, queue.on_timeout_target);
        res.type('text/xml').send(twiml.toString());
        return;
      }
    }
    twiml.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      "We're sorry, no one is available right now. " +
        'Please leave a message with your name and phone number and we will call you back shortly.',
    );
    twiml.record({
      maxLength: 180,
      action: `${PUBLIC_BASE_URL}/webhooks/voice/voicemail-finish`,
      recordingStatusCallback: `${PUBLIC_BASE_URL}/webhooks/voice/voicemail-recording`,
      recordingStatusCallbackMethod: 'POST',
      transcribe: true,
      transcribeCallback: `${PUBLIC_BASE_URL}/webhooks/voice/transcription`,
    });
    twiml.hangup();

    // Fire-and-forget missed-call notification dispatch
    (async () => {
      try {
        const callId = await getCallIdBySid(callSid);
        if (!callId) return;
        const { data: call } = await supabaseAdmin
          .from('calls').select('id, from_number, started_at, customer_name')
          .eq('id', callId).maybeSingle();
        if (!call) return;
        const recipients = await notifyRecipientsForCall(callId);
        await dispatchNotification({
          trigger: 'missed_call',
          recipientUserIds: recipients,
          context: {
            from_number: call.from_number,
            customer_name: call.customer_name,
            call_time: new Date(call.started_at).toLocaleString(),
            call_url: `${PUBLIC_BASE_URL}/calls/${call.id}`,
          },
        });
      } catch (e) {
        console.error('[Notify] missed_call dispatch error:', e);
      }
    })();
  }

  res.type('text/xml').send(twiml.toString());
});

// ── POST /webhooks/voice/recording ───────────────────────────────────────────
// Twilio fires this for ALL recordings (calls + voicemails). We upload to Storage
// and update calls.recording_url. Voicemail-specific row creation is handled by
// /voice/voicemail-recording below.
router.post('/voice/recording', requireTwilioSignature, async (req, res) => {
  const callSid: string = req.body.CallSid;
  const recordingSid: string = req.body.RecordingSid;
  const recordingUrl: string = req.body.RecordingUrl;
  const recordingStatus: string = req.body.RecordingStatus;

  res.sendStatus(204);
  if (recordingStatus !== 'completed') return;

  const storagePath = await downloadAndUploadRecording(callSid, recordingSid, recordingUrl);
  if (!storagePath) return;

  await supabaseAdmin
    .from('calls')
    .update({ recording_url: storagePath, recording_sid: recordingSid })
    .eq('twilio_call_sid', callSid);

  const callId = await getCallIdBySid(callSid);
  if (callId) {
    await supabaseAdmin.from('call_events').insert({
      call_id: callId,
      event_type: 'recording_uploaded',
      payload: { recording_sid: recordingSid, storage_path: storagePath },
    });
  }
});

// ── POST /webhooks/voice/voicemail-recording ─────────────────────────────────
// Specific recordingStatusCallback for voicemail <Record>. Creates a voicemails row.
router.post('/voice/voicemail-recording', requireTwilioSignature, async (req, res) => {
  const callSid: string = req.body.CallSid;
  const recordingSid: string = req.body.RecordingSid;
  const recordingUrl: string = req.body.RecordingUrl;
  const recordingStatus: string = req.body.RecordingStatus;
  const durationStr: string | undefined = req.body.RecordingDuration;

  res.sendStatus(204);
  if (recordingStatus !== 'completed') return;

  const storagePath = await downloadAndUploadRecording(callSid, recordingSid, recordingUrl, 'voicemails');
  if (!storagePath) return;

  const callId = await getCallIdBySid(callSid);
  if (!callId) {
    console.warn('[Voicemail] No call found for sid', callSid);
    return;
  }

  // Idempotent insert keyed on recording_sid
  await supabaseAdmin
    .from('voicemails')
    .upsert(
      {
        call_id: callId,
        recording_sid: recordingSid,
        recording_url: storagePath,
        duration_seconds: durationStr ? parseInt(durationStr, 10) : 0,
      },
      { onConflict: 'recording_sid' },
    );

  await supabaseAdmin.from('call_events').insert({
    call_id: callId,
    event_type: 'voicemail_received',
    payload: { recording_sid: recordingSid, storage_path: storagePath },
  });

  // Fire-and-forget voicemail notification dispatch
  (async () => {
    try {
      const { data: call } = await supabaseAdmin
        .from('calls').select('id, from_number, started_at, customer_name')
        .eq('id', callId).maybeSingle();
      if (!call) return;
      const recipients = await notifyRecipientsForCall(callId);
      await dispatchNotification({
        trigger: 'voicemail_received',
        recipientUserIds: recipients,
        context: {
          from_number: call.from_number,
          customer_name: call.customer_name,
          call_time: new Date(call.started_at).toLocaleString(),
          duration: durationStr ? parseInt(durationStr, 10) : 0,
          voicemail_url: `${PUBLIC_BASE_URL}/voicemails`,
        },
      });
    } catch (e) {
      console.error('[Notify] voicemail dispatch error:', e);
    }
  })();
});

// ── POST /webhooks/voice/voicemail-finish ────────────────────────────────────
// <Record action=...> hits this when the caller hangs up or presses #. We just say goodbye.
router.post('/voice/voicemail-finish', requireTwilioSignature, async (_req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' }, 'Thank you for your message. Goodbye.');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// ── POST /webhooks/voice/transcription ───────────────────────────────────────
// Twilio sends transcription text after a recording is processed. Twilio does
// not guarantee ordering vs. the recording-status callback, so this handler
// creates a placeholder voicemail row if the recording callback hasn't run yet.
// The recording callback's upsert (keyed on recording_sid) then fills in the
// recording_url and duration without touching the transcription field.
router.post('/voice/transcription', requireTwilioSignature, async (req, res) => {
  res.sendStatus(204);

  const recordingSid: string | undefined = req.body.RecordingSid;
  const callSid: string | undefined = req.body.CallSid;
  const text: string | undefined = req.body.TranscriptionText;
  const status: string | undefined = req.body.TranscriptionStatus;

  if (!recordingSid || status !== 'completed' || !text) return;

  // Try update first (common case: recording row already exists)
  const { data: existing } = await supabaseAdmin
    .from('voicemails')
    .select('id')
    .eq('recording_sid', recordingSid)
    .maybeSingle();

  if (existing) {
    await supabaseAdmin
      .from('voicemails')
      .update({ transcription: text })
      .eq('recording_sid', recordingSid);
    return;
  }

  // Race case: transcription arrived before the recording callback. Create a
  // placeholder so the data isn't lost — the recording callback will fill in
  // recording_url and duration_seconds via its own upsert.
  if (!callSid) {
    console.warn('[Transcription] No row and no CallSid for recording', recordingSid);
    return;
  }
  const callId = await getCallIdBySid(callSid);
  if (!callId) {
    console.warn('[Transcription] No call row for sid', callSid);
    return;
  }

  await supabaseAdmin
    .from('voicemails')
    .upsert(
      {
        call_id: callId,
        recording_sid: recordingSid,
        recording_url: 'pending',
        duration_seconds: 0,
        transcription: text,
      },
      { onConflict: 'recording_sid' },
    );
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function downloadAndUploadRecording(
  callSid: string,
  recordingSid: string,
  recordingUrl: string,
  prefix: 'recordings' | 'voicemails' = 'recordings',
): Promise<string | null> {
  try {
    const mp3Url = `${recordingUrl}.mp3`;
    const accountSid = process.env.TWILIO_ACCOUNT_SID!;
    const authToken = process.env.TWILIO_AUTH_TOKEN!;
    const response = await axios.get(mp3Url, {
      responseType: 'arraybuffer',
      auth: { username: accountSid, password: authToken },
      timeout: 60_000,
    });
    const buffer = Buffer.from(response.data as ArrayBuffer);
    const storagePath = `${prefix}/${callSid}/${recordingSid}.mp3`;
    const { error } = await supabaseAdmin.storage
      .from('call-recordings')
      .upload(storagePath, buffer, { contentType: 'audio/mpeg', upsert: true });
    if (error) {
      console.error(`[${prefix}] upload error:`, error);
      return null;
    }
    return storagePath;
  } catch (err) {
    console.error(`[${prefix}] download/upload failed:`, err);
    return null;
  }
}

async function getCallIdBySid(callSid: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('calls')
    .select('id')
    .eq('twilio_call_sid', callSid)
    .maybeSingle();
  return data?.id ?? null;
}

function normalizeStatus(s: string): string {
  const map: Record<string, string> = {
    'in-progress': 'in-progress',
    in_progress: 'in-progress',
    completed: 'completed',
    busy: 'busy',
    'no-answer': 'no-answer',
    failed: 'failed',
    canceled: 'canceled',
    ringing: 'ringing',
    queued: 'queued',
  };
  return map[s.toLowerCase()] ?? s;
}

export { router as webhookRouter };
