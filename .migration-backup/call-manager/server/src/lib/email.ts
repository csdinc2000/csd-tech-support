import axios from 'axios';
import { supabaseAdmin } from './supabase.js';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'CSD Call Manager <noreply@example.com>';

let warned = false;
function warnOnce() {
  if (!warned) {
    warned = true;
    console.warn(
      '[email] RESEND_API_KEY is not set — emails are recorded to notifications_log ' +
        'with status="suppressed" but not actually delivered.',
    );
  }
}

/**
 * Render very-light Mustache-ish placeholders:
 *   {{key}}                — replace with String(context[key]) or ''
 *   {{#key}}...{{/key}}    — section, included only if context[key] is truthy
 *
 * Intentionally minimal — no nested sections, no inverted sections.
 */
export function renderEmailTemplate(text: string, ctx: Record<string, unknown>): string {
  // Sections first
  const sectioned = text.replace(
    /\{\{#([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_m, key: string, inner: string) => {
      const v = ctx[key];
      return v ? inner : '';
    },
  );
  // Then plain placeholders
  return sectioned.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = ctx[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface SendResult {
  ok: boolean;
  providerId?: string;
  error?: string;
  suppressed?: boolean;
}

/**
 * Send a transactional email via Resend. Gracefully no-ops if RESEND_API_KEY
 * isn't configured — caller should still log the attempt.
 */
export async function sendEmail(p: SendEmailParams): Promise<SendResult> {
  if (!RESEND_API_KEY) {
    warnOnce();
    return { ok: false, suppressed: true, error: 'RESEND_API_KEY not configured' };
  }
  try {
    const r = await axios.post(
      'https://api.resend.com/emails',
      {
        from: EMAIL_FROM,
        to: [p.to],
        subject: p.subject,
        html: p.html,
        text: p.text,
        ...(p.replyTo ? { reply_to: p.replyTo } : {}),
      },
      {
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      },
    );
    return { ok: true, providerId: r.data?.id };
  } catch (err: unknown) {
    const msg =
      (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
      (err instanceof Error ? err.message : 'Resend send failed');
    return { ok: false, error: msg };
  }
}

/**
 * Look up a per-org template by trigger, falling back to a default (org_id IS NULL,
 * or the first one ordered by created_at).
 */
export async function loadTemplateByTrigger(
  trigger: string,
  orgId?: string | null,
): Promise<{ id: string; subject: string; body_html: string; body_text: string } | null> {
  let q = supabaseAdmin
    .from('email_templates')
    .select('id, subject, body_html, body_text, org_id, created_at')
    .eq('trigger', trigger)
    .order('created_at', { ascending: true });
  if (orgId) q = q.or(`org_id.eq.${orgId},org_id.is.null`);
  const { data } = await q.limit(5);
  if (!data || data.length === 0) return null;
  // Prefer org-scoped over global default
  const orgScoped = data.find((t) => t.org_id === orgId);
  return orgScoped ?? data[0];
}

export function isEmailConfigured(): boolean {
  return !!RESEND_API_KEY;
}
