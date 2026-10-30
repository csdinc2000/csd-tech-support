import assert from "node:assert/strict";
import test from "node:test";
import {
  blankFillPatch,
  detectContactSource,
  duplicateContactRowFlags,
  mapContactHeaders,
  parseContactCsv,
  previewContactRow,
  selectContactRows,
} from "./contact-import-core";

test("maps a Google Contacts export, joining the split name", () => {
  const csv = [
    "Name,Given Name,Family Name,Organization 1 - Name,E-mail 1 - Value,Phone 1 - Value,Address 1 - Street,Address 1 - City,Address 1 - Region,Address 1 - Postal Code,Notes",
    ',Ada,Lovelace,Analytical Engines,ADA@example.com,(512) 555-0101,"12 Byron St",Austin,TX,78701,VIP',
  ].join("\n");

  const parsed = parseContactCsv(csv);
  assert.equal(parsed.source, "google");
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows.length, 1);
  const row = parsed.rows[0];
  assert.equal(row.fullName, "Ada Lovelace");
  assert.equal(row.email, "ada@example.com");
  assert.equal(row.mobilePhone, "(512) 555-0101");
  assert.deepEqual(row.phoneKeys, ["5125550101"]);
  assert.equal(row.company, "Analytical Engines");
  assert.equal(row.address, "12 Byron St");
  assert.equal(row.zipCode, "78701");
  assert.equal(row.notes, "VIP");
});

test("maps an Outlook export and keeps business and mobile lines apart", () => {
  const csv = [
    "First Name,Last Name,Company,E-mail Address,Mobile Phone,Business Phone,Business Street,Business City,Business State,Business Postal Code",
    "Grace,Hopper,US Navy,grace@example.com,555-222-3333,555-444-5555,1 Dock Rd,Arlington,VA,22202",
  ].join("\r\n");

  const parsed = parseContactCsv(csv);
  assert.equal(parsed.source, "outlook");
  const row = parsed.rows[0];
  assert.equal(row.fullName, "Grace Hopper");
  assert.equal(row.mobilePhone, "555-222-3333");
  assert.equal(row.officePhone, "555-444-5555");
  assert.equal(row.state, "VA");
});

test("maps a PayPal export and ignores rows that are not customer payments", () => {
  const csv = [
    "Date,Type,Name,From Email Address,Contact Phone Number,Shipping Address Line 1,Shipping City,Shipping State,Shipping Zip Code,Currency,Net",
    '09/08/2026,Payment Received,"Smith, Jane",jane@example.com,512-555-9000,9 Elm St,Dallas,TX,75201,USD,120.87',
    "09/08/2026,General Withdrawal,Bank Transfer,,,,,,,USD,-500.00",
    "09/09/2026,Website Order,Bob Jones,bob@example.com,,,,,,USD,42.00",
  ].join("\n");

  const parsed = parseContactCsv(csv);
  assert.equal(parsed.source, "paypal");
  assert.equal(parsed.rows.length, 2, "the withdrawal row should be dropped");
  assert.equal(parsed.rows[0].fullName, "Smith, Jane");
  assert.equal(parsed.rows[0].city, "Dallas");
  assert.equal(parsed.rows[1].fullName, "Bob Jones");
  assert.match(parsed.warnings.join(" "), /not customer payments or orders/);
});

test("strips a UTF-8 BOM so the first Microsoft header still maps", () => {
  const csv = "﻿First Name,Last Name,E-mail Address\nAlan,Turing,alan@example.com";
  const parsed = parseContactCsv(csv);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows[0].fullName, "Alan Turing");
  assert.equal(parsed.rows[0].email, "alan@example.com");
});

test("each column is claimed once, by its highest priority field", () => {
  const { mappings } = mapContactHeaders(["Name", "Full Name", "Phone", "Mobile Phone"]);
  const byField = new Map(mappings.map((entry) => [entry.field, entry.column]));
  assert.equal(byField.get("fullName"), "Full Name");
  assert.equal(byField.get("mobilePhone"), "Mobile Phone");
  // "Name" and "Phone" lost to higher-priority aliases and stay unclaimed
  // rather than overwriting the fields those aliases already filled.
  assert.equal(mappings.filter((entry) => entry.field === "fullName").length, 1);
});

test("rejects a file with no name column or no way to reach the person", () => {
  const noName = parseContactCsv("Email,Phone\na@example.com,555-000-1111");
  assert.equal(noName.rows.length, 0);
  assert.match(noName.errors[0], /name column/);

  const noContact = parseContactCsv("First Name,Last Name\nAda,Lovelace");
  assert.equal(noContact.rows.length, 0);
  assert.match(noContact.errors[0], /email or phone column/);
});

