import assert from "node:assert/strict";
import test from "node:test";
import {
  businessDate,
  describeVoucher,
  formatDateOnly,
  isValidPercentOff,
  makeVoucherCode,
  normalizeVoucherCode,
  summarizeVouchers,
  voucherDiscountCents,
  voucherState,
} from "./voucher-core";

const fixedBytes = (values: number[]) => () => Uint8Array.from(values);

test("voucher codes use the unambiguous alphabet and round-trip through normalization", () => {
  const code = makeVoucherCode(fixedBytes([0, 1, 2, 30, 31, 255]));
  assert.match(code, /^CSD-[2-9A-HJKMNP-Z]{6}$/);
  assert.equal(normalizeVoucherCode(code), code);
  assert.equal(normalizeVoucherCode(` ${code.toLowerCase().replace("-", " ")} `), code);
  assert.equal(normalizeVoucherCode("CSD-12345"), null);
  assert.equal(normalizeVoucherCode("MARIA-7K3QD"), null);
  assert.equal(normalizeVoucherCode(42), null);
});

test("only whole percentages from 1 to 100 are valid", () => {
  for (const ok of [1, 15, 100]) assert.equal(isValidPercentOff(ok), true, String(ok));
  for (const bad of [0, -5, 101, 12.5, Number.NaN, "10"]) assert.equal(isValidPercentOff(bad), false, String(bad));
});

test("discount rounds to the cent and respects the cap and the subtotal", () => {
  assert.equal(voucherDiscountCents(10_000, 15), 1_500);
  assert.equal(voucherDiscountCents(9_999, 15), 1_500); // 1499.85 → 1500
  assert.equal(voucherDiscountCents(50_000, 20, 5_000), 5_000);
  assert.equal(voucherDiscountCents(10_000, 20, 5_000), 2_000);
  assert.equal(voucherDiscountCents(12_345, 100), 12_345);
  assert.equal(voucherDiscountCents(0, 50), 0);
  assert.throws(() => voucherDiscountCents(10_000, 0));
});

test("vouchers are good through the end of their expiry date in business time", () => {
  assert.equal(voucherState({ status: "active", expiresOn: "2026-11-30" }, "2026-11-30"), "active");
  assert.equal(voucherState({ status: "active", expiresOn: "2026-11-30" }, "2026-12-01"), "expired");
  assert.equal(voucherState({ status: "active", expiresOn: null }, "2030-01-01"), "active");
  assert.equal(voucherState({ status: "redeemed", expiresOn: "2020-01-01" }, "2026-12-01"), "redeemed");
  assert.equal(voucherState({ status: "void", expiresOn: null }, "2026-12-01"), "void");
  // 02:00 UTC on Dec 1 is still Nov 30 in Florida.
  assert.equal(businessDate(new Date("2026-12-01T02:00:00Z")), "2026-11-30");
});

test("summaries count each state", () => {
  assert.deepEqual(summarizeVouchers(["active", "active", "expired", "redeemed", "void"]), {
    total: 5, active: 2, redeemed: 1, expired: 1, void: 1,
  });
});

test("customer-facing wording", () => {
  assert.equal(describeVoucher({ percentOff: 15, maxDiscountCents: null }), "15% off your next service");
  assert.equal(describeVoucher({ percentOff: 20, maxDiscountCents: 5_000 }), "20% off your next service (up to $50.00)");
  assert.equal(formatDateOnly("2026-11-30"), "Nov 30, 2026");
});
