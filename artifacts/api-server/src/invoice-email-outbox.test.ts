import assert from "node:assert/strict";
import test from "node:test";
import {
  invoiceEmailDeliveryError,
  reminderScheduledAt,
  renderInvoiceEmail,
  retryDelayMs,
} from "./invoice-email-core";

test("invoice email includes the private payment link and branded amount", () => {
  const result = renderInvoiceEmail("invoice", {
    publicUrl: "https://billing.example/invoice/private-token",
    invoiceNumber: "INV-2026-000123",
    clientName: "Acme & Sons",
    totalCents: 12345,
    dueDate: "2026-09-15",
  });
  assert.match(result.subject, /INV-2026-000123/);
  assert.match(result.text, /\$123\.45/);
  assert.match(result.text, /https:\/\/billing\.example\/invoice\/private-token/);
  assert.match(result.html, /Acme &amp; Sons/);
});

test("reminder copy identifies an overdue invoice", () => {
  const result = renderInvoiceEmail("reminder", {
    publicUrl: "https://billing.example/invoice/token",
    invoiceNumber: "INV-9",
    clientName: "Customer",
    totalCents: 5000,
    dueDate: "2026-09-01",
  });
  assert.match(result.subject, /Payment reminder/);
  assert.match(result.text, /overdue/);
});

test("reminder schedule uses calendar days after the due date at 13:00 UTC", () => {
  assert.equal(reminderScheduledAt("2026-12-30", 3).toISOString(), "2027-01-02T13:00:00.000Z");
  assert.equal(reminderScheduledAt("2026-12-30T00:00:00.000Z", 3).toISOString(), "2027-01-02T13:00:00.000Z");
});

test("delivery retry backoff grows and caps at one day", () => {
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(4), 480_000);
  assert.equal(retryDelayMs(20), 86_400_000);
});

test("delivery failures expose the actionable provider message", () => {
  const error = Object.assign(new Error("Unauthorized"), {
    response: { body: { errors: [{ message: "Maximum credits exceeded" }] } },
  });
  assert.equal(invoiceEmailDeliveryError(error), "Maximum credits exceeded");
  assert.equal(invoiceEmailDeliveryError(new Error("Network unavailable")), "Network unavailable");
});