import { pool } from "./db";

export type EmailCapacityWarningSettings =
  | { mode: "default"; value: null }
  | { mode: "percentage"; value: number }
  | { mode: "remainingCredits"; value: number };

export const DEFAULT_EMAIL_CAPACITY_WARNING_SETTINGS = {
  mode: "default",
  value: null,
} as const satisfies EmailCapacityWarningSettings;

export type EmailCapacityWarningSettingsActor = {
  userId: string;
  email: string | null;
};

export type EmailCapacityWarningSettingsAuditEntry = {
  id: string;
  actor: EmailCapacityWarningSettingsActor;
  previousSettings: EmailCapacityWarningSettings;
  newSettings: EmailCapacityWarningSettings;
  changedAt: string;
};

export type EmailCapacityWarningSettingsAuditCursor = {
  changedAt: string;
  id: string;
};

export type EmailCapacityWarningSettingsAuditPage = {
  items: EmailCapacityWarningSettingsAuditEntry[];
  nextCursor: string | null;
};

function csvCell(value: string): string {
  // Spreadsheet applications interpret these prefixes as formulas, even inside quoted CSV cells.
  const safe = /^[\s]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function formatEmailCapacityWarningSettingsAuditCsv(items: EmailCapacityWarningSettingsAuditEntry[]): string {
  const rows = [["Change time (UTC)", "Owner ID", "Owner email", "Previous setting", "New setting"]];
  const setting = (value: EmailCapacityWarningSettings) =>
    value.mode === "default" ? "Safe defaults"
      : value.mode === "percentage" ? `${value.value}% remaining`
      : `${value.value} credits remaining`;
  for (const item of items) {
    rows.push([
      item.changedAt,
      item.actor.userId,
      item.actor.email ?? "",
      setting(item.previousSettings),
      setting(item.newSettings),
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function encodeAuditCursor(cursor: EmailCapacityWarningSettingsAuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function parseEmailCapacityWarningSettingsAuditCursor(
  value: string,
): EmailCapacityWarningSettingsAuditCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid email warning history cursor");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || typeof (parsed as Record<string, unknown>).changedAt !== "string"
    || Number.isNaN(Date.parse((parsed as Record<string, unknown>).changedAt as string))
    || typeof (parsed as Record<string, unknown>).id !== "string"
    || !(parsed as Record<string, unknown>).id
  ) {
    throw new Error("Invalid email warning history cursor");
  }
  return parsed as EmailCapacityWarningSettingsAuditCursor;
}

export async function getEmailCapacityWarningSettings(): Promise<EmailCapacityWarningSettings> {
  const result = await pool.query<{ warning_mode: EmailCapacityWarningSettings["mode"]; warning_value: number | null }>(
    "SELECT warning_mode, warning_value FROM email_capacity_settings WHERE id = 1",
  );
  const row = result.rows[0];
  if (!row || row.warning_mode === "default") return DEFAULT_EMAIL_CAPACITY_WARNING_SETTINGS;
  return { mode: row.warning_mode, value: Number(row.warning_value) } as EmailCapacityWarningSettings;
}

export async function updateEmailCapacityWarningSettings(
  settings: EmailCapacityWarningSettings,
  actor: EmailCapacityWarningSettingsActor,
): Promise<EmailCapacityWarningSettings> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [19_740_001]);
    const current = await client.query<{
      warning_mode: EmailCapacityWarningSettings["mode"];
      warning_value: number | null;
    }>("SELECT warning_mode, warning_value FROM email_capacity_settings WHERE id = 1 FOR UPDATE");
    const previous = current.rows[0] ?? {
      warning_mode: DEFAULT_EMAIL_CAPACITY_WARNING_SETTINGS.mode,
      warning_value: DEFAULT_EMAIL_CAPACITY_WARNING_SETTINGS.value,
    };

    await client.query(
      `INSERT INTO email_capacity_settings (id, warning_mode, warning_value, updated_at)
       VALUES (1, $1, $2, NOW())
       ON CONFLICT (id) DO UPDATE
         SET warning_mode = EXCLUDED.warning_mode,
             warning_value = EXCLUDED.warning_value,
             updated_at = NOW()`,
      [settings.mode, settings.value],
    );
    await client.query(
      `INSERT INTO email_capacity_settings_audit (
         actor_user_id, actor_email, previous_mode, previous_value, new_mode, new_value
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        actor.userId,
        actor.email,
        previous.warning_mode,
        previous.warning_value,
        settings.mode,
        settings.value,
      ],
    );
    await client.query("COMMIT");
    return settings;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getEmailCapacityWarningSettingsAudit(
  options: {
    limit?: number;
    cursor?: EmailCapacityWarningSettingsAuditCursor;
    fromDate?: string;
    toDate?: string;
  } = {},
): Promise<EmailCapacityWarningSettingsAuditPage> {
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
  const parameters: unknown[] = [limit + 1];
  const conditions: string[] = [];
  if (options.fromDate) {
    parameters.push(options.fromDate);
    conditions.push(`changed_at >= $${parameters.length}::timestamptz`);
  }
  if (options.toDate) {
    parameters.push(options.toDate);
    conditions.push(`changed_at < $${parameters.length}::timestamptz`);
  }
  if (options.cursor) {
    parameters.push(options.cursor.changedAt, options.cursor.id);
    conditions.push(
      `(changed_at, id) < ($${parameters.length - 1}::timestamptz, $${parameters.length})`,
    );
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pool.query<{
    id: string;
    actor_user_id: string | null;
    actor_email: string | null;
    previous_mode: EmailCapacityWarningSettings["mode"];
    previous_value: number | null;
    new_mode: EmailCapacityWarningSettings["mode"];
    new_value: number | null;
    changed_at: Date;
  }>(
    `SELECT id, actor_user_id, actor_email, previous_mode, previous_value,
            new_mode, new_value, changed_at
       FROM email_capacity_settings_audit
      ${whereClause}
      ORDER BY changed_at DESC, id DESC
      LIMIT $1`,
    parameters,
  );

  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const items = rows.map((row) => ({
    id: row.id,
    actor: { userId: row.actor_user_id ?? "", email: row.actor_email },
    previousSettings: row.previous_mode === "default"
      ? DEFAULT_EMAIL_CAPACITY_WARNING_SETTINGS
      : { mode: row.previous_mode, value: Number(row.previous_value) } as EmailCapacityWarningSettings,
    newSettings: row.new_mode === "default"
      ? DEFAULT_EMAIL_CAPACITY_WARNING_SETTINGS
      : { mode: row.new_mode, value: Number(row.new_value) } as EmailCapacityWarningSettings,
    changedAt: row.changed_at.toISOString(),
  }));
  const last = hasMore ? items.at(-1) : undefined;
  return {
    items,
    nextCursor: last ? encodeAuditCursor({ changedAt: last.changedAt, id: last.id }) : null,
  };
}