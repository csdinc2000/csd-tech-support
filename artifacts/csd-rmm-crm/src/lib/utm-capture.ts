/**
 * Remembers the marketing campaign a visitor arrived with so the intake form
 * can report it, even after they click around the public site first.
 * Last campaign wins within a browser tab session; links built with the
 * Marketing hub's tracked-link tool carry `utm_campaign`.
 */
const STORAGE_KEY = "csd:utm-campaign";
// Referral codes outlive the tab: friends often open the link, then come back later.
const REFERRAL_KEY = "csd:referral-code";

/** Also remembers a `?ref=CODE` referral code from a customer's share link. */
export function captureUtmCampaign(search = window.location.search): void {
  try {
    const params = new URLSearchParams(search);
    const campaign = params.get("utm_campaign")?.trim();
    if (campaign) sessionStorage.setItem(STORAGE_KEY, campaign.slice(0, 120));
    const ref = params.get("ref")?.trim();
    if (ref) localStorage.setItem(REFERRAL_KEY, ref.slice(0, 20));
  } catch { /* storage unavailable — attribution is best effort */ }
}

export function storedReferralCode(): string | undefined {
  try {
    return localStorage.getItem(REFERRAL_KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function clearStoredReferralCode(): void {
  try { localStorage.removeItem(REFERRAL_KEY); } catch { /* nothing stored */ }
}

/** The campaign to send with an intake submission, if any. */
export function storedUtmCampaign(): string | undefined {
  try {
    return sessionStorage.getItem(STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}
