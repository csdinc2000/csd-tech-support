import assert from "node:assert/strict";
import test from "node:test";
import { describeSuppression, isAdSuppressed, pickPortalAd, rememberDismissal, type PortalAd } from "./portal-ads.ts";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};
const ad = (id: number, priority: number, suppressHours = 24): PortalAd => ({
  id, title: `Ad ${id}`, body: "", imageUrl: null, imageAlt: "", linkUrl: null, linkLabel: null,
  priority, delaySeconds: 0, suppressHours,
});

test("the highest-priority ad the visitor hasn't dismissed is shown", () => {
  const stores = { local: memory(), session: memory() };
  const ads = [ad(1, 1), ad(2, 9), ad(3, 5)];
  assert.equal(pickPortalAd(ads, stores)?.id, 2);
  rememberDismissal(ads[1], stores);
  assert.equal(pickPortalAd(ads, stores)?.id, 3);
  rememberDismissal(ads[2], stores);
  rememberDismissal(ads[0], stores);
  assert.equal(pickPortalAd(ads, stores), null);
});

test("a dismissal hides the ad for its configured period, then it can return", () => {
  const stores = { local: memory(), session: memory() };
  const now = Date.UTC(2026, 10, 11, 12);
  rememberDismissal(ad(7, 0, 48), stores, now);
  // A new session (fresh sessionStorage) still respects the 48 hours.
  const nextSession = { local: stores.local, session: memory() };
  assert.equal(isAdSuppressed(ad(7, 0), nextSession, now + 47 * 3_600_000), true);
  assert.equal(isAdSuppressed(ad(7, 0), nextSession, now + 49 * 3_600_000), false);
});

test("'this visit only' (0 hours) hides the ad until the session ends", () => {
  const stores = { local: memory(), session: memory() };
  rememberDismissal(ad(8, 0, 0), stores);
  assert.equal(isAdSuppressed(ad(8, 0), stores), true);
  assert.equal(isAdSuppressed(ad(8, 0), { local: stores.local, session: memory() }), false);
});

test("broken storage never blocks the portal", () => {
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  assert.doesNotThrow(() => rememberDismissal(ad(9, 0), { local: broken, session: broken }));
  assert.equal(pickPortalAd([ad(9, 0)], { local: broken, session: broken })?.id, 9);
});

test("suppression labels", () => {
  assert.equal(describeSuppression(0), "until the browser is closed");
  assert.equal(describeSuppression(24), "for 1 day");
  assert.equal(describeSuppression(168), "for 7 days");
  assert.equal(describeSuppression(5), "for 5 hours");
});