test("flags unusable rows without blocking the good ones", () => {
  const csv = [
    "Name,Email,Phone",
    "Valid Person,valid@example.com,555-123-4567",
    "Bad Email,not-an-email,",
    ",orphan@example.com,",
    "No Contact Details,,",
  ].join("\n");

  const parsed = parseContactCsv(csv);
  assert.equal(parsed.rows.length, 4);
  assert.equal(parsed.rows[0].issue, undefined);
  assert.match(parsed.rows[1].issue ?? "", /Email is invalid/);
  assert.match(parsed.rows[2].issue ?? "", /Name is blank/);
  assert.match(parsed.rows[3].issue ?? "", /No email or phone number/);
  assert.equal(previewContactRow(parsed.rows[0], "create").valid, true);
  assert.equal(previewContactRow(parsed.rows[3], "create").valid, false);
});

test("reports malformed mobile and office phone fields without changing valid formatting", () => {
  const csv = [
    "Name,Email,Mobile Phone,Office Phone",
    "Valid Person,valid@example.com,(512) 555-0101,+44 20 7123 4567",
    "Bad Mobile,bad-mobile@example.com,+44 20 CALL-NOW,512-555-0102",
    "Bad Office,bad-office@example.com,512-555-0103,+44++2071234567",
  ].join("\n");

  const parsed = parseContactCsv(csv);
  assert.equal(parsed.rows[0].mobilePhone, "(512) 555-0101");
  assert.equal(parsed.rows[0].officePhone, "+44 20 7123 4567");
  assert.equal(parsed.rows[0].issue, undefined);
  assert.match(parsed.rows[1].issue ?? "", /Mobile phone is invalid/);
  assert.match(parsed.rows[2].issue ?? "", /Office phone is invalid/);
  assert.equal(parsed.errors.length, 2);
});

test("treats differently formatted phone numbers as the same person", () => {
  const csv = [
    "Name,Phone",
    "Ada Lovelace,(512) 555-0101",
    "Ada L,+1 512-555-0101",
  ].join("\n");

  const rows = parseContactCsv(csv).rows;
  assert.equal(rows[0].dedupeKey, rows[1].dedupeKey);
  assert.deepEqual(duplicateContactRowFlags(rows), [false, true]);
});

test("deduplicates within a file on email regardless of case", () => {
  const csv = [
    "Name,Email",
    "Ada Lovelace,ada@example.com",
    "A. Lovelace,ADA@Example.com",
    "Grace Hopper,grace@example.com",
  ].join("\n");

  const rows = parseContactCsv(csv).rows;
  assert.deepEqual(duplicateContactRowFlags(rows), [false, true, false]);
});

test("blank fill only writes columns that are empty on the existing contact", () => {
  const row = parseContactCsv(
    ["Name,Email,Mobile Phone,City,Company", "Ada Lovelace,ada@example.com,555-111-2222,Austin,Analytical Engines"].join("\n"),
  ).rows[0];

  const patch = blankFillPatch(
    { id: 7, fullName: "Ada Lovelace", email: "ada@example.com", mobilePhone: "555-999-0000", city: null, company: "   " },
    row,
  );

  // Checked before deepEqual, which narrows `patch` to the expected shape.
  assert.equal(patch.mobilePhone, undefined, "an existing phone is never overwritten");
  assert.equal(patch.fullName, undefined, "full_name is never rewritten");
  assert.deepEqual(patch, { city: "Austin", company: "Analytical Engines" });
});

test("blank fill produces no patch when the CRM already has everything", () => {
  const row = parseContactCsv(["Name,Email", "Ada Lovelace,ada@example.com"].join("\n")).rows[0];
  const patch = blankFillPatch({ id: 7, fullName: "Ada Lovelace", email: "ada@example.com" }, row);
  assert.deepEqual(patch, {});
});

test("detects the source from headers alone", () => {
  assert.equal(detectContactSource(["Name", "From Email Address"]), "paypal");
  assert.equal(detectContactSource(["Given Name", "E-mail 1 - Value"]), "google");
  assert.equal(detectContactSource(["First Name", "E-mail Address"]), "outlook");
  assert.equal(detectContactSource(["Name", "Email", "Phone"]), "generic");
});

test("selects only requested preview rows in file order and never treats an empty selection as all rows", () => {
  const rows = ["first", "second", "third"];
  assert.deepEqual(selectContactRows(rows, [2, 0]), ["first", "third"]);
  assert.deepEqual(selectContactRows(rows, []), []);
  assert.deepEqual(selectContactRows(rows, undefined), rows, "legacy callers retain full-file imports");
});

test("rejects malformed, duplicate, and out-of-range preview selections", () => {
  for (const selection of [null, "0", {}, [0, 0], [-1], [2], [0.5], ["0"], [NaN]]) {
    assert.throws(() => selectContactRows(["first", "second"], selection), /Selected contacts/);
  }
});

test("preview selection follows parsed records after ignored PayPal rows and quoted multiline fields", () => {
  const parsed = parseContactCsv([
    "Type,Name,From Email Address,Notes",
    'Payment Received,"Ada\nLovelace",ada@example.com,"line one\nline two"',
    "General Withdrawal,Bank Transfer,,",
    "Payment Received,Grace Hopper,grace@example.com,",
  ].join("\n"));
  assert.equal(parsed.rows.length, 2);
  assert.equal(selectContactRows(parsed.rows, [1])[0].fullName, "Grace Hopper");
});
