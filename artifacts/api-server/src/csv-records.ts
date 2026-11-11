/**
 * Shared CSV record splitter for the spreadsheet importers.
 *
 * Both the PayPal transaction importer and the contact importer have to cope
 * with the same realities of vendor exports: quoted fields containing commas,
 * doubled quotes, CRLF line endings, trailing blank lines, and a UTF-8 BOM in
 * front of the first header (Microsoft exports always include one).
 */

/** Splits raw CSV text into records, honouring quotes and skipping blank rows. */
export function parseCsvRecords(csv: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    const next = csv[index + 1];
    if (character === '"') {
      if (quoted && next === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      record.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      record.push(value);
      if (record.some((cell) => cell.trim() !== "")) records.push(record);
      record = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (value !== "" || record.length > 0) {
    record.push(value);
    if (record.some((cell) => cell.trim() !== "")) records.push(record);
  }
  return records;
}

/** Strips the UTF-8 BOM and surrounding whitespace from a header cell. */
export function cleanHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").trim();
}
