import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { getAuth } from "@clerk/express";
import { pool } from "./db";
import { requireAuth } from "./middlewares/clerkAuth";
import { canAccessFeature, requireStaffAdministrator } from "./staff-access";
import {
  blankFillPatch,
  duplicateContactRowFlags,
  FIELD_LABELS,
  parseContactCsv,
  phoneKey,
  PREVIEW_HEADERS,
  previewContactRow,
  selectContactRows,
  WRITABLE_FIELDS,
  type ContactParsedRow,
  type ContactRowAction,
  type ExistingContact,
  type WritableField,
} from "./contact-import-core";

const MAX_CSV_BYTES = 8 * 1024 * 1024;

/** Just enough of a pg client for the writes below, so tests can supply one. */
type QueryRunner = { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> };

export type PlannedContactRow = ReturnType<typeof planContactRows>[number];

export type ContactImportTotals = { created: number; enriched: number; unchanged: number };

/** `crm_contacts` column for each field the importer may write. */
const COLUMNS: Record<WritableField, string> = {
  fullName: "full_name",
  email: "email",
  mobilePhone: "mobile_phone",
  officePhone: "office_phone",
  company: "company",
  address: "address",
  city: "city",
  state: "state",
  zipCode: "zip_code",
  notes: "notes",
};

const SELECT_COLUMNS = WRITABLE_FIELDS.map((field) => COLUMNS[field]).join(", ");

function requireCrmAccess(req: Request, res: Response, next: NextFunction) {
  void canAccessFeature(req, "crm")
    .then((allowed) => (allowed ? next() : res.status(403).json({ error: "Approved CRM access required" })))
    .catch(next);
}

function actor(req: Request): string {
  const auth = getAuth(req);
  return String(auth.sessionClaims?.email || req.dbUser?.id || "admin");
}

function csvBody(req: Request): { csv: string; fileName: string | null } {
  const csv = req.body?.csv;
  if (typeof csv !== "string" || !csv.trim()) throw new Error("A CSV file is required");
  if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) throw new Error("CSV files must be 8 MB or smaller");
  const fileName = typeof req.body?.fileName === "string" ? req.body.fileName.slice(0, 255) : null;
  return { csv, fileName };
}

function rowToExisting(row: Record<string, any>): ExistingContact {
  const existing: ExistingContact = { id: Number(row.id) };
  for (const field of WRITABLE_FIELDS) existing[field] = row[COLUMNS[field]] ?? null;
  return existing;
}

/**
 * Index of the contacts that any row in this file could match, looked up in a
 * single query. Phone digits are compared rather than the formatted strings so
 * "(512) 555-0101" and "+1 512-555-0101" resolve to the same person, which the
 * storage layer's exact-string `getCrmContactByPhoneOrEmail` cannot do.
 */
export type MatchIndex = { byEmail: Map<string, ExistingContact>; byPhone: Map<string, ExistingContact> };

export async function loadMatchIndex(rows: ContactParsedRow[]): Promise<MatchIndex> {
  const byEmail = new Map<string, ExistingContact>();
  const byPhone = new Map<string, ExistingContact>();

  const emails = [...new Set(rows.map((row) => row.emailKey).filter((key): key is string => key !== null))];
  const phones = [...new Set(rows.flatMap((row) => row.phoneKeys))];
  if (emails.length === 0 && phones.length === 0) return { byEmail, byPhone };

  const result = await pool.query(
    `SELECT id, ${SELECT_COLUMNS}
       FROM (
         SELECT id, ${SELECT_COLUMNS},
                lower(btrim(email)) AS email_key,
                regexp_replace(coalesce(mobile_phone, ''), '[^0-9]', '', 'g') AS mobile_digits,
                regexp_replace(coalesce(office_phone, ''), '[^0-9]', '', 'g') AS office_digits
           FROM crm_contacts
       ) candidates
      WHERE email_key = ANY($1::text[])
         OR (mobile_digits <> '' AND (mobile_digits = ANY($2::text[]) OR right(mobile_digits, 10) = ANY($2::text[])))
         OR (office_digits <> '' AND (office_digits = ANY($2::text[]) OR right(office_digits, 10) = ANY($2::text[])))`,
    [emails, phones],
  );

  for (const record of result.rows) {
    const existing = rowToExisting(record);
    // The first contact wins a key so repeated imports stay deterministic.
    const email = (existing.email ?? "").trim().toLowerCase();
    if (email && !byEmail.has(email)) byEmail.set(email, existing);
    for (const value of [existing.mobilePhone, existing.officePhone]) {
      const key = phoneKey(value ?? null);
      if (key && !byPhone.has(key)) byPhone.set(key, existing);
    }
  }
  return { byEmail, byPhone };
}

