/**
 * Universal contact CSV normalizer.
 *
 * Google Contacts, Outlook/Microsoft 365, and PayPal all export people with
 * completely different column headers, so this module maps whatever headers a
 * file actually contains onto the `crm_contacts` columns the CRM already uses.
 *
 * It deliberately targets the existing contact model rather than the more
 * common `first_name`/`last_name` shape: `crm_contacts.full_name` is NOT NULL
 * and there is no unique index on `email`, so names are *joined* on the way in
 * and matching is done on email-or-phone (the same identity rule the Google
 * People sync in routes.ts uses) instead of a database upsert.
 */
import { cleanHeader, parseCsvRecords } from "./csv-records";
import { toValidE164 } from "./phone-validation";

const MAX_ROWS = 10_000;

export type ContactSource = "google" | "outlook" | "paypal" | "generic";

export type ContactField =
  | "fullName"
  | "firstName"
  | "lastName"
  | "email"
  | "mobilePhone"
  | "officePhone"
  | "company"
  | "address"
  | "city"
  | "state"
  | "zipCode"
  | "notes";

/**
 * Header aliases, highest priority first. A column is claimed by at most one
 * field, so listing "Mobile Phone" before "Phone" keeps an Outlook export from
 * putting the business line in the mobile column.
 */
const HEADER_ALIASES: Record<ContactField, string[]> = {
  firstName: ["First Name", "Given Name", "FirstName", "First", "Buyer First Name"],
  lastName: ["Last Name", "Family Name", "LastName", "Last", "Buyer Last Name"],
  fullName: ["Full Name", "Display Name", "Contact Name", "Name", "File As", "Buyer Name"],
  email: [
    "E-mail Address",
    "E-mail 1 - Value",
    "Email Address",
    "Email 1 - Value",
    "Primary Email",
    "Email",
    "E-mail",
    "From Email Address",
    "Buyer Email",
  ],
  mobilePhone: [
    "Mobile Phone",
    "Mobile Number",
    "Mobile",
    "Cell Phone",
    "Phone 1 - Value",
    "Contact Phone Number",
    "Primary Phone",
    "Home Phone",
    "Phone Number",
    "Phone",
  ],
  officePhone: [
    "Business Phone",
    "Work Phone",
    "Office Phone",
    "Company Main Phone",
    "Phone 2 - Value",
  ],
  company: [
    "Company",
    "Organization 1 - Name",
    "Organization Name",
    "Business Name",
    "Organization",
  ],
  address: [
    "Business Street",
    "Address 1 - Street",
    "Shipping Address Line 1",
    "Home Street",
    "Address Line 1",
    "Street",
    "Address",
  ],
  city: ["Business City", "Address 1 - City", "Shipping City", "Home City", "City"],
  state: [
    "Business State",
    "Address 1 - Region",
    "Shipping State",
    "Home State",
    "State/Province",
    "State",
  ],
  zipCode: [
    "Business Postal Code",
    "Address 1 - Postal Code",
    "Shipping Zip Code",
    "Shipping Postal Code",
    "Home Postal Code",
    "Postal Code",
    "Zip Code",
    "Zip",
  ],
  notes: ["Notes", "Note", "Comments"],
};

const FIELD_ORDER = Object.keys(HEADER_ALIASES) as ContactField[];

/** Human labels for the mapping table the import screen shows. */
export const FIELD_LABELS: Record<ContactField, string> = {
  fullName: "Full name",
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  mobilePhone: "Mobile phone",
  officePhone: "Office phone",
  company: "Company",
  address: "Address",
  city: "City",
  state: "State",
  zipCode: "ZIP code",
  notes: "Notes",
};

const SOURCE_LABELS: Record<ContactSource, string> = {
  google: "Google Contacts",
  outlook: "Outlook / Microsoft 365",
  paypal: "PayPal",
  generic: "Generic CSV",
};

export type ContactFieldMapping = { column: string; field: ContactField; label: string };

