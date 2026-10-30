/**
 * Exercises the contact importer against the real `crm_contacts` table.
 *
 * The property that matters most: importing the same export twice must not
 * duplicate anyone, and must never overwrite a detail already in the CRM.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { parseContactCsv } from "./contact-import-core.ts";
import {
  applyContactImport,
  loadMatchIndex,
  planContactRows,
} from "./contact-import.ts";
import { pool } from "./db.ts";

const marker = `contact-import-${process.pid}-${Date.now()}`;
const existingEmail = `existing-${marker}@example.com`;
const newEmail = `new-${marker}@example.com`;
const phoneOnlyDigits = `512555${String(process.pid).padStart(4, "0").slice(-4)}`;

const csv = [
  "First Name,Last Name,E-mail Address,Mobile Phone,Company,Business City,Business State,Business Postal Code",
  `Existing,Person,${existingEmail},555-000-1111,Filled By Import,Austin,TX,78701`,
  `Brand,New,${newEmail},555-222-3333,New Co,Dallas,TX,75201`,
  `Phone,Only,,${phoneOnlyDigits},Phone Co,Houston,TX,77002`,
].join("\n");

/** Runs one full import pass the way the route does. */
async function runImport() {
  const parsed = parseContactCsv(csv);
  assert.deepEqual(parsed.errors, [], "fixture CSV should parse cleanly");
  const index = await loadMatchIndex(parsed.rows);
  const planned = planContactRows(parsed.rows, index);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const totals = await applyContactImport(client, planned, index);
    await client.query("COMMIT");
    return totals;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function contactsForThisRun() {
  const result = await pool.query(
    `SELECT id, full_name, email, mobile_phone, company, city, state, zip_code
       FROM crm_contacts
      WHERE email = ANY($1::text[])
         OR regexp_replace(coalesce(mobile_phone, ''), '[^0-9]', '', 'g') = $2
      ORDER BY id`,
    [[existingEmail, newEmail], phoneOnlyDigits],
  );
  return result.rows;
}

after(async () => {
  await pool.query(
    `DELETE FROM crm_contacts
      WHERE email = ANY($1::text[])
         OR regexp_replace(coalesce(mobile_phone, ''), '[^0-9]', '', 'g') = $2`,
    [[existingEmail, newEmail], phoneOnlyDigits],
  );
  await pool.end();
});

test("fills blanks on a matched contact without overwriting existing details", async () => {
  // A contact a person already created by hand: it has a phone and a city the
  // spreadsheet disagrees with, and blank company/state/zip.
  await pool.query(
    `INSERT INTO crm_contacts (full_name, email, mobile_phone, city)
     VALUES ($1, $2, $3, $4)`,
    ["Existing Person", existingEmail, "555-999-8888", "Round Rock"],
  );

  const totals = await runImport();
  assert.equal(totals.created, 2, "the two unknown people are added");
  assert.equal(totals.enriched, 1, "the known person is filled in, not duplicated");

  const rows = await contactsForThisRun();
  assert.equal(rows.length, 3);

  const matched = rows.find((row) => row.email === existingEmail);
  assert.ok(matched);
  assert.equal(matched.full_name, "Existing Person", "name is not rewritten");
  assert.equal(matched.mobile_phone, "555-999-8888", "existing phone survives");
  assert.equal(matched.city, "Round Rock", "existing city survives");
  assert.equal(matched.company, "Filled By Import", "blank company is filled");
  assert.equal(matched.state, "TX", "blank state is filled");
  assert.equal(matched.zip_code, "78701", "blank ZIP is filled");

  const created = rows.find((row) => row.email === newEmail);
  assert.ok(created);
  assert.equal(created.full_name, "Brand New");
  assert.equal(created.city, "Dallas");
});

test("importing the same file again adds nobody and changes nothing", async () => {
  const before = await contactsForThisRun();

  const totals = await runImport();
  assert.equal(totals.created, 0, "no duplicates on a repeat import");
  assert.equal(totals.enriched, 0, "nothing left to fill");
  assert.equal(totals.unchanged, 3, "all three rows already match a contact");

  const after = await contactsForThisRun();
  assert.equal(after.length, before.length, "the contact count did not double");
  assert.deepEqual(after, before, "no column changed on a repeat import");
});

test("a contact with no email is matched by phone number alone", async () => {
  const rows = await contactsForThisRun();
  const phoneOnly = rows.find((row) => row.email === null);
  assert.ok(phoneOnly, "the row without an email was still imported");
  assert.equal(phoneOnly.full_name, "Phone Only");
  assert.equal(phoneOnly.company, "Phone Co");
});