function findMatch(index: MatchIndex, row: ContactParsedRow): ExistingContact | undefined {
  if (row.emailKey) {
    const byEmail = index.byEmail.get(row.emailKey);
    if (byEmail) return byEmail;
  }
  for (const key of row.phoneKeys) {
    const byPhone = index.byPhone.get(key);
    if (byPhone) return byPhone;
  }
  return undefined;
}

/** Registers a newly written contact so later rows in the same file match it. */
function indexContact(index: MatchIndex, contact: ExistingContact) {
  const email = (contact.email ?? "").trim().toLowerCase();
  if (email) index.byEmail.set(email, contact);
  for (const value of [contact.mobilePhone, contact.officePhone]) {
    const key = phoneKey(value ?? null);
    if (key) index.byPhone.set(key, contact);
  }
}

function describePatch(patch: Partial<Record<WritableField, string>>): string {
  const labels = (Object.keys(patch) as WritableField[]).map((field) => FIELD_LABELS[field].toLowerCase());
  return `Fills ${labels.join(", ")}`;
}

/**
 * Decides what the import would do with every row, without writing anything.
 * The import endpoint replays the same decisions inside a transaction.
 */
export function planContactRows(rows: ContactParsedRow[], index: MatchIndex) {
  const duplicates = duplicateContactRowFlags(rows);
  return rows.map((row, position) => {
    if (row.issue) return { row, action: "skip" as ContactRowAction, detail: null, existing: undefined, patch: {} };
    if (duplicates[position]) {
      return { row, action: "skip" as ContactRowAction, detail: "Repeated in this file", existing: undefined, patch: {} };
    }
    const existing = findMatch(index, row);
    if (!existing) return { row, action: "create" as ContactRowAction, detail: null, existing, patch: {} };
    const patch = blankFillPatch(existing, row);
    return Object.keys(patch).length === 0
      ? { row, action: "unchanged" as ContactRowAction, detail: `Already matches ${existing.fullName ?? "an existing contact"}`, existing, patch }
      : { row, action: "enrich" as ContactRowAction, detail: describePatch(patch), existing, patch };
  });
}

