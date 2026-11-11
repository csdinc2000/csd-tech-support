/**
 * Reviews legacy hidden contacts and, with --apply, removes only those with no
 * foreign-key references.
 *
 * pnpm --filter @workspace/api-server run cleanup:contact-placeholders
 * pnpm --filter @workspace/api-server run cleanup:contact-placeholders -- --apply
 */
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import {
  removeUnreferencedDeletedContactPlaceholders,
  reviewDeletedContactPlaceholders,
} from "../src/contact-placeholder-cleanup.ts";

neonConfig.webSocketConstructor = ws;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const apply = process.argv.includes("--apply");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const result = apply
      ? await removeUnreferencedDeletedContactPlaceholders(client)
      : { reviewed: await reviewDeletedContactPlaceholders(client), removedIds: [] };

    console.log(`${apply ? "APPLY" : "DRY RUN"} — deleted-contact placeholder cleanup\n`);
    if (result.reviewed.length === 0) {
      console.log("No legacy deleted-contact placeholders found.");
      return;
    }

    console.table(result.reviewed.map((placeholder) => ({
      id: placeholder.id,
      name: placeholder.fullName,
      references: placeholder.totalReferences,
      decision: placeholder.totalReferences === 0 ? "remove" : "retain",
    })));
    for (const placeholder of result.reviewed.filter((row) => row.totalReferences > 0)) {
      console.log(`\nContact #${placeholder.id} retained:`);
      console.table(
        placeholder.references
          .filter((reference) => reference.count > 0)
          .map((reference) => ({
            relationship: `${reference.tableName}.${reference.columnName}`,
            rows: reference.count,
          })),
      );
    }

    if (apply) {
      console.log(`\nRemoved ${result.removedIds.length} unreferenced placeholder(s).`);
    } else {
      console.log("\nNo data written. Review the relationships, then re-run with --apply.");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Placeholder cleanup failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});