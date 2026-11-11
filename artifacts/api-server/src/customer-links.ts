import { pool } from "./db";
import { logger } from "./lib/logger";
import { deterministicClientMatch } from "./customer-link-core";

/** Safe to run repeatedly: only empty contact links and empty invoice links move. */
export async function applyCustomerLinkMigration(): Promise<void> {
  const client = await pool.connect();
  try {
    const [accountsResult, contactsResult] = await Promise.all([
      client.query("SELECT id, contact_email AS \"contactEmail\" FROM clients"),
      client.query("SELECT id, email, client_id AS \"clientId\" FROM crm_contacts"),
    ]);
    const updates = contactsResult.rows
      .map((contact) => ({ contactId: contact.id as number, clientId: deterministicClientMatch(contact, accountsResult.rows) }))
      .filter((match): match is { contactId: number; clientId: number } => match.clientId !== null);
    let contactLinksUpdated = 0;
    for (const update of updates) {
      const result = await client.query(
        "UPDATE crm_contacts SET client_id=$2, updated_at=now() WHERE id=$1 AND client_id IS NULL",
        [update.contactId, update.clientId],
      );
      contactLinksUpdated += result.rowCount ?? 0;
    }
    const invoiceClientColumn = await client.query(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema='public' AND table_name='invoices' AND column_name='client_id'
       ) AS exists`,
    );
    let invoiceLinksUpdated = 0;
    if (invoiceClientColumn.rows[0]?.exists) {
      const result = await client.query(
        `UPDATE invoices i SET client_id=c.client_id
         FROM crm_contacts c
         WHERE i.contact_id=c.id AND i.client_id IS NULL AND c.client_id IS NOT NULL`,
      );
      invoiceLinksUpdated = result.rowCount ?? 0;
    }
    logger.info({ contactLinksUpdated, invoiceLinksUpdated }, "Customer link migration completed");
  } catch (error) {
    logger.error({ error }, "Customer link migration failed");
    throw error;
  } finally {
    client.release();
  }
}