export type CanonicalPublicUrl = { ok: true; origin: string } | { ok: false; error: string };

/** Accept only an origin: Twilio signature and stream URL construction must not inherit a path or query. */
export function canonicalPublicAppBaseUrl(value: string | undefined): CanonicalPublicUrl {
  const raw = value?.trim() || "";
  if (!raw) return { ok: false, error: "APP_BASE_URL is required." };
  // URL normalizes a trailing bare `?`/`#` away, so reject their raw presence too.
  if (raw.includes("?")) return { ok: false, error: "APP_BASE_URL must not contain a query string." };
  if (raw.includes("#")) return { ok: false, error: "APP_BASE_URL must not contain a fragment." };
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return { ok: false, error: "APP_BASE_URL must use HTTPS." };
    if (!url.hostname) return { ok: false, error: "APP_BASE_URL must include a hostname." };
    if (url.username || url.password) return { ok: false, error: "APP_BASE_URL must not contain credentials." };
    if (url.pathname !== "/") return { ok: false, error: "APP_BASE_URL must be an origin with no path." };
    if (url.search) return { ok: false, error: "APP_BASE_URL must not contain a query string." };
    if (url.hash) return { ok: false, error: "APP_BASE_URL must not contain a fragment." };
    return { ok: true, origin: url.origin };
  } catch {
    return { ok: false, error: "APP_BASE_URL must be a valid HTTPS origin." };
  }
}

export function reconcileCredentialListMappings(mappingListSids: string[], expectedListSid: string) {
  const expected = mappingListSids.filter((sid) => sid === expectedListSid);
  const unexpected = mappingListSids.filter((sid) => sid !== expectedListSid);
  if (unexpected.length || expected.length > 1) {
    return { action: "fail" as const, error: "Unexpected or duplicate call-auth credential-list mapping on this SIP Domain." };
  }
  return expected.length === 1 ? { action: "keep" as const } : { action: "create" as const };
}

export function reconcileCredentialUsernames(usernames: string[], expectedUsername: string) {
  const expected = usernames.filter((username) => username === expectedUsername);
  const stale = usernames.filter((username) => username !== expectedUsername);
  if (stale.length || expected.length > 1) {
    return { action: "fail" as const, error: "Managed credential list contains unexpected or duplicate SIP usernames." };
  }
  return expected.length === 1 ? { action: "update" as const } : { action: "create" as const };
}