export type ContactParsedRow = {
  fullName: string;
  email: string | null;
  mobilePhone: string | null;
  officePhone: string | null;
  company: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  notes: string | null;
  /** Lowercased email used for matching, when the address is usable. */
  emailKey: string | null;
  /** Digit-only phone keys (mobile and office) used for matching. */
  phoneKeys: string[];
  /** Identity of this row within the file. */
  dedupeKey: string;
  issue?: string;
};

export type ContactParseResult = {
  source: ContactSource;
  sourceLabel: string;
  mappings: ContactFieldMapping[];
  unmappedColumns: string[];
  rows: ContactParsedRow[];
  errors: string[];
  warnings: string[];
};

/** Collapses a header to a comparable form: "E-mail 1 - Value" -> "email1value". */
function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function collapse(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Keeps only digits, trimming a US country code so formats still match. */
export function phoneKey(value: string | null): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return local.length >= 7 ? local : null;
}

/** Lowercases an address and confirms it is shaped like an email. */
export function emailKey(value: string | null): string | null {
  const email = (value ?? "").trim().toLowerCase();
  return /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/.test(email) ? email : null;
}

export function detectContactSource(headers: string[]): ContactSource {
  const normalized = new Set(headers.map(normalizeHeader));
  if (
    normalized.has("fromemailaddress") ||
    normalized.has("contactphonenumber") ||
    normalized.has("shippingaddressline1")
  ) {
    return "paypal";
  }
  if (
    normalized.has("givenname") ||
    normalized.has("familyname") ||
    headers.some((header) => /\b\d+\s*-\s*value$/i.test(header.trim()))
  ) {
    return "google";
  }
  if (
    normalized.has("emailaddress") ||
    normalized.has("businessstreet") ||
    normalized.has("businessphone")
  ) {
    return "outlook";
  }
  return "generic";
}

/**
 * Matches the file's headers against {@link HEADER_ALIASES}. Each column is
 * claimed once, and each field takes its highest-priority available column.
 */
export function mapContactHeaders(headers: string[]): {
  columnFor: Partial<Record<ContactField, number>>;
  mappings: ContactFieldMapping[];
  unmappedColumns: string[];
} {
  const claimed = new Set<number>();
  const columnFor: Partial<Record<ContactField, number>> = {};
  const mappings: ContactFieldMapping[] = [];

  for (const field of FIELD_ORDER) {
    for (const alias of HEADER_ALIASES[field]) {
      const target = normalizeHeader(alias);
      const index = headers.findIndex(
        (header, position) => !claimed.has(position) && normalizeHeader(header) === target,
      );
      if (index >= 0) {
        claimed.add(index);
        columnFor[field] = index;
        mappings.push({ column: headers[index], field, label: FIELD_LABELS[field] });
        break;
      }
    }
  }

  const unmappedColumns = headers.filter(
    (header, index) => !claimed.has(index) && header.trim() !== "",
  );
  return { columnFor, mappings, unmappedColumns };
}

function emptyResult(source: ContactSource, errors: string[]): ContactParseResult {
  return {
    source,
    sourceLabel: SOURCE_LABELS[source],
    mappings: [],
    unmappedColumns: [],
    rows: [],
    errors,
    warnings: [],
  };
}

