import type { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase.js';

export interface AuthRequest extends Request {
  userId?: string;
  userRole?: string;
  accessToken?: string;
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  return authenticate(req, res, next, /* allowQueryToken */ false);
}

/**
 * SSE-only auth: EventSource can't set custom headers, so we accept the
 * Supabase access token in `?access_token=`. This is intentionally NOT enabled
 * on regular API endpoints because query strings get logged in proxy access
 * logs / browser history / Referer headers.
 */
export async function requireAuthSse(req: AuthRequest, res: Response, next: NextFunction) {
  return authenticate(req, res, next, /* allowQueryToken */ true);
}

async function authenticate(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
  allowQueryToken: boolean,
) {
  const authHeader = req.headers.authorization;
  let token: string | undefined;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (allowQueryToken && typeof req.query.access_token === 'string') {
    token = req.query.access_token;
  }
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // Fetch role from users table
  const { data: profile } = await supabaseAdmin
    .from('users')
    .select('role')
    .eq('id', data.user.id)
    .single();

  req.userId = data.user.id;
  req.userRole = profile?.role ?? 'viewer';
  req.accessToken = token;

  next();
}

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.userRole || !roles.includes(req.userRole)) {
      res.status(403).json({ error: 'Forbidden: insufficient role' });
      return;
    }
    next();
  };
}
