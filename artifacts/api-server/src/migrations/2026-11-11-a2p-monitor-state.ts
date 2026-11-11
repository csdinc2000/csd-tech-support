import { ensureAppStateTable } from "../app-state";

// Moves A2P monitor state (snooze, last verdict) and the last A2P registration
// submission off local disk into the shared `app_state` table.
export async function applyA2pMonitorStateMigration(): Promise<void> {
  await ensureAppStateTable();
}