export function parseContactCsv(csv: string): ContactParseResult {
  if (!csv.trim()) return emptyResult("generic", ["The CSV file is empty."]);

  const records = parseCsvRecords(csv);
  if (records.length < 2) {
    return emptyResult("generic", [
      "The CSV must include a header row and at least one contact row.",
    ]);
  }

  const headers = records[0].map(cleanHeader);
  const source = detectContactSource(headers);
  const { columnFor, mappings, unmappedColumns } = mapContactHeaders(headers);

  const hasName = columnFor.fullName !== undefined || columnFor.firstName !== undefined;
  const hasContactMethod =
    columnFor.email !== undefined ||
    columnFor.mobilePhone !== undefined ||
    columnFor.officePhone !== undefined;

  if (!hasName || !hasContactMethod) {
    const missing = [
      !hasName ? "a name column (Name, Full Name, or First Name)" : null,
      !hasContactMethod ? "an email or phone column" : null,
    ].filter(Boolean);
    return {
      ...emptyResult(source, [
        `This file does not look like a contact export. It is missing ${missing.join(" and ")}.`,
      ]),
      mappings,
      unmappedColumns,
    };
  }

  if (records.length - 1 > MAX_ROWS) {
    return {
      ...emptyResult(source, [
        `The file contains more than ${MAX_ROWS.toLocaleString()} rows. Split the export into smaller files and try again.`,
      ]),
      mappings,
      unmappedColumns,
    };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const rows: ContactParsedRow[] = [];

  const typeIndex = headers.findIndex((header) => normalizeHeader(header) === "type");
  let ignoredNonPayments = 0;

  const at = (record: string[], field: ContactField): string => {
    const index = columnFor[field];
    return index === undefined ? "" : collapse(record[index]);
  };

  for (const [rowIndex, record] of records.slice(1).entries()) {
    // A PayPal transaction export lists every ledger movement. Only money
    // coming in from a customer identifies someone worth adding to the CRM.
    if (source === "paypal" && typeIndex >= 0) {
      const type = collapse(record[typeIndex]);
      if (!/payment|order/i.test(type)) {
        ignoredNonPayments += 1;
        continue;
      }
    }

    const first = at(record, "firstName");
    const last = at(record, "lastName");
    const joined = collapse(`${first} ${last}`);
    const fullName = at(record, "fullName") || joined;

    const email = at(record, "email") || null;
    const mobilePhone = at(record, "mobilePhone") || null;
    const officePhone = at(record, "officePhone") || null;

    const normalizedEmail = emailKey(email);
    const validMobilePhone = mobilePhone ? toValidE164(mobilePhone) !== null : false;
    const validOfficePhone = officePhone ? toValidE164(officePhone) !== null : false;
    const phoneKeys = [
      validMobilePhone ? phoneKey(mobilePhone) : null,
      validOfficePhone ? phoneKey(officePhone) : null,
    ].filter(
      (key): key is string => key !== null,
    );

    const dedupeKey = normalizedEmail
      ? `email:${normalizedEmail}`
      : phoneKeys[0]
        ? `phone:${phoneKeys[0]}`
        : `name:${fullName.toLowerCase()}`;

    const row: ContactParsedRow = {
      fullName,
      email: normalizedEmail ?? email,
      mobilePhone,
      officePhone,
      company: at(record, "company") || null,
      address: at(record, "address") || null,
      city: at(record, "city") || null,
      state: at(record, "state") || null,
      zipCode: at(record, "zipCode") || null,
      notes: at(record, "notes") || null,
      emailKey: normalizedEmail,
      phoneKeys: [...new Set(phoneKeys)],
      dedupeKey,
    };

    const issues: string[] = [];
    if (!fullName) issues.push("Name is blank");
    if (email && !normalizedEmail) issues.push("Email is invalid");
    if (mobilePhone && !validMobilePhone) issues.push("Mobile phone is invalid");
    if (officePhone && !validOfficePhone) issues.push("Office phone is invalid");
    if (!normalizedEmail && phoneKeys.length === 0) {
      issues.push("No email or phone number to match on");
    }

    if (issues.length > 0) {
      row.issue = `Row ${rowIndex + 2}: ${issues.join("; ")}.`;
      if (errors.length < 25) errors.push(row.issue);
    }
    rows.push(row);
  }

  if (ignoredNonPayments > 0) {
    warnings.push(
      `${ignoredNonPayments} PayPal row${ignoredNonPayments === 1 ? "" : "s"} were not customer payments or orders and were ignored.`,
    );
  }
  if (rows.length === 0 && errors.length === 0) {
    errors.push("The CSV did not contain any contact rows.");
  }
  if (unmappedColumns.length > 0) {
    warnings.push(
      `${unmappedColumns.length} column${unmappedColumns.length === 1 ? "" : "s"} in this file do not map to a CRM contact field and will be ignored.`,
    );
  }
  if (columnFor.email === undefined) {
    warnings.push(
      "This file has no email column, so contacts will be matched by phone number only.",
    );
  }

  return { source, sourceLabel: SOURCE_LABELS[source], mappings, unmappedColumns, rows, errors, warnings };
}

/** Flags rows repeated inside a single file, keeping the first occurrence. */
export function duplicateContactRowFlags(rows: ContactParsedRow[]): boolean[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const duplicate = seen.has(row.dedupeKey);
    seen.add(row.dedupeKey);
    return duplicate;
  });
}

