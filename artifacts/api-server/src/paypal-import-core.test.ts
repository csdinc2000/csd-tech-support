import assert from "node:assert/strict";
import test from "node:test";
import { duplicatePayPalRowFlags, parsePayPalCsv, previewRow } from "./paypal-import-core";

test("maps standard PayPal columns and quoted values to CRM transaction fields", () => {
  const csv = [
    "Date,Type,Name,Gross,Fee,Net,Currency,Transaction ID,Status",
    '09/08/2026,Payment Received,"Smith, Jane","$125.00","-$4.13","$120.87",USD,9AB123,Completed',
  ].join("\r\n");

  const parsed = parsePayPalCsv(csv);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].clientName, "Smith, Jane");
  assert.equal(parsed.rows[0].amountCents, 12_500);
  assert.equal(parsed.rows[0].netAmountCents, 12_087);
  assert.equal(parsed.rows[0].currency, "USD");
  assert.equal(parsed.rows[0].sourceTransactionId, "9AB123");
  assert.equal(previewRow(parsed.rows[0]).amount, "125.00");
});

test("supports the Amount column and accounting-style negative values", () => {
  const csv = [
    "Date,Type,Name,Amount,Currency,Net",
    '2026-09-08,Refund,Customer,"($50.00)",USD,"($50.00)"',
  ].join("\n");

  const parsed = parsePayPalCsv(csv);
  assert.equal(parsed.rows[0].amountCents, -5_000);
  assert.equal(parsed.rows[0].netAmountCents, -5_000);
  assert.equal(parsed.rows[0].issue, undefined);
  assert.equal(parsed.warnings.length, 1);
});

test("rejects files missing required PayPal columns", () => {
  const parsed = parsePayPalCsv("Date,Name,Amount\n09/08/2026,Customer,25.00");
  assert.equal(parsed.rows.length, 0);
  assert.match(parsed.errors[0], /Type/);
  assert.match(parsed.errors[0], /Currency/);
  assert.match(parsed.errors[0], /Net/);
});

test("marks malformed transaction rows without blocking valid rows", () => {
  const csv = [
    "Date,Type,Name,Gross,Currency,Net",
    "09/08/2026,Payment Received,Valid Customer,25.00,USD,24.00",
    "not-a-date,Payment Received,,wrong,US,wrong",
  ].join("\n");

  const parsed = parsePayPalCsv(csv);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].issue, undefined);
  assert.match(parsed.rows[1].issue ?? "", /Date is invalid/);
  assert.equal(previewRow(parsed.rows[1]).valid, false);
});

test("flags transactions already imported and repeated within one CSV", () => {
  const csv = [
    "Date,Type,Name,Gross,Currency,Net,Transaction ID",
    "09/08/2026,Payment Received,First Customer,25.00,USD,24.00,TX-1",
    "09/08/2026,Payment Received,First Customer,25.00,USD,24.00,TX-1",
    "09/08/2026,Payment Received,Second Customer,40.00,USD,39.00,TX-2",
  ].join("\n");
  const rows = parsePayPalCsv(csv).rows;

  assert.deepEqual(duplicatePayPalRowFlags(rows, new Set([rows[2].dedupeKey])), [false, true, true]);
});

test("accepts translated PayPal invoice rows with blank dates and net amounts", () => {
  const csv = [
    "Date,Type,Name,Amount,Currency,Net,Transaction ID,Status",
    ",Invoice Sent,Customer,187.25,USD,,INV2-ABC,Paid",
    ",Shopping Cart Item,Customer,55.00,USD,,INV2-ABC,Paid",
    ",Shopping Cart Item,Customer,120.00,USD,,INV2-ABC,Paid",
  ].join("\n");

  const parsed = parsePayPalCsv(csv);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows.every((row) => row.issue === undefined), true);
  assert.equal(parsed.rows[0].transactionDate, null);
  assert.equal(parsed.rows[0].netAmountCents, null);
  assert.deepEqual(duplicatePayPalRowFlags(parsed.rows, new Set()), [false, false, false]);
});

test("still rejects malformed nonblank translated dates and net amounts", () => {
  const csv = [
    "Date,Type,Name,Amount,Currency,Net,Transaction ID",
    "not-a-date,Invoice Sent,Customer,187.25,USD,not-money,INV2-ABC",
  ].join("\n");

  const parsed = parsePayPalCsv(csv);
  assert.match(parsed.rows[0].issue ?? "", /Date is invalid/);
  assert.match(parsed.rows[0].issue ?? "", /Net is invalid/);
});

test("recognizes rows imported with the previous transaction-id-only dedupe key", () => {
  const csv = [
    "Date,Type,Name,Amount,Currency,Net,Transaction ID",
    "2026-09-08,Payment Received,Customer,25.00,USD,24.00,TX-LEGACY",
  ].join("\n");
  const row = parsePayPalCsv(csv).rows[0];

  assert.ok(row.legacyDedupeKey);
  assert.deepEqual(duplicatePayPalRowFlags([row], new Set([row.legacyDedupeKey!])), [true]);
});