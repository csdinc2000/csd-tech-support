import { Router } from 'express';
import twilio from 'twilio';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireTwilioSignature } from '../middleware/twilioSignature.js';
import { broadcastSse } from '../lib/sse.js';
import { threadKeyFor, getBlacklistEntry } from '../lib/sms.js';

const router = Router();
const MessagingResponse = twilio.twiml.MessagingResponse;

// ── POST /webhooks/sms/incoming ──────────────────────────────────────────────
router.post('/sms/incoming', requireTwilioSignature, async (req, res) => {
  const messageSid: string = req.body.MessageSid;
  const from: string = req.body.From;
  const to: string = req.body.To;
  const body: string = req.body.Body ?? '';
  const numMedia = parseInt(req.body.NumMedia || '0', 10);

  const mediaUrls: string[] = [];
  for (let i = 0; i < numMedia; i++) {
    const url = req.body[`MediaUrl${i}`];
    if (url) mediaUrls.push(url);
  }

  // Blacklist check — if blocks_sms, store as 'received' but don't broadcast
  const black = await getBlacklistEntry(from);
  const blocked = !!(black && black.blocks_sms);

  const threadKey = threadKeyFor('inbound', from, to);

  const { data: inserted } = await supabaseAdmin
    .from('messages')
    .upsert(
      {
        twilio_message_sid: messageSid,
        direction: 'inbound',
        from_number: from,
        to_number: to,
        body,
        status: 'received',
        media_urls: mediaUrls.length ? mediaUrls : null,
        thread_key: threadKey,
      },
      { onConflict: 'twilio_message_sid' },
    )
    .select()
    .single();

  if (!blocked && inserted) {
    broadcastSse('message:new', inserted);
  }

  // Always respond with empty TwiML — no auto-reply.
  const twiml = new MessagingResponse();
  res.type('text/xml').send(twiml.toString());
});

// ── POST /webhooks/sms/status ────────────────────────────────────────────────
// Twilio status callbacks are for outbound messages only. They can arrive
// before our own /api/messages insert finishes, so we upsert on the SID.
router.post('/sms/status', requireTwilioSignature, async (req, res) => {
  const messageSid: string = req.body.MessageSid;
  const status: string = req.body.MessageStatus;
  const errorCode: string | undefined = req.body.ErrorCode;
  const from: string | undefined = req.body.From;
  const to: string | undefined = req.body.To;

  res.sendStatus(204);

  if (!messageSid) return;

  const allowed = ['queued', 'sent', 'delivered', 'undelivered', 'failed'];
  const newStatus = allowed.includes(status) ? status : 'queued';

  // Try update first (common case)
  const { data: existing } = await supabaseAdmin
    .from('messages')
    .select('id')
    .eq('twilio_message_sid', messageSid)
    .maybeSingle();

  let row;
  if (existing) {
    const { data } = await supabaseAdmin
      .from('messages')
      .update({ status: newStatus, error_code: errorCode ?? null })
      .eq('twilio_message_sid', messageSid)
      .select()
      .single();
    row = data;
  } else if (from && to) {
    // Race case: status arrived before /api/messages insert. Stash a
    // placeholder so the status isn't lost. Body is filled by the API
    // insert when it arrives (it inserts via plain INSERT and would conflict
    // — so we mark this row distinguishable by an empty body).
    const { data } = await supabaseAdmin
      .from('messages')
      .upsert(
        {
          twilio_message_sid: messageSid,
          direction: 'outbound',
          from_number: from,
          to_number: to,
          body: '',
          status: newStatus,
          error_code: errorCode ?? null,
          thread_key: to,
        },
        { onConflict: 'twilio_message_sid' },
      )
      .select()
      .single();
    row = data;
  }

  if (row) {
    broadcastSse('message:status', { id: row.id, status: newStatus, error_code: errorCode ?? null });
  }
});

export { router as smsWebhookRouter };