export async function ensureContactImportIndexes() {
  // Keep these as ordinary column indexes. The matching query still normalizes
  // values in SQL, but function-based indexes are serialized incorrectly by
  // the publish schema-diff generator (regexp_replace arguments are truncated),
  // which would produce invalid production migration SQL.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS crm_contacts_email_key_idx
      ON crm_contacts (email);
    CREATE INDEX IF NOT EXISTS crm_contacts_mobile_digits_idx
      ON crm_contacts (mobile_phone);
    CREATE INDEX IF NOT EXISTS crm_contacts_office_digits_idx
      ON crm_contacts (office_phone);
  `);
}

/**
 * Writes the planned rows. Creating and blank-filling are both done here so the
 * preview endpoint and the import endpoint cannot drift apart, and so the
 * behaviour can be exercised against a real database in the integration test.
 *
 * Rows are re-resolved against the live index as it goes: an earlier row in the
 * same file may have created or filled the very contact a later row refers to.
 */
export async function applyContactImport(
  client: QueryRunner,
  planned: PlannedContactRow[],
  index: MatchIndex,
): Promise<ContactImportTotals> {
  const totals: ContactImportTotals = { created: 0, enriched: 0, unchanged: 0 };

  for (const entry of planned) {
    if (entry.action === "skip") continue;

    const existing = findMatch(index, entry.row);

    if (!existing) {
      const fields = WRITABLE_FIELDS.filter(
        (field) => entry.row[field] !== null && entry.row[field] !== "",
      );
      const result = await client.query(
        `INSERT INTO crm_contacts (${fields.map((field) => COLUMNS[field]).join(", ")})
         VALUES (${fields.map((_, position) => `$${position + 1}`).join(", ")})
         RETURNING id, ${SELECT_COLUMNS}`,
        fields.map((field) => entry.row[field]),
      );
      indexContact(index, rowToExisting(result.rows[0]));
      totals.created += 1;
      continue;
    }

    const patch = blankFillPatch(existing, entry.row);
    if (Object.keys(patch).length === 0) {
      totals.unchanged += 1;
      continue;
    }

    const fields = Object.keys(patch) as WritableField[];
    const result = await client.query(
      `UPDATE crm_contacts
          SET ${fields.map((field, position) => `${COLUMNS[field]} = $${position + 2}`).join(", ")},
              updated_at = now()
        WHERE id = $1
        RETURNING id, ${SELECT_COLUMNS}`,
      [existing.id, ...fields.map((field) => patch[field])],
    );
    if (result.rows[0]) indexContact(index, rowToExisting(result.rows[0]));
    totals.enriched += 1;
  }

  return totals;
}

export function registerContactImportRoutes(
  app: Express,
  options: { authMiddleware?: RequestHandler } = {},
) {
  const guarded = [options.authMiddleware ?? requireAuth, requireCrmAccess, requireStaffAdministrator];

  app.post("/api/contact-import/preview", ...guarded, async (req, res) => {
    try {
      const { csv } = csvBody(req);
      const parsed = parseContactCsv(csv);
      const index = await loadMatchIndex(parsed.rows);
      const planned = planContactRows(parsed.rows, index);

      const counts = {
        create: planned.filter((entry) => entry.action === "create").length,
        enrich: planned.filter((entry) => entry.action === "enrich").length,
        unchanged: planned.filter((entry) => entry.action === "unchanged").length,
        skip: planned.filter((entry) => entry.action === "skip").length,
      };

      const warnings = [...parsed.warnings];
      if (counts.enrich > 0) {
        warnings.push(
          `${counts.enrich} existing contact${counts.enrich === 1 ? "" : "s"} will have blank fields filled in. Details already in the CRM are never overwritten.`,
        );
      }
      if (counts.unchanged > 0) {
        warnings.push(`${counts.unchanged} row${counts.unchanged === 1 ? "" : "s"} already match a contact with nothing new to add.`);
      }

      res.json({
        source: parsed.source,
        sourceLabel: parsed.sourceLabel,
        mappings: parsed.mappings,
        unmappedColumns: parsed.unmappedColumns,
        headers: [...PREVIEW_HEADERS],
        rows: planned.map((entry) => previewContactRow(entry.row, entry.action, entry.detail ?? undefined)),
        errors: parsed.errors,
        warnings,
        counts,
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message || "Unable to preview the contact CSV" });
    }
  });

  app.post("/api/contact-import/import", ...guarded, async (req, res) => {
    const client = await pool.connect();
    try {
      const { csv, fileName } = csvBody(req);
      const parsed = parseContactCsv(csv);
      // Validate the selection before looking up contacts or starting writes.
      selectContactRows(parsed.rows, req.body?.selectedRows);
      const index = await loadMatchIndex(parsed.rows);
      const planned = selectContactRows(planContactRows(parsed.rows, index), req.body?.selectedRows);

      const errors = req.body?.selectedRows === undefined || parsed.rows.length === 0
        ? [...parsed.errors]
        : planned.flatMap((entry) => entry.row.issue ? [entry.row.issue] : []).slice(0, 25);

      await client.query("BEGIN");
      const totals = await applyContactImport(client, planned, index);
      await client.query("COMMIT");

      console.log(
        `Contact import from ${fileName ?? "an uploaded CSV"} (${parsed.sourceLabel}) by ${actor(req)}: ` +
          `${totals.created} created, ${totals.enriched} enriched, ${totals.unchanged} unchanged`,
      );

      res.json({
        source: parsed.source,
        sourceLabel: parsed.sourceLabel,
        created: totals.created,
        enriched: totals.enriched,
        unchanged: totals.unchanged,
        skipped: planned.filter((entry) => entry.action === "skip").length,
        errors,
      });
    } catch (error: any) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: error.message || "Unable to import the contact CSV" });
    } finally {
      client.release();
    }
  });
}
