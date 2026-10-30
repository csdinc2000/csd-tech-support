import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  throw new Error('Missing required Twilio environment variables');
}

export const twilioClient = twilio(accountSid, authToken);

export const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || '';
export const TWILIO_OWNER_FORWARD_NUMBER = process.env.TWILIO_OWNER_FORWARD_NUMBER || '';
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

export function validateTwilioSignature(
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  return twilio.validateRequest(authToken!, signature, url, params);
}
