import { promises as fs } from "fs";
import path from "path";
import { pool } from "./db";

// Small key/value store for app-wide operational state (monitor snoozes, the
// last A2P submission, ...). It lives in Postgres because deployments run on
// autoscale: local files vanish on restart and aren't shared between instances.

let ensured: Promise<void> | undefined;

export function ensureAppStateTable(): Promise<void> {
  ensured ??= pool
    .query(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    .then(() => undefined)
    .catch((error) => {
      ensured = undefined;
      throw error;
    });
  return ensured;
}

export async function getAppState<T>(key: string): Promise<T | null> {
  await ensureAppStateTable();
  const result = await pool.query<{ value: T }>("SELECT value FROM app_state WHERE key = $1", [key]);
  return result.rows[0]?.value ?? null;
}

export async function setAppState<T>(key: string, value: T): Promise<void> {
  await ensureAppStateTable();
  await pool.query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}

// Reads `key`, importing a legacy `.local/<file>` JSON file the first time so
// state written before the move to Postgres isn't lost.
export async function getAppStateWithLegacyFile<T>(key: string, legacyFile: string): Promise<T | null> {
  const stored = await getAppState<T>(key);
  if (stored !== null) return stored;
  try {
    const raw = await fs.readFile(path.join(process.cwd(), ".local", legacyFile), "utf8");
    const parsed = JSON.parse(raw) as T;
    await setAppState(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}
