import type { PoolClient } from "@neondatabase/serverless";

export const DELETED_CONTACT_PLACEHOLDER_TAG = "__deleted_contact_placeholder__";

type ForeignKeyReference = {
  tableName: string;
  columnName: string;
};

export type PlaceholderReview = {
  id: number;
  fullName: string;
  references: Array<ForeignKeyReference & { count: number }>;
  totalReferences: number;
};

export type PlaceholderLinkedRecord = {
  id: string;
  label: string;
  href: string | null;
  status: string | null;
  date: string | null;
};

export type PlaceholderReferenceReview = ForeignKeyReference & {
  count: number;
  records: PlaceholderLinkedRecord[];
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function getContactForeignKeys(client: PoolClient): Promise<ForeignKeyReference[]> {
  const { rows } = await client.query<{
    table_name: string;
    column_name: string;
  }>(`
    SELECT child.relname AS table_name, child_column.attname AS column_name
    FROM pg_constraint constraint_row
    JOIN pg_class parent ON parent.oid = constraint_row.confrelid
    JOIN pg_namespace parent_schema ON parent_schema.oid = parent.relnamespace
    JOIN pg_class child ON child.oid = constraint_row.conrelid
    JOIN pg_namespace child_schema ON child_schema.oid = child.relnamespace
    JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS child_key(attnum, position)
      ON TRUE
    JOIN LATERAL unnest(constraint_row.confkey) WITH ORDINALITY AS parent_key(attnum, position)
      ON parent_key.position = child_key.position
    JOIN pg_attribute child_column
      ON child_column.attrelid = child.oid AND child_column.attnum = child_key.attnum
    JOIN pg_attribute parent_column
      ON parent_column.attrelid = parent.oid AND parent_column.attnum = parent_key.attnum
    WHERE constraint_row.contype = 'f'
      AND parent_schema.nspname = 'public'
      AND parent.relname = 'crm_contacts'
      AND parent_column.attname = 'id'
      AND child_schema.nspname = 'public'
    ORDER BY child.relname, child_column.attname
  `);
  return rows.map((row) => ({ tableName: row.table_name, columnName: row.column_name }));
}

export async function reviewDeletedContactPlaceholders(
  client: PoolClient,
): Promise<PlaceholderReview[]> {
  const foreignKeys = await getContactForeignKeys(client);
  const { rows: placeholders } = await client.query<{ id: number; full_name: string }>(
    `SELECT id, full_name
     FROM crm_contacts
     WHERE tags = $1
     ORDER BY id`,
    [DELETED_CONTACT_PLACEHOLDER_TAG],
  );

  const reviews: PlaceholderReview[] = [];
  for (const placeholder of placeholders) {
    const references: PlaceholderReview["references"] = [];
    for (const foreignKey of foreignKeys) {
      const table = quoteIdentifier(foreignKey.tableName);
      const column = quoteIdentifier(foreignKey.columnName);
      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table} WHERE ${column} = $1`,
        [placeholder.id],
      );
      references.push({ ...foreignKey, count: rows[0].count });
    }
    reviews.push({
      id: placeholder.id,
      fullName: placeholder.full_name,
      references,
      totalReferences: references.reduce((sum, reference) => sum + reference.count, 0),
    });
  }
  return reviews;
}

/**
 * Owner review needs a little more context than the cleanup command: counts
 * explain why a placeholder was retained, while allow-listed record details
 * let staff follow the history that caused the retention. Keep this separate
 * from the generic FK scan so adding a new relationship cannot accidentally
 * expose arbitrary table contents.
 */
export async function reviewDeletedContactPlaceholdersWithRecords(
  client: PoolClient,
): Promise<Array<Omit<PlaceholderReview, "references"> & {
  references: PlaceholderReferenceReview[];
}>> {
  const foreignKeys = await getContactForeignKeys(client);
  const { rows: placeholders } = await client.query<{ id: number; full_name: string }>(
    `SELECT id, full_name
     FROM crm_contacts
     WHERE tags = $1
     ORDER BY id`,
    [DELETED_CONTACT_PLACEHOLDER_TAG],
  );

  const reviews = [];
  for (const placeholder of placeholders) {
    const references: PlaceholderReferenceReview[] = [];
    for (const foreignKey of foreignKeys) {
      const table = quoteIdentifier(foreignKey.tableName);
      const column = quoteIdentifier(foreignKey.columnName);
      const { rows: countRows } = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${table} WHERE ${column} = $1`,
        [placeholder.id],
      );
      const count = countRows[0].count;
      let records: PlaceholderLinkedRecord[] = [];

      // These are the only historical records with an existing staff-facing
      // detail destination. The legacy booking table is still counted below,
      // but has no detail view in the CRM.
      if (foreignKey.tableName === "invoices" && foreignKey.columnName === "contact_id") {
        const { rows } = await client.query<{
          id: string;
          invoice_number: string;
          status: string | null;
          due_date: string | null;
        }>(
          `SELECT id::text, invoice_number, status, due_date
           FROM invoices
           WHERE contact_id = $1
           ORDER BY id`,
          [placeholder.id],
        );
        records = rows.map((row) => ({
          id: row.id,
          label: row.invoice_number,
          href: `/invoices/${row.id}`,
          status: row.status,
          date: row.due_date,
        }));
      } else if (foreignKey.tableName === "appointments" && foreignKey.columnName === "contact_id") {
        const { rows } = await client.query<{
          id: string;
          reference: string;
          status: string | null;
          starts_at: string | null;
        }>(
          `SELECT id::text, reference, status, starts_at
           FROM appointments
           WHERE contact_id = $1
           ORDER BY starts_at, id`,
          [placeholder.id],
        );
        records = rows.map((row) => ({
          id: row.id,
          label: row.reference,
          href: `/api/booking/appointments/${encodeURIComponent(row.reference)}`,
          status: row.status,
          date: row.starts_at,
        }));
      } else if (
        foreignKey.tableName === "booking_appointments" &&
        foreignKey.columnName === "client_id"
      ) {
        const { rows } = await client.query<{
          id: string;
          status: string | null;
          visible_start: string | null;
        }>(
          `SELECT id::text, status, visible_start
           FROM booking_appointments
           WHERE client_id = $1
           ORDER BY visible_start, id`,
          [placeholder.id],
        );
        records = rows.map((row) => ({
          id: row.id,
          label: `Legacy booking ${row.id.slice(0, 8)}`,
          href: null,
          status: row.status,
          date: row.visible_start,
        }));
      }

      references.push({ ...foreignKey, count, records });
    }
    reviews.push({
      id: placeholder.id,
      fullName: placeholder.full_name,
      references,
      totalReferences: references.reduce((sum, reference) => sum + reference.count, 0),
    });
  }
  return reviews;
}

export async function removeUnreferencedDeletedContactPlaceholders(
  client: PoolClient,
): Promise<{ reviewed: PlaceholderReview[]; removedIds: number[] }> {
  await client.query("BEGIN");
  try {
    // Lock the candidates before reviewing, so a relationship cannot be added
    // between the zero-reference check and deletion.
    await client.query(
      `SELECT id FROM crm_contacts WHERE tags = $1 ORDER BY id FOR UPDATE`,
      [DELETED_CONTACT_PLACEHOLDER_TAG],
    );
    const reviewed = await reviewDeletedContactPlaceholders(client);
    const removableIds = reviewed
      .filter((placeholder) => placeholder.totalReferences === 0)
      .map((placeholder) => placeholder.id);
    const removedIds: number[] = [];

    for (const id of removableIds) {
      const result = await client.query<{ id: number }>(
        `DELETE FROM crm_contacts
         WHERE id = $1 AND tags = $2
         RETURNING id`,
        [id, DELETED_CONTACT_PLACEHOLDER_TAG],
      );
      if (result.rows[0]) removedIds.push(result.rows[0].id);
    }
    await client.query("COMMIT");
    return { reviewed, removedIds };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}