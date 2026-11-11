import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { getAuth } from "@clerk/express";
import { pool } from "./db";
import { requireAuth } from "./middlewares/clerkAuth";
import { canAccessFeature } from "./staff-access";
import {
  duplicatePayPalRowFlags,
  parsePayPalCsv,
  previewRow,
  type PayPalParsedRow,
} from "./paypal-import-core";

const MAX_CSV_BYTES = 8 * 1024 * 1024;

function requireInvoiceAdmin(req: Request, res: Response, next: NextFunction) {
  void canAccessFeature(req, "invoices")
    .then((allowed) => allowed ? next() : res.status(403).json({ error: "Approved invoice access required" }))
    .catch(next);
}

function actor(req: Request): string {
  if (req.dbUser?.email || req.dbUser?.id) {
    return String(req.dbUser.email || req.dbUser.id);
  }
  const auth = getAuth(req);
  return String(auth.sessionClaims?.email || "admin");
}

function csvBody(req: Request): { csv: string; fileName: string | null } {
  const csv = req.body?.csv;
  if (typeof csv !== "string" || !csv.trim()) throw new Error("A CSV file is required");
  if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) throw new Error("CSV files must be 8 MB or smaller");
  const fileName = typeof req.body?.fileName === "string" ? req.body.fileName.slice(0, 255) : null;
  return { csv, fileName };
}

async function existingKeys(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const result = await pool.query("SELECT dedupe_key FROM paypal_transactions WHERE dedupe_key = ANY($1::text[])", [keys]);
  return new Set(result.rows.map((row) => row.dedupe_key));
}

function mappedRows(rows: PayPalParsedRow[], duplicates: boolean[]) {
  return rows.map((row, index) => previewRow(row, duplicates[index]));
}

export async function ensurePayPalImportSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS paypal_transactions (
      id BIGSERIAL PRIMARY KEY,
      source_transaction_id text,
      dedupe_key text NOT NULL,
      transaction_date timestamptz,
      transaction_type text NOT NULL,
      client_name text NOT NULL,
      amount_cents integer NOT NULL,
      currency text NOT NULL,
      net_amount_cents integer,
      status text,
      source_file_name text,
      imported_by text,
      imported_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS paypal_transactions_dedupe_uidx ON paypal_transactions(dedupe_key);
    CREATE INDEX IF NOT EXISTS paypal_transactions_date_idx ON paypal_transactions(transaction_date DESC);
    CREATE INDEX IF NOT EXISTS paypal_transactions_client_name_idx ON paypal_transactions(client_name);
    ALTER TABLE paypal_transactions ALTER COLUMN transaction_date DROP NOT NULL;
    ALTER TABLE paypal_transactions ALTER COLUMN net_amount_cents DROP NOT NULL;
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'paypal_transactions_currency_check'
      ) THEN
        ALTER TABLE paypal_transactions
          ADD CONSTRAINT paypal_transactions_currency_check CHECK (currency ~ '^[A-Z]{3}$');
      END IF;
    END $$;
  `);
}

export function registerPayPalImportRoutes(app: Express, authMiddleware: RequestHandler = requireAuth) {
  const admin = [authMiddleware, requireInvoiceAdmin];

  app.post("/api/paypal-import/preview", ...admin, async (req, res) => {
    try {
      const { csv } = csvBody(req);
      const parsed = parsePayPalCsv(csv);
      const existing = await existingKeys(parsed.rows.flatMap((row) =>
        row.legacyDedupeKey ? [row.dedupeKey, row.legacyDedupeKey] : [row.dedupeKey],
      ));
      const duplicates = duplicatePayPalRowFlags(parsed.rows, existing);
      const duplicateCount = duplicates.filter(Boolean).length;
      const warnings = [...parsed.warnings];
      if (duplicateCount > 0) warnings.push(`${duplicateCount} row${duplicateCount === 1 ? "" : "s"} already exist in the ledger and will be skipped.`);
      res.json({
        headers: ["transaction_date", "transaction_type", "client_name", "amount", "currency", "net_amount", "source_transaction_id", "status"],
        rows: mappedRows(parsed.rows, duplicates),
        errors: parsed.errors,
        warnings,
        duplicateCount,
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message || "Unable to preview PayPal CSV" });
    }
  });

  app.post("/api/paypal-import/import", ...admin, async (req, res) => {
    const client = await pool.connect();
    try {
      const { csv, fileName } = csvBody(req);
      const parsed = parsePayPalCsv(csv);
      const existing = await existingKeys(parsed.rows.flatMap((row) =>
        row.legacyDedupeKey ? [row.dedupeKey, row.legacyDedupeKey] : [row.dedupeKey],
      ));
      const duplicates = duplicatePayPalRowFlags(parsed.rows, existing);
      const importable = parsed.rows.filter((row, index) => !row.issue && !duplicates[index]);
      let imported = 0;
      const errors = [...parsed.errors];
      await client.query("BEGIN");
      for (const row of importable) {
        const result = await client.query(
          `INSERT INTO paypal_transactions
            (source_transaction_id, dedupe_key, transaction_date, transaction_type, client_name,
             amount_cents, currency, net_amount_cents, status, source_file_name, imported_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [
            row.sourceTransactionId,
            row.dedupeKey,
            row.transactionDate,
            row.transactionType,
            row.clientName,
            row.amountCents,
            row.currency,
            row.netAmountCents,
            row.status,
            fileName,
            actor(req),
          ],
        );
        imported += result.rowCount ?? 0;
      }
      await client.query("COMMIT");
      res.json({
        imported,
        skipped: parsed.rows.length - imported,
        errors,
        duplicateCount: duplicates.filter(Boolean).length + (importable.length - imported),
      });
    } catch (error: any) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: error.message || "Unable to import PayPal CSV" });
    } finally {
      client.release();
    }
  });
}