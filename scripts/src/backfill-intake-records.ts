/**
 * One-off backfill: reconstruct `csd_intake_records` rows for historical leads.
 *
 * Leads created before the intake route persisted a service-request row have
 * `intake_record_id IS NULL`, so the Intake Requests view cannot show them.
 * Every field the intake form captured still exists on the lead (service,
 * device, OS, problem, marketing answer) and on its contact (name, phone,
 * email), so the request row can be faithfully rebuilt from the pair.
 *
 * Leads with no contact are skipped: `customer_name`, `phone_number` and
 * `email_address` are NOT NULL and inventing them would fabricate customer
 * identity. Those requests stay visible as leads only.
 *
 * Idempotent — only touches leads that still have no intake record.
 *
 *   pnpm --filter @workspace/scripts run backfill-intake        # dry run
 *   pnpm --filter @workspace/scripts run backfill-intake -- --apply
 */
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const APPLY = process.argv.includes("--apply");

type Candidate = {
  lead_id: number;
  contact_id: number;
  full_name: string;
  mobile_phone: string | null;
  email: string | null;
  contact_preference: string | null;
  service_type: string;
  device_type: string | null;
  brand_model: string | null;
  operating_system: string | null;
  problem_description: string | null;
  source: string | null;
  campaign: string | null;
  status: string | null;
  created_at: Date;
};

// The old route wrote the customer's "how did you hear about us" answer into
// `source`. Anything already using a channel value carries no marketing answer.
const CHANNEL_VALUES = new Set(["website_intake", "phone_call", "walk_in"]);

function project(row: Candidate) {
  const fromActiveCall = row.campaign === "phone_call";
  const marketingAnswer = row.source && !CHANNEL_VALUES.has(row.source) ? row.source : "Not recorded";
  return {
    customerName: row.full_name.trim(),
    phoneNumber: row.mobile_phone?.trim() || "",
    emailAddress: row.email?.trim() || "",
    contactPreference: row.contact_preference?.trim() || "text_email",
    serviceType: row.service_type.trim(),
    // NOT NULL columns the lead may not have filled in.
    deviceType: row.device_type?.trim() || "Not recorded",
    deviceBrandModel: row.brand_model?.trim() || "",
    operatingSystem: row.operating_system?.trim() || "",
    problemDescription: row.problem_description?.trim() || "Not recorded",
    howDidYouHear: marketingAnswer,
    isFromActiveCall: fromActiveCall,
    source: fromActiveCall ? "phone_call" : "website_intake",
    status: row.status === "won" ? "completed" : row.status === "lost" ? "cancelled" : "new",
    createdAt: row.created_at,
  };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const { rows } = await client.query<Candidate>(
      `SELECT l.id AS lead_id, l.contact_id, c.full_name, c.mobile_phone, c.email,
              c.contact_preference, l.service_type, l.device_type, l.brand_model,
              l.operating_system, l.problem_description, l.source, l.campaign,
              l.status, l.created_at
       FROM crm_leads l
       JOIN crm_contacts c ON c.id = l.contact_id
       WHERE l.intake_record_id IS NULL
       ORDER BY l.id`,
    );

    const skipped = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM crm_leads WHERE intake_record_id IS NULL AND contact_id IS NULL`,
    );

    console.log(`${APPLY ? "APPLY" : "DRY RUN"} — reconstructing intake records from leads\n`);
    console.log(`Backfillable (lead has a contact): ${rows.length}`);
    console.log(`Skipped (lead has no contact, identity unrecoverable): ${skipped.rows[0].n}\n`);

    if (!rows.length) {
      console.log("Nothing to do.");
      return;
    }

    console.table(
      rows.map((row) => {
        const v = project(row);
        return {
          lead: row.lead_id,
          customer: v.customerName,
          service: v.serviceType,
          device: [v.deviceType, v.deviceBrandModel].filter(Boolean).join(" "),
          heardVia: v.howDidYouHear,
          channel: v.source,
          submitted: v.createdAt.toISOString().slice(0, 10),
        };
      }),
    );

    if (!APPLY) {
      console.log("\nNo data written. Re-run with --apply to create these records.");
      return;
    }

    await client.query("BEGIN");
    let created = 0;
    for (const row of rows) {
      const v = project(row);
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO csd_intake_records
           (customer_name, phone_number, email_address, contact_preference, service_type,
            device_type, device_brand_model, operating_system, problem_description,
            how_did_you_hear, is_from_active_call, source, status, internal_notes,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
         RETURNING id`,
        [
          v.customerName, v.phoneNumber, v.emailAddress, v.contactPreference, v.serviceType,
          v.deviceType, v.deviceBrandModel, v.operatingSystem, v.problemDescription,
          v.howDidYouHear, v.isFromActiveCall, v.source, v.status,
          `Reconstructed from lead #${row.lead_id}; this request predates intake-record persistence.`,
          v.createdAt,
        ],
      );
      const intakeRecordId = inserted.rows[0].id;
      // Only claim the lead if it is still unlinked, so a concurrent run cannot
      // point two intake records at the same lead.
      const linked = await client.query(
        `UPDATE crm_leads SET intake_record_id = $2, updated_at = NOW()
         WHERE id = $1 AND intake_record_id IS NULL`,
        [row.lead_id, intakeRecordId],
      );
      if (linked.rowCount === 0) {
        throw new Error(`Lead #${row.lead_id} was linked by another run; rolling back`);
      }
      created += 1;
      console.log(`  lead #${row.lead_id} -> intake record #${intakeRecordId}`);
    }
    await client.query("COMMIT");
    console.log(`\nDone. Created ${created} intake records.`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Backfill failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
