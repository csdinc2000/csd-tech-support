import assert from "node:assert/strict";
import test from "node:test";
import {
  addUtcCalendarDays,
  applyInvoiceDefaultsToOmittedFields,
  DEFAULT_INVOICE_SETTINGS,
  invoiceBrandingSnapshot,
  publicInvoiceBranding,
  validateInvoiceSettings,
} from "./invoice-settings";

test("invoice settings use the CSD defaults and validate the complete contract", () => {
  assert.deepEqual(DEFAULT_INVOICE_SETTINGS, {
    businessName: "Computer Systems Depot",
    accentColor: "red",
    contactEmail: "",
    contactPhone: "",
    footer: "",
    defaultDueDays: 30,
    defaultTaxRateBps: 0,
    defaultNotes: "",
  });
  assert.deepEqual(validateInvoiceSettings({ ...DEFAULT_INVOICE_SETTINGS }), DEFAULT_INVOICE_SETTINGS);
  assert.throws(
    () => validateInvoiceSettings({ ...DEFAULT_INVOICE_SETTINGS, unexpected: true }),
    /unknown fields/,
  );
  assert.throws(
    () => validateInvoiceSettings({ ...DEFAULT_INVOICE_SETTINGS, defaultDueDays: 366 }),
    /defaultDueDays/,
  );
  assert.throws(
    () => validateInvoiceSettings({ ...DEFAULT_INVOICE_SETTINGS, defaultTaxRateBps: 10001 }),
    /defaultTaxRateBps/,
  );
  assert.throws(
    () => validateInvoiceSettings({ ...DEFAULT_INVOICE_SETTINGS, footer: "x".repeat(501) }),
    /footer/,
  );
});

test("invoice defaults apply only to omitted fields and use UTC calendar dates", () => {
  const settings = {
    ...DEFAULT_INVOICE_SETTINGS,
    defaultDueDays: 30,
    defaultTaxRateBps: 825,
    defaultNotes: "Payment due upon receipt",
  };
  const now = new Date("2025-12-31T23:30:00-08:00");
  assert.equal(addUtcCalendarDays(now, settings.defaultDueDays), "2026-01-31");

  assert.deepEqual(
    applyInvoiceDefaultsToOmittedFields({}, settings, now),
    {
      dueDate: "2026-01-31",
      taxRateBps: 825,
      notes: "Payment due upon receipt",
    },
  );
  assert.deepEqual(
    applyInvoiceDefaultsToOmittedFields(
      { dueDate: null, taxRateBps: 0, notes: "" },
      settings,
      now,
    ),
    { dueDate: null, taxRateBps: 0, notes: "" },
  );
});

test("sent invoice branding is snapshotted while legacy invoices get CSD defaults", () => {
  const customized = validateInvoiceSettings({
    ...DEFAULT_INVOICE_SETTINGS,
    businessName: "CSD West",
    accentColor: "navy",
    footer: "Thank you",
  });
  assert.deepEqual(invoiceBrandingSnapshot(customized), customized);
  assert.deepEqual(publicInvoiceBranding(customized), customized);
  assert.deepEqual(publicInvoiceBranding(null), DEFAULT_INVOICE_SETTINGS);
  assert.throws(() => publicInvoiceBranding({ businessName: "broken" }), /All invoice settings fields/);
});