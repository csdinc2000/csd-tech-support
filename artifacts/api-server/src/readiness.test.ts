import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { registerReadinessRoutes } from "./readiness";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

async function startReadinessServer(dependencyChecks: Parameters<typeof registerReadinessRoutes>[1]): Promise<string> {
  const app = express();
  registerReadinessRoutes(app, dependencyChecks);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

test("readiness routes report healthy when the critical dependency responds", async () => {
  let checks = 0;
  const baseUrl = await startReadinessServer({
    critical: [async () => {
      checks += 1;
    }],
  });

  for (const path of ["/api", "/webhooks", "/ws", "/api/healthz"]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  }
  assert.equal(checks, 4);
});

test("readiness routes return a sanitized 503 when a critical dependency fails", async () => {
  const baseUrl = await startReadinessServer({
    critical: [async () => {
      throw new Error("connection failed for postgres://private-user:private-password@db");
    }],
  });

  for (const path of ["/api", "/webhooks", "/ws", "/api/healthz"]) {
    const response = await fetch(`${baseUrl}${path}`);
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(body), { status: "unavailable" });
    assert.doesNotMatch(body, /private-user|private-password|postgres:\/\//);
  }
});

test("optional integration outages do not affect readiness", async () => {
  let optionalCheckCalled = false;
  const baseUrl = await startReadinessServer({
    critical: [async () => {}],
    optional: [async () => {
      optionalCheckCalled = true;
      throw new Error("Optional integration unavailable");
    }],
  });

  const response = await fetch(`${baseUrl}/api/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.equal(optionalCheckCalled, false);
});
