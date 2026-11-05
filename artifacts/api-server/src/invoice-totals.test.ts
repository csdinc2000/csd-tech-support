import assert from "node:assert/strict";
import test from "node:test";
import { calculateInvoiceTotals, invoiceTaxCents } from "./invoice-core";

const line = (unitAmountCents: number, quantity = 1) => ({ description: "Repair", quantity, unitAmountCents });

test("sales tax is charged on the amount after the discount", () => {
  const totals = calculateInvoiceTotals([line(10_000)], 700, 2_000);
  assert.equal(totals.subtotalCents, 10_000);
  assert.equal(totals.discountCents, 2_000);
  assert.equal(totals.taxCents, 560); // 7% of $80, not of $100
  assert.equal(totals.totalCents, 8_560);
  // The stored row still satisfies the DB check: total = subtotal + tax - discount.
  assert.equal(totals.totalCents, totals.subtotalCents + totals.taxCents - totals.discountCents);
});

test("tax rounds to the nearest cent on the discounted amount", () => {
  assert.equal(invoiceTaxCents(1_999, 0, 700), 140); // 139.93
  assert.equal(invoiceTaxCents(1_999, 999, 700), 70); // 7% of $10.00
  assert.equal(invoiceTaxCents(500, 500, 700), 0);
});

test("a discount may equal but not exceed the subtotal", () => {
  const free = calculateInvoiceTotals([line(5_000)], 700, 5_000);
  assert.equal(free.taxCents, 0);
  assert.equal(free.totalCents, 0);
  assert.throws(() => calculateInvoiceTotals([line(5_000)], 700, 5_001), /cannot exceed the subtotal/);
});

test("no discount keeps the original tax", () => {
  const totals = calculateInvoiceTotals([line(2_500, 2)], 650);
  assert.equal(totals.taxCents, 325);
  assert.equal(totals.totalCents, 5_325);
});

import { sentInvoiceBillingChanged } from "./invoice-core";

test("only edits that change what the customer pays, or who pays, replace the Stripe invoice", () => {
  const totals = calculateInvoiceTotals([line(10_000)], 700, 0);
  const existing = {
    contact_id: 4, client_id: 2, due_date: new Date("2026-12-01T00:00:00.000Z"),
    subtotal_cents: 10_000, tax_rate_bps: 700, tax_cents: 700, discount_cents: 0, total_cents: 10_700,
  };
  const oldLines = [{ description: "Repair", quantity: 1, unit_amount_cents: 10_000 }];
  const same = { dueDate: "2026-12-01", totals };
  assert.equal(sentInvoiceBillingChanged(existing, oldLines, same, 4, 2), false);
  assert.equal(sentInvoiceBillingChanged(existing, oldLines, { ...same, totals: calculateInvoiceTotals([line(10_000)], 650, 0) }, 4, 2), true);
  assert.equal(sentInvoiceBillingChanged(existing, oldLines, { ...same, dueDate: "2026-12-15" }, 4, 2), true);
  assert.equal(sentInvoiceBillingChanged(existing, oldLines, same, 5, 2), true);
  assert.equal(sentInvoiceBillingChanged(existing, [{ ...oldLines[0], description: "Diagnostics" }], same, 4, 2), true);
});
