import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("retries both notification channels when neither delivery succeeds", async () => {
  const originalCwd = process.cwd();
  const originalEnv = {
    A2P_ALERT_EMAIL: process.env.A2P_ALERT_EMAIL,
    SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,
  };
  const workingDirectory = await mkdtemp(path.join(tmpdir(), "a2p-monitor-test-"));

  process.chdir(workingDirectory);
  process.env.A2P_ALERT_EMAIL = "owner@example.com";
  process.env.SENDGRID_API_KEY = "SG.test-key";

  const monitor = await import("./a2p-monitor");
  let alertAttempts = 0;
  let emailAttempts = 0;
  let updatedAlertId: number | null = null;

  monitor.__setA2PMonitorDepsForTests({
    getA2PStatus: async () => ({
      configured: true,
      status: "rejected",
      useCase: null,
      brands: [{ sid: "BN_TEST", status: "FAILED", failureReason: "Test rejection" }],
      campaigns: [],
      bundleRejections: [],
      phoneNumbers: [],
      note: null,
    }),
    storage: {
      getActiveAlerts: async () => [],
      createAlert: async () => {
        alertAttempts += 1;
        throw new Error("database unavailable");
      },
    } as never,
    sgMail: {
      send: async () => {
        emailAttempts += 1;
        throw new Error("email unavailable");
      },
    } as never,
  });

  try {
    await monitor.runA2PMonitorOnce();

    const statePath = path.join(workingDirectory, ".local", "a2p-monitor-state.json");
    const firstState = JSON.parse(await readFile(statePath, "utf8")) as {
      lastAlertAt: string | null;
      lastAlertKind: string | null;
    };
    assert.equal(firstState.lastAlertAt, null);
    assert.equal(firstState.lastAlertKind, null);
    assert.equal(alertAttempts, 1);
    assert.equal(emailAttempts, 1);

    await monitor.runA2PMonitorOnce();

    const secondState = JSON.parse(await readFile(statePath, "utf8")) as {
      lastAlertAt: string | null;
      lastAlertKind: string | null;
    };
    assert.equal(secondState.lastAlertAt, null);
    assert.equal(secondState.lastAlertKind, null);
    assert.equal(alertAttempts, 2);
    assert.equal(emailAttempts, 2);

    monitor.__setA2PMonitorDepsForTests({
      getA2PStatus: async () => ({
        configured: true,
        status: "rejected",
        useCase: null,
        brands: [{ sid: "BN_TEST", status: "FAILED", failureReason: "Updated rejection" }],
        campaigns: [],
        bundleRejections: [],
        phoneNumbers: [],
        note: null,
      }),
      storage: {
        getActiveAlerts: async () => [{
          id: 42,
          alertSource: "a2p-monitor",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        }],
        updateAlert: async (id: number) => {
          updatedAlertId = id;
          return undefined;
        },
        createAlert: async () => {
          throw new Error("must reuse the existing A2P incident");
        },
      } as never,
      sgMail: { send: async () => undefined } as never,
    });
    await monitor.runA2PMonitorOnce();
    assert.equal(updatedAlertId, 42);

    updatedAlertId = null;
    monitor.__setA2PMonitorDepsForTests({
      getA2PStatus: async () => ({
        configured: true,
        status: "approved",
        useCase: "LOW_VOLUME",
        brands: [],
        campaigns: [],
        bundleRejections: [],
        phoneNumbers: [],
        note: null,
      }),
      storage: {
        getActiveAlerts: async () => [{
          id: 42,
          alertSource: "a2p-monitor",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        }],
        updateAlert: async (id: number) => {
          updatedAlertId = id;
          return undefined;
        },
      } as never,
      sgMail: { send: async () => undefined } as never,
    });
    await monitor.runA2PMonitorOnce();
    assert.equal(updatedAlertId, 42);
  } finally {
    monitor.__setA2PMonitorDepsForTests(null);
    process.chdir(originalCwd);
    if (originalEnv.A2P_ALERT_EMAIL === undefined) delete process.env.A2P_ALERT_EMAIL;
    else process.env.A2P_ALERT_EMAIL = originalEnv.A2P_ALERT_EMAIL;
    if (originalEnv.SENDGRID_API_KEY === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = originalEnv.SENDGRID_API_KEY;
    await rm(workingDirectory, { recursive: true, force: true });
  }
});
