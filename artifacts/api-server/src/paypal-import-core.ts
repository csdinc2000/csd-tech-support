import { createHash } from "node:crypto";
import { cleanHeader, parseCsvRecords } from "./csv-records";

const MAX_ROWS = 10_000;
const REQUIRED_HEADERS = ["Date", "Type", "Name", "Currency", "Net"];

export type PayPalParsedRow = {
  sourceTransactionId: string | null;
  dedupeKey: string;
  legacyDedupeKey: string | null;
  transactionDate: string | null;
  transactionType: string;
  clientName: string;
  amountCents: number | null;
  currency: string;
  netAmountCents: number | null;
  status: string | null;
  issue?: string;
};

export type PayPalParseResult = {
  headers: string[];
  rows: PayPalParsedRow[];
  errors: string[];
  warnings: string[];
};

function parseMoney(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const normalized = value.trim().replace(/[$,\s]/g, "");
  const negative = normalized.startsWith("(") && normalized.endsWith(")");
  const numeric = Number(negative ? normalized.slice(1, -1) : normalized);
  return Number.isFinite(numeric) ? Math.round((negative ? -numeric : numeric) * 100) : null;
}

function parseDate(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const source = value.trim();
  const usDate = source.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(.*)$/);
  const normalized = usDate
    ? `${usDate[3]}-${usDate[1].padStart(2, "0")}-${usDate[2].padStart(2, "0")}${usDate[4]}`
    : source;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function fingerprint(row: Pick<PayPalParsedRow, "sourceTransactionId" | "transactionDate" | "transactionType" | "clientName" | "amountCents" | "currency" | "netAmountCents">): string {
  const identity = [
    row.sourceTransactionId ?? "",
    row.transactionDate ?? "",
    row.transactionType,
    row.clientName,
    row.amountCents ?? "",
    row.currency,
    row.netAmountCents ?? "",
  ].join("|").toLowerCase();
  return createHash("sha256").update(identity).digest("hex");
}

function legacyFingerprint(sourceTransactionId: string | null): string | null {
  return sourceTransactionId
    ? createHash("sha256").update(`transaction:${sourceTransactionId}`).digest("hex")
    : null;
}

export function parsePayPalCsv(csv: string): PayPalParseResult {
  if (!csv.trim()) return { headers: [], rows: [], errors: ["The CSV file is empty."], warnings: [] };
  const records = parseCsvRecords(csv);
  if (records.length < 2) return { headers: [], rows: [], errors: ["The CSV must include a header row and at least one transaction row."], warnings: [] };

  const headers = records[0].map(cleanHeader);
  const headerIndexes = new Map(headers.map((header, index) => [header.toLowerCase(), index]));
  const missing = REQUIRED_HEADERS.filter((header) => !headerIndexes.has(header.toLowerCase()));
  const amountHeader = headers.find((header) => ["amount", "gross"].includes(header.toLowerCase()));
  if (!amountHeader) missing.push("Amount or Gross");
  if (missing.length > 0) {
    return {
      headers,
      rows: [],
      errors: [`This does not look like a PayPal transaction export. Missing column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`],
      warnings: [],
    };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const rows: PayPalParsedRow[] = [];
  const valueAt = (record: string[], name: string) => record[headerIndexes.get(name.toLowerCase()) ?? -1]?.trim() ?? "";
  const optionalValue = (record: string[], names: string[]) => {
    const header = headers.find((candidate) => names.includes(candidate.toLowerCase()));
    return header ? valueAt(record, header) : "";
  };

  if (records.length - 1 > MAX_ROWS) {
    return {
      headers,
      rows: [],
      errors: [`The file contains more than ${MAX_ROWS.toLocaleString()} rows. Export a smaller date range and try again.`],
      warnings,
    };
  }
  for (const [rowIndex, record] of records.slice(1, MAX_ROWS + 1).entries()) {
    const sourceTransactionId = optionalValue(record, ["transaction id", "transaction_id", "id"]) || null;
    const transactionDate = parseDate(valueAt(record, "Date"));
    const transactionType = valueAt(record, "Type");
    const clientName = valueAt(record, "Name");
    const amountCents = parseMoney(valueAt(record, amountHeader!));
    const currency = valueAt(record, "Currency").toUpperCase();
    const netAmountCents = parseMoney(valueAt(record, "Net"));
    const row: PayPalParsedRow = {
      sourceTransactionId,
      dedupeKey: "",
      legacyDedupeKey: legacyFingerprint(sourceTransactionId),
      transactionDate,
      transactionType,
      clientName,
      amountCents,
      currency,
      netAmountCents,
      status: optionalValue(record, ["status"]) || null,
    };
    const issues: string[] = [];
    const rawDate = valueAt(record, "Date");
    const rawNet = valueAt(record, "Net");
    if (rawDate && !transactionDate) issues.push("Date is invalid");
    if (!transactionType) issues.push("Type is blank");
    if (!clientName) issues.push("Name is blank");
    if (amountCents === null) issues.push("Amount/Gross is invalid");
    if (!/^[A-Z]{3}$/.test(currency)) issues.push("Currency is invalid");
    if (rawNet && netAmountCents === null) issues.push("Net is invalid");
    row.dedupeKey = fingerprint(row);
    if (issues.length > 0) {
      row.issue = `Row ${rowIndex + 2}: ${issues.join("; ")}.`;
      if (errors.length < 25) errors.push(row.issue);
    }
    rows.push(row);
  }
  if (rows.length === 0 && errors.length === 0) errors.push("The CSV did not contain transaction rows.");
  if (rows.some((row) => !row.sourceTransactionId)) warnings.push("Some rows do not include a Transaction ID, so duplicates are detected using their date, type, name, and amounts.");
  if (rows.some((row) => !row.transactionDate || row.netAmountCents === null)) {
    warnings.push("Translated PayPal invoice rows may omit a transaction date or net amount. Those blank values will be preserved.");
  }
  return { headers, rows, errors, warnings };
}

export function previewRow(row: PayPalParsedRow, duplicate = false) {
  return {
    transaction_date: row.transactionDate,
    transaction_type: row.transactionType,
    client_name: row.clientName,
    amount: row.amountCents === null ? null : (row.amountCents / 100).toFixed(2),
    currency: row.currency,
    net_amount: row.netAmountCents === null ? null : (row.netAmountCents / 100).toFixed(2),
    source_transaction_id: row.sourceTransactionId,
    status: row.status,
    issue: duplicate ? "Already imported" : row.issue ?? null,
    valid: !row.issue && !duplicate,
  };
}

export function duplicatePayPalRowFlags(rows: PayPalParsedRow[], existingKeys: ReadonlySet<string>): boolean[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const duplicate =
      existingKeys.has(row.dedupeKey) ||
      (row.legacyDedupeKey !== null && existingKeys.has(row.legacyDedupeKey)) ||
      seen.has(row.dedupeKey);
    seen.add(row.dedupeKey);
    return duplicate;
  });
}