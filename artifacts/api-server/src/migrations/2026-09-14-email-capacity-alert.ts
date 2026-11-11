import { pool } from "../db";

const SOURCE = "email-provider-capacity";
const LOCK_KEY = "email-provider-capacity-alert";

function parseAffectedServices(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export async function applyEmailCapacityAlertMigration(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY]);
    const result = await client.query<{
      id: number;
      affected_services: string | null;
    }>(
      `SELECT id, affected_services
         FROM alerts
        WHERE alert_source = $1 AND status = 'active'
        ORDER BY id
        FOR UPDATE`,
      [SOURCE],
    );

    const [keeper, ...duplicates] = result.rows;
    if (keeper && duplicates.length) {
      const affectedServices = [...new Set(
        result.rows.flatMap((row) => parseAffectedServices(row.affected_services)),
      )].sort();
      await client.query(
        "UPDATE alerts SET affected_services = $1 WHERE id = $2",
        [JSON.stringify(affectedServices), keeper.id],
      );
      await client.query(
        "UPDATE alerts SET status = 'resolved', resolved_at = NOW() WHERE id = ANY($1::int[])",
        [duplicates.map((row) => row.id)],
      );
    }

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS alerts_active_email_capacity_uidx
        ON alerts (alert_source)
        WHERE alert_source = '${SOURCE}' AND status = 'active'
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}