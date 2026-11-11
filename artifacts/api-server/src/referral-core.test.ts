import assert from "node:assert/strict";
import test from "node:test";
import {
  isSelfReferral,
  makeReferralCode,
  maskedFriendName,
  normalizeReferralCode,
  statusTimestamps,
  summarizeReferrals,
} from "./referral-core";

const fixedBytes = (values: number[]) => () => Uint8Array.from(values);

test("referral codes use the first name and an unambiguous random suffix", () => {
  assert.equal(makeReferralCode("Maria Alvarez", fixedBytes([0, 1, 2, 3, 30])), "MARIA-2345Z");
  assert.equal(makeReferralCode("  José-Luis Pérez ", fixedBytes([0, 0, 0, 0, 0])), "JOSELUIS-22222");
  assert.equal(makeReferralCode("李", fixedBytes([5, 5, 5, 5, 5])), "CSD-77777");
  assert.equal(makeReferralCode("Bartholomew", fixedBytes([0, 0, 0, 0, 0])).split("-")[0], "BARTHOLO");
  for (let i = 0; i < 256; i += 7) {
    const suffix = makeReferralCode("Al", fixedBytes([i, i + 1, i + 2, i + 3, i + 4].map((n) => n % 256))).split("-")[1];
    assert.doesNotMatch(suffix, /[01OIL]/);
  }
});

test("normalizeReferralCode accepts pasted codes and rejects junk", () => {
  assert.equal(normalizeReferralCode(" maria-2345z "), "MARIA-2345Z");
  assert.equal(normalizeReferralCode("MARIA-2345Z!"), "MARIA-2345Z");
  assert.equal(normalizeReferralCode("MARIA"), null);
  assert.equal(normalizeReferralCode("'; drop table--"), null);
  assert.equal(normalizeReferralCode(42), null);
});

test("self-referrals are caught by email or phone", () => {
  const referrer = { email: "Maria@Example.com", phone: "+1 (954) 555-0101" };
  assert.equal(isSelfReferral(referrer, { email: "maria@example.com" }), true);
  assert.equal(isSelfReferral(referrer, { email: "devon@example.com", phone: "954-555-0101" }), true);
  assert.equal(isSelfReferral(referrer, { email: "devon@example.com", phone: "954-555-0102" }), false);
  assert.equal(isSelfReferral({ email: "a@b.co", phone: null }, { email: null, phone: null }), false);
});

test("friend names are masked to first name and last initial", () => {
  assert.equal(maskedFriendName("Devon Price"), "Devon P.");
  assert.equal(maskedFriendName("Ana María de la Cruz"), "Ana C.");
  assert.equal(maskedFriendName("Cher"), "Cher");
  assert.equal(maskedFriendName("  "), "A friend");
});

test("summaries and status timestamps", () => {
  assert.deepEqual(
    summarizeReferrals([{ status: "pending" }, { status: "rewarded" }, { status: "rewarded" }, { status: "bogus" }]),
    { total: 4, pending: 1, qualified: 0, rewarded: 2, declined: 0 },
  );
  assert.deepEqual(statusTimestamps("rewarded"), { qualifiedAt: "now", rewardedAt: "now" });
  assert.deepEqual(statusTimestamps("pending"), { qualifiedAt: "clear", rewardedAt: "clear" });
});