/** What the import will do with a row. */
export type ContactRowAction = "create" | "enrich" | "unchanged" | "skip";

/**
 * Selection uses the zero-based positions returned by the preview, not physical
 * CSV line numbers (quoted records and ignored PayPal movements can span lines).
 * Keep file order and the full-file validation/deduplication decisions.
 */
export function selectContactRows<T>(rows: T[], selectedRows: unknown): T[] {
  if (selectedRows === undefined) return rows;
  if (
    !Array.isArray(selectedRows) ||
    selectedRows.length > rows.length ||
    selectedRows.some((position) =>
      typeof position !== "number" || !Number.isInteger(position) ||
      position < 0 || position >= rows.length,
    ) ||
    new Set(selectedRows).size !== selectedRows.length
  ) {
    throw new Error("Selected contacts must be unique, valid preview row numbers. Preview the file again.");
  }
  const selected = new Set(selectedRows);
  return rows.filter((_, position) => selected.has(position));
}

export const ACTION_LABELS: Record<ContactRowAction, string> = {
  create: "Add new contact",
  enrich: "Fill blank fields",
  unchanged: "Already up to date",
  skip: "Skip",
};

/** Contact columns the importer is allowed to write. */
export const WRITABLE_FIELDS = [
  "fullName",
  "email",
  "mobilePhone",
  "officePhone",
  "company",
  "address",
  "city",
  "state",
  "zipCode",
  "notes",
] as const;

export type WritableField = (typeof WRITABLE_FIELDS)[number];

export type ExistingContact = { id: number } & Partial<Record<WritableField, string | null>>;

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || String(value).trim() === "";
}

/**
 * Builds the set of columns to write for an existing contact. Only fields that
 * are currently blank are filled, so data a person typed into the CRM is never
 * replaced by a spreadsheet.
 */
export function blankFillPatch(
  existing: ExistingContact,
  row: ContactParsedRow,
): Partial<Record<WritableField, string>> {
  const patch: Partial<Record<WritableField, string>> = {};
  for (const field of WRITABLE_FIELDS) {
    // full_name is NOT NULL and always populated on an existing contact.
    if (field === "fullName") continue;
    const incoming = row[field];
    if (!isBlank(incoming) && isBlank(existing[field])) {
      patch[field] = String(incoming).trim();
    }
  }
  return patch;
}

/** Shapes one row for the review table on the import screen. */
export function previewContactRow(
  row: ContactParsedRow,
  action: ContactRowAction,
  detail?: string,
) {
  return {
    full_name: row.fullName,
    email: row.email,
    mobile_phone: row.mobilePhone,
    office_phone: row.officePhone,
    company: row.company,
    address: row.address,
    city: row.city,
    state: row.state,
    zip_code: row.zipCode,
    action,
    action_label: ACTION_LABELS[action],
    detail: detail ?? null,
    issue: row.issue ?? null,
    valid: !row.issue && action !== "skip",
  };
}

export const PREVIEW_HEADERS = [
  "full_name",
  "email",
  "mobile_phone",
  "office_phone",
  "company",
  "address",
  "city",
  "state",
  "zip_code",
] as const;
