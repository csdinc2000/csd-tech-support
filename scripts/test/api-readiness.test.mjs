import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { registerReadinessRoutes } from "../../artifacts/api-server/src/readiness.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const requireApi = createRequire(path.join(root, "artifacts/api-server/package.json"));
const express = requireApi("express");
const artifactConfig = readFileSync(
  path.join(root, "artifacts/api-server/.replit-artifact/artifact.toml"),
  "utf8",
);
const apiSource = readFileSync(path.join(root, "artifacts/api-server/src/index.ts"), "utf8");

function configuredServicePaths() {
  const match = artifactConfig.match(/^paths\s*=\s*\[([^\]]*)\]/m);
  assert.ok(match, "API service paths must be configured in artifact.toml");
  return [...match[1].matchAll(/"([^"]+)"/g)].map(([, route]) => route);
}

function configuredStartupHealthPath() {
  const match = artifactConfig.match(
    /^\[services\.production\.health\.startup\]\s*\npath\s*=\s*"([^"]+)"/m,
  );
  assert.ok(match, "Production startup health path must be configured in artifact.toml");
  return match[1];
}

const isolatedEnvironment = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "/tmp",
  LANG: "C.UTF-8",
};

function runCommand(command, args, description, timeout = 60_000) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: isolatedEnvironment,
    encoding: "utf8",
    timeout,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${description} failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
}

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

function processOutput(chunks) {
  return Buffer.concat(chunks).toString("utf8");
}

test("configured API readiness paths respond healthy without authentication", async (t) => {
  const servicePaths = configuredServicePaths();
  const startupHealthPath = configuredStartupHealthPath();
  const app = express();
  registerReadinessRoutes(app, { critical: [async () => {}] });
  // Model the production auth boundary: any readiness route registered after
  // this middleware would fail the unauthenticated requests below.
  app.use((_req, res) => res.status(401).json({ error: "Authentication required" }));
  const server = app.listen(0);
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const paths = [...new Set([...servicePaths, startupHealthPath])];
  for (const route of paths) {
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`);
    assert.equal(response.status, 200, `${route} should be publicly reachable`);
    assert.deepEqual(await response.json(), { status: "ok" }, `${route} should report healthy`);
  }

  assert.match(
    apiSource,
    /registerReadinessRoutes\(app,[\s\S]*?\);\s*[\s\S]*?app\.use\(apiAuthenticationBoundary\)/,
    "readiness routes must be mounted before the API authentication boundary",
  );
});

test(
  "built production API serves configured readiness paths with isolated settings",
  { timeout: 240_000 },
  async () => {
    const servicePaths = configuredServicePaths();
    const startupHealthPath = configuredStartupHealthPath();
    let apiProcess;
    const apiStdout = [];
    const apiStderr = [];

    try {
      runCommand(
        "pnpm",
        ["--filter", "@workspace/api-server", "run", "build"],
        "Production API build",
        120_000,
      );

      const apiPort = await availablePort();
      apiProcess = spawn(
        process.execPath,
        [
          "--enable-source-maps",
          path.join(root, "artifacts/api-server/dist/index.mjs"),
          "--readiness-smoke-test",
        ],
        {
          cwd: root,
          env: {
            ...isolatedEnvironment,
            NODE_ENV: "production",
            PORT: String(apiPort),
            DATABASE_URL: "postgresql://readiness_test:readiness_test@127.0.0.1:1/readiness_test",
            CLERK_SECRET_KEY: "sk_test_readiness_only",
            CLERK_PUBLISHABLE_KEY: "pk_test_dGVzdC5jbGVyay5hY2NvdW50cy5kZXYk",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      apiProcess.stdout.on("data", (chunk) => apiStdout.push(chunk));
      apiProcess.stderr.on("data", (chunk) => apiStderr.push(chunk));

      const healthUrl = `http://127.0.0.1:${apiPort}${startupHealthPath}`;
      const deadline = Date.now() + 20_000;
      let healthResponse;
      let lastStartupError;
      while (Date.now() < deadline) {
        if (apiProcess.exitCode !== null || apiProcess.signalCode !== null) {
          assert.fail(
            `Built API exited before becoming healthy (exit ${apiProcess.exitCode}, signal ${apiProcess.signalCode}).\n` +
              processOutput(apiStdout) +
              processOutput(apiStderr),
          );
        }
        try {
          healthResponse = await fetch(healthUrl, {
            signal: AbortSignal.timeout(1_500),
          });
          if (healthResponse.status === 200) break;
          lastStartupError = `HTTP ${healthResponse.status}: ${await healthResponse.text()}`;
          if (healthResponse.status >= 500 && healthResponse.status !== 503) {
            assert.fail(
              `Built API returned an unexpected error at ${startupHealthPath}: ${lastStartupError}\n` +
                processOutput(apiStdout) +
                processOutput(apiStderr),
            );
          }
        } catch (error) {
          lastStartupError = error?.message ?? String(error);
        }
        await delay(250);
      }
      assert.equal(
        healthResponse?.status,
        200,
        `Built API did not become healthy at ${startupHealthPath}: ${lastStartupError ?? "startup timed out"}\n` +
          processOutput(apiStdout) +
          processOutput(apiStderr),
      );
      assert.deepEqual(
        await healthResponse.json(),
        { status: "ok" },
        `${startupHealthPath} should report healthy`,
      );

      for (const route of new Set([...servicePaths, startupHealthPath])) {
        const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
          signal: AbortSignal.timeout(5_000),
        });
        assert.equal(response.status, 200, `${route} should be publicly reachable`);
        assert.deepEqual(await response.json(), { status: "ok" }, `${route} should report healthy`);
      }
    } finally {
      if (apiProcess) await stopProcess(apiProcess);
    }
  },
);
