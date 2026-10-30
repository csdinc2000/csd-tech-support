import type { Express, Request, Response } from "express";
import { pool } from "./db";
import { canAccessFeature } from "./staff-access";

const MAX_TEMPLATES = 50;
const MAX_LINES = 20;
const MAX_INVOICE_CENTS = 2_000_000_000;

type TemplateLine = { description: string; quantity: number; unitAmountCents: number };
type InvoiceTemplate = {
  id: number;
  label: string;
  lineItems: TemplateLine[];
  dueDays: number;
  terms: string;
  taxRateBps: number;
  discountCents: number;
  notes: string | null;
  createdAt: string;
};

export async function ensureInvoiceTemplatesSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_creation_templates (
      id serial PRIMARY KEY,
      label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
      line_items jsonb NOT NULL,
      due_days integer NOT NULL CHECK (due_days BETWEEN 0 AND 3650),
      terms text NOT NULL CHECK (length(terms) BETWEEN 1 AND 80),
      tax_rate_bps integer NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
      discount_cents integer NOT NULL CHECK (discount_cents BETWEEN 0 AND 1000000000),
      notes text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS invoice_creation_templates_created_idx
      ON invoice_creation_templates(created_at, id);
  `);
}

function parseTemplate(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Template must be an object");
  const body = value as Record<string, unknown>;
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > 80) throw new Error("label must be between 1 and 80 characters");
  const terms = typeof body.terms === "string" ? body.terms.trim() : "";
  if (!terms || terms.length > 80) throw new Error("terms must be between 1 and 80 characters");
  if (!Array.isArray(body.lineItems) || body.lineItems.length < 1 || body.lineItems.length > MAX_LINES) {
    throw new Error(`lineItems must contain between 1 and ${MAX_LINES} items`);
  }
  const lineItems = body.lineItems.map((line: unknown, index): TemplateLine => {
    if (!line || typeof line !== "object" || Array.isArray(line)) throw new Error(`lineItems[${index}] is invalid`);
    const item = line as Record<string, unknown>;
    const description = typeof item.description === "string" ? item.description.trim() : "";
    if (!description || description.length > 500) throw new Error(`lineItems[${index}].description is invalid`);
    if (!Number.isSafeInteger(item.quantity) || Number(item.quantity) < 1 || Number(item.quantity) > 100_000) {
      throw new Error(`lineItems[${index}].quantity is invalid`);
    }
    if (!Number.isSafeInteger(item.unitAmountCents) || Number(item.unitAmountCents) < 0 || Number(item.unitAmountCents) > MAX_INVOICE_CENTS) {
      throw new Error(`lineItems[${index}].unitAmountCents is invalid`);
    }
    const lineTotal = Number(item.quantity) * Number(item.unitAmountCents);
    if (!Number.isSafeInteger(lineTotal) || lineTotal > MAX_INVOICE_CENTS) throw new Error(`lineItems[${index}] amount is too large`);
    return { description, quantity: Number(item.quantity), unitAmountCents: Number(item.unitAmountCents) };
  });
  const dueDays = body.dueDays;
  const taxRateBps = body.taxRateBps;
  const discountCents = body.discountCents;
  if (!Number.isSafeInteger(dueDays) || Number(dueDays) < 0 || Number(dueDays) > 3650) throw new Error("dueDays must be between 0 and 3650");
  if (!Number.isSafeInteger(taxRateBps) || Number(taxRateBps) < 0 || Number(taxRateBps) > 10000) throw new Error("taxRateBps must be between 0 and 10000");
  if (!Number.isSafeInteger(discountCents) || Number(discountCents) < 0 || Number(discountCents) > MAX_INVOICE_CENTS) throw new Error("discountCents is invalid");
  const subtotal = lineItems.reduce((sum, line) => sum + line.quantity * line.unitAmountCents, 0);
  if (!Number.isSafeInteger(subtotal) || subtotal > MAX_INVOICE_CENTS) throw new Error("Template subtotal is too large");
  const tax = Math.round((subtotal * Number(taxRateBps)) / 10000);
  if (Number(discountCents) > subtotal + tax) throw new Error("discountCents cannot exceed subtotal plus tax");
  const notes = body.notes == null || body.notes === "" ? null : body.notes;
  if (notes !== null && (typeof notes !== "string" || notes.trim().length > 2000)) throw new Error("notes must be at most 2000 characters");
  return { label, lineItems, dueDays: Number(dueDays), terms, taxRateBps: Number(taxRateBps), discountCents: Number(discountCents), notes: typeof notes === "string" ? notes.trim() || null : null };
}

function mapTemplate(row: any): InvoiceTemplate {
  const lineItems = typeof row.line_items === "string" ? JSON.parse(row.line_items) : row.line_items;
  return {
    id: Number(row.id),
    label: row.label,
    lineItems,
    dueDays: Number(row.due_days),
    terms: row.terms,
    taxRateBps: Number(row.tax_rate_bps),
    discountCents: Number(row.discount_cents),
    notes: row.notes,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function requireInvoiceFeature(req: Request, res: Response, next: (error?: unknown) => void) {
  void canAccessFeature(req, "invoices")
    .then((allowed) => allowed ? next() : res.status(403).json({ error: "Approved invoice access required" }))
    .catch(next);
}

export function registerInvoiceTemplateRoutes(app: Express): void {
  app.get("/api/invoices/templates", requireInvoiceFeature, async (_req, res) => {
    try {
      const result = await pool.query("SELECT * FROM invoice_creation_templates ORDER BY created_at DESC, id DESC");
      return res.json(result.rows.map(mapTemplate));
    } catch {
      return res.status(500).json({ error: "Could not load invoice templates" });
    }
  });

  app.post("/api/invoices/templates", requireInvoiceFeature, async (req, res) => {
    let template: ReturnType<typeof parseTemplate>;
    try {
      template = parseTemplate(req.body);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "Template is invalid" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [1196573765, 1]);
      const count = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM invoice_creation_templates");
      if (Number(count.rows[0]?.count ?? 0) >= MAX_TEMPLATES) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: `A maximum of ${MAX_TEMPLATES} shared invoice templates is allowed` });
      }
      const saved = await client.query(
        `INSERT INTO invoice_creation_templates (label, line_items, due_days, terms, tax_rate_bps, discount_cents, notes)
         VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7) RETURNING *`,
        [template.label, JSON.stringify(template.lineItems), template.dueDays, template.terms, template.taxRateBps, template.discountCents, template.notes],
      );
      await client.query("COMMIT");
      return res.status(201).json(mapTemplate(saved.rows[0]));
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      return res.status(500).json({ error: "Could not save invoice template" });
    } finally {
      client.release();
    }
  });

  app.delete("/api/invoices/templates/:id", requireInvoiceFeature, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Template id is invalid" });
    try {
      const deleted = await pool.query("DELETE FROM invoice_creation_templates WHERE id=$1", [id]);
      if (!deleted.rowCount) return res.status(404).json({ error: "Invoice template not found" });
      return res.status(204).end();
    } catch {
      return res.status(500).json({ error: "Could not delete invoice template" });
    }
  });
}