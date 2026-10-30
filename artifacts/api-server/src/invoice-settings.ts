import { pool } from "./db";

export type InvoiceSettings = {
  businessName: string;
  accentColor: "red" | "navy";
  contactEmail: string;
  contactPhone: string;
  footer: string;
  defaultDueDays: number;
  defaultTaxRateBps: number;
  defaultNotes: string;
};

export const DEFAULT_INVOICE_SETTINGS: InvoiceSettings = Object.freeze({
  businessName: "Computer Systems Depot",
  accentColor: "red",
  contactEmail: "",
  contactPhone: "",
  footer: "",
  defaultDueDays: 30,
  defaultTaxRateBps: 0,
  defaultNotes: "",
});

const SETTINGS_FIELDS = [
  "businessName", "accentColor", "contactEmail", "contactPhone", "footer",
  "defaultDueDays", "defaultTaxRateBps", "defaultNotes",
] as const;

export function validateInvoiceSettings(value: unknown): InvoiceSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invoice settings must be an object");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== SETTINGS_FIELDS.length
    || !SETTINGS_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(input, field))) {
    throw new Error("All invoice settings fields are required and unknown fields are not allowed");
  }

  const text = (field: string, max: number, required = false): string => {
    const raw = input[field];
    if (typeof raw !== "string") throw new Error(`${field} must be a string`);
    const normalized = raw.trim();
    if (normalized.length > max || (required && !normalized)) {
      throw new Error(`${field} must be ${required ? "non-empty and " : ""}${max} characters or fewer`);
    }
    return normalized;
  };
  const businessName = text("businessName", 160, true);
  const accentColor = input.accentColor;
  if (accentColor !== "red" && accentColor !== "navy") {
    throw new Error("accentColor must be red or navy");
  }
  const contactEmail = text("contactEmail", 254);
  if (contactEmail && !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(contactEmail)) {
    throw new Error("contactEmail must be a valid email address");
  }
  const contactPhone = text("contactPhone", 40);
  const footer = text("footer", 500);
  const defaultNotes = text("defaultNotes", 10000);
  const defaultDueDays = input.defaultDueDays;
  const defaultTaxRateBps = input.defaultTaxRateBps;
  if (!Number.isInteger(defaultDueDays) || Number(defaultDueDays) < 1 || Number(defaultDueDays) > 365) {
    throw new Error("defaultDueDays must be an integer between 1 and 365");
  }
  if (!Number.isInteger(defaultTaxRateBps) || Number(defaultTaxRateBps) < 0 || Number(defaultTaxRateBps) > 10000) {
    throw new Error("defaultTaxRateBps must be an integer between 0 and 10000");
  }
  return {
    businessName,
    accentColor,
    contactEmail,
    contactPhone,
    footer,
    defaultDueDays: Number(defaultDueDays),
    defaultTaxRateBps: Number(defaultTaxRateBps),
    defaultNotes,
  };
}

export async function getInvoiceSettings(): Promise<InvoiceSettings> {
  const result = await pool.query("SELECT settings FROM invoice_settings WHERE id = 1");
  return result.rows[0] ? validateInvoiceSettings(result.rows[0].settings) : { ...DEFAULT_INVOICE_SETTINGS };
}

export async function saveInvoiceSettings(settings: InvoiceSettings): Promise<InvoiceSettings> {
  const result = await pool.query(
    `INSERT INTO invoice_settings (id, settings, updated_at)
     VALUES (1, $1::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()
     RETURNING settings`,
    [JSON.stringify(validateInvoiceSettings(settings))],
  );
  return validateInvoiceSettings(result.rows[0].settings);
}

export function applyInvoiceDefaultsToOmittedFields(
  body: Record<string, unknown>,
  settings: InvoiceSettings,
  now = new Date(),
): Record<string, unknown> {
  const result = { ...body };
  if (!Object.prototype.hasOwnProperty.call(body, "dueDate")) {
    result.dueDate = addUtcCalendarDays(now, settings.defaultDueDays);
  }
  if (!Object.prototype.hasOwnProperty.call(body, "taxRateBps")) {
    result.taxRateBps = settings.defaultTaxRateBps;
  }
  if (!Object.prototype.hasOwnProperty.call(body, "notes")) {
    result.notes = settings.defaultNotes;
  }
  return result;
}

export function addUtcCalendarDays(date: Date, days: number): string {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export function invoiceBrandingSnapshot(settings: InvoiceSettings): InvoiceSettings {
  return validateInvoiceSettings(settings);
}

export function publicInvoiceBranding(snapshot: unknown): InvoiceSettings {
  if (snapshot === null || snapshot === undefined) {
    return { ...DEFAULT_INVOICE_SETTINGS };
  }
  return validateInvoiceSettings(snapshot);
}