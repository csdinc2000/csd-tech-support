import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import { createServer, type Server } from "node:http";
import { pool } from "./db";
import { parsePayPalCsv } from "./paypal-import-core";
import { ensurePayPalImportSchema, registerPayPalImportRoutes } from "./paypal-import";

const marker = `paypal-route-${process.pid}-${Date.now()}`;
const ownerId = `${marker}-owner`;
const ownerEmail = `${marker}@example.invalid`;
const translatedSourceId = `${marker}-invoice`;
const legacySourceId = `${marker}-legacy`;
const concurrentSourceIds = [`${marker}-concurrent-1`, `${marker}-concurrent-2`];
const mixedSourceIds = [`${marker}-mixed-valid`, `${marker}-mixed-invalid`];
const translatedCsv = [
  "Date,Type,Name,Amount,Currency,Net,Transaction ID,Status",
  `,Invoice Sent,${marker},187.25,USD,,${translatedSourceId},Paid`,
  `,Shopping Cart Item,${marker},55.00,USD,,${translatedSourceId},Paid`,
  `,Shopping Cart Item,${marker},120.00,USD,,${translatedSourceId},Paid`,
].join("\n");
const legacyCsv = [
  "Date,Type,Name,Amount,Currency,Net,Transaction ID,Status",
  `2026-09-08,Payment Received,${marker},25.00,USD,24.00,${legacySourceId},Completed`,
].join("\n");
const concurrentCsv = [
  "Date,Type,Name,Amount,Currency,Net,Transaction ID,Status",
  `2026-09-09,Payment Received,${marker},40.00,USD,38.50,${concurrentSourceIds[0]},Completed`,
  `2026-09-10,Payment Received,${marker},65.00,USD,62.75,${concurrentSourceIds[1]},Completed`,
].join("\n");
const mixedCsv = [
  "Date,Type,Name,Amount,Currency,Net,Transaction ID,Status",
  `2026-09-11,Payment Received,${marker},75.00,USD,72.50,${mixedSourceIds[0]},Completed`,
  `2026-09-12,Payment Received,${marker},not-money,USD,19.00,${mixedSourceIds[1]},Completed`,
].join("\n");

let previousAdminEmails: string | undefined;
let server: Server;
let baseUrl = "";

function post(path: string, csv: string) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csv, fileName: `${marker}.csv` }),
  });
}

