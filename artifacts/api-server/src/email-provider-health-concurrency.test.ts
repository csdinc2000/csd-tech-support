import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import { alerts } from "@workspace/db";
import { db, pool } from "./db";
import { DatabaseStorage } from "./storage";
import { applyEmailCapacityAlertMigration } from "./migrations/2026-09-14-email-capacity-alert";

const source = `email-capacity-worker-test-${process.pid}-${Date.now()}`;

after(async () => {
  await db.delete(alerts).where(eq(alerts.alertSource, source));
  await pool.end();
});

test("separate workers merge concurrent email-capacity failures into one incident", async () => {
  await applyEmailCapacityAlertMigration();
  const workerA = new DatabaseStorage();
  const workerB = new DatabaseStorage();
  const baseAlert = {
    title: "Email provider capacity is exhausted",
    description: "Concurrency regression test",
    severity: "critical",
    category: "email",
    status: "active",
    alertSource: source,
    affectedServices: "[]",
    businessImpact: "critical",
    isEmergency: false,
  };

  await Promise.all([
    workerA.upsertActiveAlertBySource(source, baseAlert, "helpdesk"),
    workerB.upsertActiveAlertBySource(source, baseAlert, "invoice"),
  ]);

  const active = await db.select().from(alerts).where(eq(alerts.alertSource, source));
  assert.equal(active.filter((alert) => alert.status === "active").length, 1);
  assert.deepEqual(JSON.parse(active[0].affectedServices || "[]"), ["helpdesk", "invoice"]);

  await workerB.resolveActiveAlertsBySource(source);
  const recovered = await db.select().from(alerts).where(eq(alerts.alertSource, source));
  assert.equal(recovered.filter((alert) => alert.status === "active").length, 0);
  assert.ok(recovered[0].resolvedAt instanceof Date);
});