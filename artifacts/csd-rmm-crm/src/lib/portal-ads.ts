// Portal popup ads: types and the pure rules for which ad to show and how long
// a dismissal hides it. Staff manage ads in Marketing → All modules → Portal
// popup ads (/marketing/portal-ads); server: api-server/src/portal-ads.ts.

export type PortalAd = {
  id: number;
  title: string;
  body: string;
  imageUrl: string | null;
  imageAlt: string;
  linkUrl: string | null;
  linkLabel: string | null;
  priority: number;
  /** Seconds after the page loads before the ad appears. */
  delaySeconds: number;
  /** How long a dismissal hides this ad; 0 = for the rest of the browser session. */
  suppressHours: number;
};

export type PortalAdEvent = "impression" | "dismiss" | "click";

/** Minimal Storage shape so tests can pass a fake. */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

const keyFor = (adId: number) => `csd:portal-ad-dismissed:${adId}`;

/** Whether the visitor dismissed this ad recently enough that it stays hidden. */
export function isAdSuppressed(
  ad: Pick<PortalAd, "id">,
  stores: { local: KeyValueStore | null; session: KeyValueStore | null },
  now = Date.now(),
): boolean {
  try {
    if (stores.session?.getItem(keyFor(ad.id))) return true;
    const until = Number(stores.local?.getItem(keyFor(ad.id)) ?? 0);
    return Number.isFinite(until) && until > now;
  } catch {
    return false;
  }
}

/** Remember a dismissal for the ad's configured period. */
export function rememberDismissal(
  ad: Pick<PortalAd, "id" | "suppressHours">,
  stores: { local: KeyValueStore | null; session: KeyValueStore | null },
  now = Date.now(),
): void {
  try {
    // Always hide it for the rest of this session; longer periods also go to localStorage.
    stores.session?.setItem(keyFor(ad.id), "1");
    if (ad.suppressHours > 0) stores.local?.setItem(keyFor(ad.id), String(now + ad.suppressHours * 3_600_000));
  } catch {
    // Private browsing / storage full: the ad may show again, which is acceptable.
  }
}

/** The one ad to show: highest priority the visitor hasn't dismissed. */
export function pickPortalAd(
  ads: PortalAd[],
  stores: { local: KeyValueStore | null; session: KeyValueStore | null },
  now = Date.now(),
): PortalAd | null {
  return [...ads].sort((a, b) => b.priority - a.priority).find((ad) => !isAdSuppressed(ad, stores, now)) ?? null;
}

export function browserStores(): { local: KeyValueStore | null; session: KeyValueStore | null } {
  const get = (name: "localStorage" | "sessionStorage") => {
    try {
      return typeof window !== "undefined" ? window[name] : null;
    } catch {
      return null;
    }
  };
  return { local: get("localStorage"), session: get("sessionStorage") };
}

/** Human label for a suppression period, used in the staff form. */
export function describeSuppression(hours: number): string {
  if (hours <= 0) return "until the browser is closed";
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? "for 1 day" : `for ${days} days`;
  }
  return hours === 1 ? "for 1 hour" : `for ${hours} hours`;
}
