import { test } from "node:test";
import assert from "node:assert/strict";

const { normalizeRejectionReason } = await import("@shared/schema");

test("normalizeRejectionReason trims, lowercases, and collapses whitespace", () => {
  assert.equal(
    normalizeRejectionReason("  EIN does NOT match  IRS records "),
    "ein does not match irs records",
  );
  assert.equal(normalizeRejectionReason("Foo\tBar\nBaz"), "foo bar baz");
});

test("normalizeRejectionReason treats near-identical reasons as equal", () => {
  const a = normalizeRejectionReason("EIN does not match IRS records");
  const b = normalizeRejectionReason("  ein   does not   match irs RECORDS  ");
  assert.equal(a, b);
});

test("normalizeRejectionReason keeps genuinely different reasons distinct", () => {
  const a = normalizeRejectionReason("EIN does not match IRS records");
  const b = normalizeRejectionReason("Website is missing a privacy policy");
  assert.notEqual(a, b);
});

test("normalizeRejectionReason yields empty string for blank input", () => {
  assert.equal(normalizeRejectionReason("   \n\t "), "");
});
