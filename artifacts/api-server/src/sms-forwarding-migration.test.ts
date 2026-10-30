import assert from "node:assert/strict";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import { smsForwardDeliveries } from "@workspace/db";
import { db, pool } from "./db";
import { applyStaffClientMessagesMigration } from "./migrations/2026-09-06-staff-client-messages";
import { applySmsForwardingMigration } from "./migrations/2026-09-07-sms-forwarding";
import { getTwilioSettings, invalidateTwilioSettingsCache } from "./twilio-settings-storage";
import { updateSmsMessageStatus } from "./twilio-tracking-storage";

const marker = `SM_FORWARD_MIGRATION_${process.pid}_${Date.now()}`;
let deliveryId: number | null = null;

after(async () => {
  if (deliveryId) {
    await db.delete(smsForwardDeliveries).where(eq(smsForwardDeliveries.id, deliveryId));
  }
  invalidateTwilioSettingsCache();
  await pool.end();
});

test("migration supports settings, inbound delivery persistence, and status callbacks", async () => {
  await applySmsForwardingMigration();
  await applySmsForwardingMigration();
  await applyStaffClientMessagesMigration();

  const settings = await getTwilioSettings();
  assert.ok(Object.prototype.hasOwnProperty.call(settings, "smsForwardNumbers"));

  const [delivery] = await db.insert(smsForwardDeliveries).values({
    inboundMessageSid: marker,
    targetNumber: "+19545550100",
    sourceNumber: "+19545550101",
    businessNumber: "+19545550102",
    body: "Migration integration test",
    status: "sent",
    providerMessageSid: marker,
  }).returning();
  deliveryId = delivery.id;

  await updateSmsMessageStatus(marker, "delivered", null, delivery.id);
  const [updated] = await db.select({
    status: smsForwardDeliveries.status,
    providerMessageSid: smsForwardDeliveries.providerMessageSid,
  }).from(smsForwardDeliveries).where(eq(smsForwardDeliveries.id, delivery.id));

  assert.equal(updated.status, "delivered");
  assert.equal(updated.providerMessageSid, marker);
});