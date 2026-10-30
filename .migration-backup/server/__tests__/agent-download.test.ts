import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// storage -> ./db throws unless DATABASE_URL is present at import time. We never
// open a real connection here (these tests only exercise URL-building, which
// short-circuits on the env override before any network/db call), but the env
// var must exist before the import chain runs. Mirror the sibling tests.
process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const { meshCentralService } = await import("../meshcentral-service");

const SAVED = {
  url: process.env.MESHCENTRAL_URL,
  user: process.env.MESHCENTRAL_USERNAME,
  pass: process.env.MESHCENTRAL_PASSWORD,
  mesh: process.env.MESHCENTRAL_DEFAULT_MESH_ID,
};

function restore() {
  for (const [k, v] of [
    ["MESHCENTRAL_URL", SAVED.url],
    ["MESHCENTRAL_USERNAME", SAVED.user],
    ["MESHCENTRAL_PASSWORD", SAVED.pass],
    ["MESHCENTRAL_DEFAULT_MESH_ID", SAVED.mesh],
  ] as const) {
    if (v === undefined) delete (process.env as any)[k];
    else process.env[k] = v;
  }
  // Reset the in-memory mesh-id cache between tests.
  (meshCentralService as any).cachedMeshId = undefined;
}

beforeEach(restore);
afterEach(restore);

test("getAgentDownloadUrl returns null when MeshCentral is not configured", async () => {
  delete process.env.MESHCENTRAL_URL;
  assert.equal(await meshCentralService.getAgentDownloadUrl("windows"), null);
  assert.deepEqual(await meshCentralService.getAgentInstallers(), []);
});

test("getAgentDownloadUrl builds verified per-platform URLs from the mesh-id override", async () => {
  process.env.MESHCENTRAL_URL = "https://remote.example.com/";
  // Override short-circuits auto-detection, so this never touches the network.
  process.env.MESHCENTRAL_DEFAULT_MESH_ID = "mesh//ABC123";

  assert.equal(
    await meshCentralService.getAgentDownloadUrl("windows"),
    "https://remote.example.com/meshagents?id=4&meshid=ABC123&installflags=0",
  );
  assert.equal(
    await meshCentralService.getAgentDownloadUrl("mac"),
    "https://remote.example.com/meshagents?id=10005&meshid=ABC123&installflags=0",
  );
  assert.equal(
    await meshCentralService.getAgentDownloadUrl("linux"),
    "https://remote.example.com/meshagents?id=6&meshid=ABC123&installflags=0",
  );
});

test("resolveAgentMeshId strips the mesh// prefix and ignores the mesh_default sentinel", async () => {
  process.env.MESHCENTRAL_URL = "https://remote.example.com";
  process.env.MESHCENTRAL_DEFAULT_MESH_ID = "mesh//Xyz";
  assert.equal(await meshCentralService.resolveAgentMeshId(), "Xyz");

  // The legacy "mesh_default" placeholder must not be treated as a real id; with
  // no credentials configured, resolution then yields null rather than a bogus id.
  process.env.MESHCENTRAL_DEFAULT_MESH_ID = "mesh_default";
  delete process.env.MESHCENTRAL_USERNAME;
  delete process.env.MESHCENTRAL_PASSWORD;
  (meshCentralService as any).cachedMeshId = undefined;
  assert.equal(await meshCentralService.resolveAgentMeshId(), null);
});

test("getAgentInstallers returns all three platforms when a mesh id is available", async () => {
  process.env.MESHCENTRAL_URL = "https://remote.example.com";
  process.env.MESHCENTRAL_DEFAULT_MESH_ID = "mesh//G1";
  const installers = await meshCentralService.getAgentInstallers();
  assert.deepEqual(
    installers.map((i) => i.platform).sort(),
    ["linux", "mac", "windows"],
  );
  assert.ok(installers.every((i) => i.url.includes("meshid=G1")));
});
