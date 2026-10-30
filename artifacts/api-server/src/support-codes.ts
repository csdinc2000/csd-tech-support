/**
 * Support Codes — short-lived 6-digit codes that bridge a phone call to a live
 * MeshCentral session.
 *
 * MeshCentral has no native "join by short code" flow (it uses agent installers
 * and per-device URLs). This module is the thin mapping that makes the
 * customer-facing widget work: a technician generates a code for a specific
 * device, reads it to the customer over the phone, and the customer types it
 * into the Remote Support widget (served at /remote-support; source in
 * server/remote-support-widget.ts), which redeems it for the MeshCentral
 * redirect URL on remote.computersystemsdepot.com.
 *
 * Codes are deliberately kept in memory: they live for minutes, are single-use,
 * and there is no value in persisting them across a restart (a dropped code is
 * simply regenerated on the next call). This avoids a schema change while
 * keeping the brute-force surface tiny.
 */

import { randomInt } from "crypto";

export interface SupportCodeRecord {
  code: string;
  redirectUrl: string;
  deviceId?: number | null;
  meshNodeId?: string | null;
  sessionType: string;
  createdAt: number;
  expiresAt: number;
}

/** Codes expire 10 minutes after they are generated. */
const CODE_TTL_MS = 10 * 60 * 1000;

/** Per-IP redeem throttle: at most MAX_ATTEMPTS failures per window. */
const ATTEMPT_WINDOW_MS = 60 * 1000;
const MAX_ATTEMPTS = 10;

const codes = new Map<string, SupportCodeRecord>();
const attempts = new Map<string, { count: number; windowStart: number }>();

/** Drop any expired codes so the map can't grow unbounded. */
function sweep(now: number): void {
  codes.forEach((rec, code) => {
    if (rec.expiresAt <= now) codes.delete(code);
  });
}

/** Generate a unique, currently-live 6-digit code. */
function nextCode(now: number): string {
  // 1M space; sweep first so we don't collide with a stale (expired) entry.
  sweep(now);
  for (let i = 0; i < 20; i++) {
    const candidate = String(randomInt(0, 1_000_000)).padStart(6, "0");
    if (!codes.has(candidate)) return candidate;
  }
  // Astronomically unlikely with a near-empty live set; fail loudly rather than
  // hand back a duplicate.
  throw new Error("Could not allocate a unique support code");
}

/**
 * Create a code bound to an already-built MeshCentral redirect URL. The caller
 * resolves the device + session URL (reusing the normal session logic) so this
 * module stays free of MeshCentral specifics.
 */
export function createSupportCode(params: {
  redirectUrl: string;
  deviceId?: number | null;
  meshNodeId?: string | null;
  sessionType?: string;
}): SupportCodeRecord {
  const now = Date.now();
  const code = nextCode(now);
  const record: SupportCodeRecord = {
    code,
    redirectUrl: params.redirectUrl,
    deviceId: params.deviceId ?? null,
    meshNodeId: params.meshNodeId ?? null,
    sessionType: params.sessionType ?? "desktop",
    createdAt: now,
    expiresAt: now + CODE_TTL_MS,
  };
  codes.set(code, record);
  return record;
}

export type RedeemResult =
  | { ok: true; record: SupportCodeRecord }
  | { ok: false; reason: "throttled" | "invalid" };

/**
 * Redeem and consume a code. Single-use: a successful redeem deletes the code so
 * it can't be replayed. Throttled per client key (IP) to blunt brute-forcing of
 * the 6-digit space.
 */
export function redeemSupportCode(rawCode: string, clientKey: string): RedeemResult {
  const now = Date.now();

  // Throttle gate (applies to malformed and wrong codes alike).
  const a = attempts.get(clientKey);
  if (a && now - a.windowStart < ATTEMPT_WINDOW_MS && a.count >= MAX_ATTEMPTS) {
    return { ok: false, reason: "throttled" };
  }

  const registerFailure = () => {
    const cur = attempts.get(clientKey);
    if (!cur || now - cur.windowStart >= ATTEMPT_WINDOW_MS) {
      attempts.set(clientKey, { count: 1, windowStart: now });
    } else {
      cur.count += 1;
    }
  };

  const code = String(rawCode || "").trim();
  if (!/^\d{6}$/.test(code)) {
    registerFailure();
    return { ok: false, reason: "invalid" };
  }

  sweep(now);
  const record = codes.get(code);
  if (!record || record.expiresAt <= now) {
    registerFailure();
    return { ok: false, reason: "invalid" };
  }

  // Success: consume the code and clear the client's failure streak.
  codes.delete(code);
  attempts.delete(clientKey);
  return { ok: true, record };
}
