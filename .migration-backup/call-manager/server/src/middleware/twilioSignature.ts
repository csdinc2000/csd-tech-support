import type { Request, Response, NextFunction } from 'express';
import { validateTwilioSignature, PUBLIC_BASE_URL } from '../lib/twilio.js';

export function requireTwilioSignature(req: Request, res: Response, next: NextFunction) {
  const signature = req.headers['x-twilio-signature'] as string | undefined;

  if (!signature) {
    res.status(403).send('Forbidden: missing Twilio signature');
    return;
  }

  // Reconstruct the full URL Twilio signed
  const url = `${PUBLIC_BASE_URL}${req.originalUrl}`;
  const params = req.body as Record<string, string>;

  const valid = validateTwilioSignature(signature, url, params);

  if (!valid) {
    console.warn(`[Twilio] Invalid signature for ${url}`);
    res.status(403).send('Forbidden: invalid Twilio signature');
    return;
  }

  next();
}