before(async () => {
  previousAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = ownerEmail;
  await ensurePayPalImportSchema();
  await pool.query(
    `INSERT INTO auth_users(id,email,first_name,last_name)
     VALUES($1,$2,'PayPal','Route Test')
     ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email`,
    [ownerId, ownerEmail],
  );
  await pool.query(
    `INSERT INTO staff_access_profiles(user_id,role,approval_status,feature_permissions)
     VALUES($1,'accounting','approved',$2::jsonb)
     ON CONFLICT(user_id) DO UPDATE SET
       role=EXCLUDED.role,
       approval_status=EXCLUDED.approval_status,
       feature_permissions=EXCLUDED.feature_permissions`,
    [ownerId, JSON.stringify({ invoices: true })],
  );

  const app = express();
  app.use(express.json());
  registerPayPalImportRoutes(app, (req, _res, next) => {
    req.dbUser = {
      id: ownerId,
      email: ownerEmail,
      firstName: "PayPal",
      lastName: "Route Test",
      profileImageUrl: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    next();
  });
  server = createServer(app);
  server.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
  await pool.query(
    "DELETE FROM paypal_transactions WHERE source_transaction_id = ANY($1::text[])",
    [[translatedSourceId, legacySourceId, ...concurrentSourceIds, ...mixedSourceIds]],
  );
  await pool.query("DELETE FROM staff_access_profiles WHERE user_id=$1", [ownerId]);
  await pool.query("DELETE FROM auth_users WHERE id=$1", [ownerId]);
  if (previousAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = previousAdminEmails;
});

test("translated invoice rows import safely and remain idempotent with legacy dedupe keys", async () => {
  const previewResponse = await post("/api/paypal-import/preview", translatedCsv);
  assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
  const preview = await previewResponse.json() as any;
  assert.equal(preview.rows.length, 3);
  assert.equal(preview.duplicateCount, 0);
  assert.equal(preview.rows.every((row: any) =>
    row.valid === true &&
    row.transaction_date === null &&
    row.net_amount === null
  ), true);

  const importResponse = await post("/api/paypal-import/import", translatedCsv);
  assert.equal(importResponse.status, 200, await importResponse.clone().text());
  assert.deepEqual(await importResponse.json(), {
    imported: 3,
    skipped: 0,
    errors: [],
    duplicateCount: 0,
  });

  const stored = await pool.query(
    `SELECT dedupe_key, transaction_date, net_amount_cents
       FROM paypal_transactions
      WHERE source_transaction_id=$1
      ORDER BY amount_cents`,
    [translatedSourceId],
  );
  assert.equal(stored.rows.length, 3);
  assert.equal(new Set(stored.rows.map((row) => row.dedupe_key)).size, 3);
  assert.equal(stored.rows.every((row) =>
    row.transaction_date === null && row.net_amount_cents === null
  ), true);

  const repeatResponse = await post("/api/paypal-import/import", translatedCsv);
  assert.equal(repeatResponse.status, 200, await repeatResponse.clone().text());
  assert.deepEqual(await repeatResponse.json(), {
    imported: 0,
    skipped: 3,
    errors: [],
    duplicateCount: 3,
  });

  const legacyRow = parsePayPalCsv(legacyCsv).rows[0];
  assert.ok(legacyRow.legacyDedupeKey);
  await pool.query(
    `INSERT INTO paypal_transactions
      (source_transaction_id,dedupe_key,transaction_date,transaction_type,client_name,
       amount_cents,currency,net_amount_cents,status,source_file_name,imported_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      legacyRow.sourceTransactionId,
      legacyRow.legacyDedupeKey,
      legacyRow.transactionDate,
      legacyRow.transactionType,
      legacyRow.clientName,
      legacyRow.amountCents,
      legacyRow.currency,
      legacyRow.netAmountCents,
      legacyRow.status,
      `${marker}-legacy.csv`,
      ownerId,
    ],
  );

  const legacyPreviewResponse = await post("/api/paypal-import/preview", legacyCsv);
  assert.equal(legacyPreviewResponse.status, 200, await legacyPreviewResponse.clone().text());
  const legacyPreview = await legacyPreviewResponse.json() as any;
  assert.equal(legacyPreview.duplicateCount, 1);
  assert.equal(legacyPreview.rows[0].valid, false);
  assert.equal(legacyPreview.rows[0].issue, "Already imported");

  const legacyImportResponse = await post("/api/paypal-import/import", legacyCsv);
  assert.equal(legacyImportResponse.status, 200, await legacyImportResponse.clone().text());
  assert.deepEqual(await legacyImportResponse.json(), {
    imported: 0,
    skipped: 1,
    errors: [],
    duplicateCount: 1,
  });
});

test("simultaneous uploads store each PayPal row once and report aggregate conflicts", async () => {
  const responses = await Promise.all([
    post("/api/paypal-import/import", concurrentCsv),
    post("/api/paypal-import/import", concurrentCsv),
  ]);

  const results = await Promise.all(responses.map(async (response) => {
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<{
      imported: number;
      skipped: number;
      errors: string[];
      duplicateCount: number;
    }>;
  }));

  assert.equal(results.reduce((sum, result) => sum + result.imported, 0), 2);
  assert.equal(results.reduce((sum, result) => sum + result.skipped, 0), 2);
  assert.equal(results.reduce((sum, result) => sum + result.duplicateCount, 0), 2);
  assert.deepEqual(results.flatMap((result) => result.errors), []);

  const stored = await pool.query(
    `SELECT source_transaction_id, count(*)::integer AS row_count
       FROM paypal_transactions
      WHERE source_transaction_id = ANY($1::text[])
      GROUP BY source_transaction_id
      ORDER BY source_transaction_id`,
    [concurrentSourceIds],
  );
  assert.deepEqual(stored.rows, concurrentSourceIds.map((sourceTransactionId) => ({
    source_transaction_id: sourceTransactionId,
    row_count: 1,
  })));
});

test("malformed PayPal rows are reported without blocking valid ledger entries", async () => {
  const importResponse = await post("/api/paypal-import/import", mixedCsv);
  assert.equal(importResponse.status, 200, await importResponse.clone().text());
  assert.deepEqual(await importResponse.json(), {
    imported: 1,
    skipped: 1,
    errors: ["Row 3: Amount/Gross is invalid."],
    duplicateCount: 0,
  });

  const stored = await pool.query(
    `SELECT source_transaction_id
       FROM paypal_transactions
      WHERE source_transaction_id = ANY($1::text[])
      ORDER BY source_transaction_id`,
    [mixedSourceIds],
  );
  assert.deepEqual(stored.rows, [{ source_transaction_id: mixedSourceIds[0] }]);

  const repeatResponse = await post("/api/paypal-import/import", mixedCsv);
  assert.equal(repeatResponse.status, 200, await repeatResponse.clone().text());
  assert.deepEqual(await repeatResponse.json(), {
    imported: 0,
    skipped: 2,
    errors: ["Row 3: Amount/Gross is invalid."],
    duplicateCount: 1,
  });

  const repeatedStored = await pool.query(
    `SELECT source_transaction_id, count(*)::integer AS row_count
       FROM paypal_transactions
      WHERE source_transaction_id = ANY($1::text[])
      GROUP BY source_transaction_id`,
    [mixedSourceIds],
  );
  assert.deepEqual(repeatedStored.rows, [{
    source_transaction_id: mixedSourceIds[0],
    row_count: 1,
  }]);
});