// ---------------------------------------------------------------------------
// Customer referral program — pure helpers (no database), unit-tested in
// referral-core.test.ts. Routes and storage live in referrals.ts.
// ---------------------------------------------------------------------------

export const REFERRAL_STATUSES = ["pending", "qualified", "rewarded", "declined"] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

// No 0/O, 1/I/L — codes get read aloud over the phone and typed from flyers.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_SUFFIX_LENGTH = 5;

/**
 * A short, shareable code such as `MARIA-7K3QD`: the referrer's first name
 * (letters only, max 8) so friends recognise it, plus a random suffix so it
 * can't be guessed. `randomBytes` is injectable for tests.
 */
export function makeReferralCode(fullName: string, randomBytes: (size: number) => Uint8Array): string {
  const first = (fullName.trim().split(/\s+/)[0] ?? "")
    .normalize("NFD")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase()
    .slice(0, 8);
  const bytes = randomBytes(CODE_SUFFIX_LENGTH);
  let suffix = "";
  for (let i = 0; i < CODE_SUFFIX_LENGTH; i++) suffix += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${first || "CSD"}-${suffix}`;
}

/** Cleans a code typed by a person or taken from a URL. Returns null when it can't be a code. */
export function normalizeReferralCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 20);
  return /^[A-Z]{1,8}-[A-Z0-9]{4,8}$/.test(clean) ? clean : null;
}

const phoneDigits = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "").slice(-10);

/** True when the "friend" is the referrer themselves (same email or phone). */
export function isSelfReferral(
  referrer: { email: string; phone?: string | null },
  friend: { email?: string | null; phone?: string | null },
): boolean {
  const friendEmail = friend.email?.trim().toLowerCase();
  if (friendEmail && friendEmail === referrer.email.trim().toLowerCase()) return true;
  const a = phoneDigits(referrer.phone);
  const b = phoneDigits(friend.phone);
  return a.length === 10 && a === b;
}

/** "Devon Price" → "Devon P." — what a referrer may see about the people they referred. */
export function maskedFriendName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A friend";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || "there";
}

export type ReferralSummary = { total: number; pending: number; qualified: number; rewarded: number; declined: number };

export function summarizeReferrals(rows: { status: string }[]): ReferralSummary {
  const summary: ReferralSummary = { total: rows.length, pending: 0, qualified: 0, rewarded: 0, declined: 0 };
  for (const row of rows) {
    if (row.status in summary && row.status !== "total") summary[row.status as ReferralStatus] += 1;
  }
  return summary;
}

/**
 * Timestamp columns to set when staff move a referral to `next`. Qualifying
 * stamps qualified_at once; rewarding also stamps qualified_at if staff skipped
 * straight to it; going back to pending clears both.
 */
export function statusTimestamps(next: ReferralStatus): { qualifiedAt: "now" | "keep" | "clear"; rewardedAt: "now" | "keep" | "clear" } {
  switch (next) {
    case "pending": return { qualifiedAt: "clear", rewardedAt: "clear" };
    case "qualified": return { qualifiedAt: "now", rewardedAt: "clear" };
    case "rewarded": return { qualifiedAt: "now", rewardedAt: "now" };
    case "declined": return { qualifiedAt: "keep", rewardedAt: "clear" };
  }
}
