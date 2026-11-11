import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const setup = readFileSync(path.join(root, "scripts/post-merge.sh"), "utf8");
const apiPackage = readFileSync(path.join(root, "lib/api-spec/package.json"), "utf8");
const workspacePackage = readFileSync(path.join(root, "package.json"), "utf8");
const orvalConfig = readFileSync(path.join(root, "lib/api-spec/orval.config.ts"), "utf8");

// Each fixture uses the checked-in setup and package commands, not copies of
// their expected implementation. Only external executables are replaced.
// PATH contains ONLY our stubs and no secrets/environment from the workspace.
const stub = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const command = path.basename(process.argv[1]);
const root = process.env.FIXTURE_ROOT;
function log(event) { fs.appendFileSync(process.env.EVENT_LOG, event + "\\n"); }
function step(name, action) {
  log(name + ":start");
  if (process.env.FAIL_STEP === name) process.exit(37);
  action();
  log(name + ":done");
}
function runScript(dir, name) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  if (!pkg.scripts[name]) throw new Error("Missing script: " + name);
  const result = spawnSync("/bin/bash", ["-c", pkg.scripts[name]], {
    cwd: dir, env: process.env, stdio: ["ignore", "inherit", "inherit"]
  });
  process.exit(result.status ?? 99);
}
if (command === "pnpm" && JSON.stringify(args) === JSON.stringify(["install", "--frozen-lockfile"])) {
  step("install", () => fs.writeFileSync(path.join(root, "installed"), "ok"));
} else if (command === "pnpm" && JSON.stringify(args) === JSON.stringify(["--filter", "@workspace/api-spec", "run", "codegen"])) {
  log("codegen:invoke");
  runScript(path.join(root, "lib/api-spec"), "codegen");
} else if (command === "pnpm" && JSON.stringify(args) === JSON.stringify(["-w", "run", "typecheck:libs"])) {
  log("declarations:invoke");
  runScript(root, "typecheck:libs");
} else if (command === "orval" && JSON.stringify(args) === JSON.stringify(["--config", "./orval.config.ts"])) {
  if (!fs.existsSync(path.join(root, "installed"))) throw new Error("Generation before install");
  step("generate", () => {
    for (const name of ["react-query", "zod"]) fs.writeFileSync(path.join(root, name), "generated");
  });
} else if (command === "tsc" && JSON.stringify(args) === JSON.stringify(["--build"])) {
  for (const name of ["react-query", "zod"]) {
    if (!fs.existsSync(path.join(root, name))) throw new Error("Declarations before generation");
  }
  step("declarations", () => fs.writeFileSync(path.join(root, "declarations"), "built"));
} else {
  // Unknown commands (including db push aliases) must never reach real tools.
  log("forbidden:" + command + " " + args.join(" "));
  process.exit(98);
}
`;

function fixture(t, script = setup, manifest = apiPackage) {
  const dir = mkdtempSync(path.join(tmpdir(), "post-merge-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "bin"));
  mkdirSync(path.join(dir, "lib/api-spec"), { recursive: true });
  writeFileSync(path.join(dir, "post-merge.sh"), script);
  writeFileSync(path.join(dir, "package.json"), workspacePackage);
  writeFileSync(path.join(dir, "lib/api-spec/package.json"), manifest);
  writeFileSync(path.join(dir, "lib/api-spec/orval.config.ts"), orvalConfig);
  for (const name of ["pnpm", "orval", "tsc", "drizzle-kit"]) {
    writeFileSync(path.join(dir, "bin", name), stub, { mode: 0o755 });
  }
  const log = path.join(dir, "events");
  return {
    dir,
    run(failStep = "") {
      const result = spawnSync("/bin/bash", [path.join(dir, "post-merge.sh")], {
        cwd: dir,
        env: {
          PATH: path.join(dir, "bin"),
          HOME: dir,
          FIXTURE_ROOT: dir,
          EVENT_LOG: log,
          FAIL_STEP: failStep,
        },
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: 5000,
      });
      assert.ifError(result.error);
      // Model the documented platform boundary: reconciliation is called only
      // after setup exits successfully. This does not call platform services.
      if (result.status === 0) {
        assert.ok(existsSync(path.join(dir, "declarations")), "Setup succeeded before shared declarations finished");
        writeFileSync(log, "reconcile\n", { flag: "a" });
      }
      return {
        ...result,
        events: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
      };
    },
  };
}

const successEvents = [
  "install:start", "install:done", "codegen:invoke",
  "generate:start", "generate:done", "declarations:invoke",
  "declarations:start", "declarations:done", "reconcile",
];

test("setup installs, generates both clients, and finishes declarations before reconciliation", (t) => {
  // Ensure the config selected by the real codegen command still has both
  // required targets. The stubs intentionally do not run Orval itself.
  assert.match(orvalConfig, /client:\s*["']react-query["']/);
  assert.match(orvalConfig, /client:\s*["']zod["']/);
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events, successEvents);
  for (const output of ["react-query", "zod", "declarations"]) {
    assert.ok(existsSync(path.join(f.dir, output)), `Missing ${output}`);
  }
  // Repeated setup must retain the same ordering, without invoking services.
  const repeated = f.run();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(repeated.events, [...successEvents, ...successEvents]);
});

for (const [step, expected] of [
  ["install", ["install:start"]],
  ["generate", ["install:start", "install:done", "codegen:invoke", "generate:start"]],
  ["declarations", successEvents.slice(0, 7)],
]) {
  test(`${step} failure stops setup and prevents reconciliation`, (t) => {
    const result = fixture(t).run(step);
    assert.equal(result.status, 37, result.stderr);
    assert.deepEqual(result.events, expected);
    assert.ok(!result.events.includes("reconcile"));
  });
}

test("setup and reachable package scripts must not introduce a whole-schema push", () => {
  const commands = [
    // Ignore full-line comments: the safety comment mentions drizzle-kit push.
    setup.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n"),
    ...Object.values(JSON.parse(apiPackage).scripts),
    JSON.parse(workspacePackage).scripts["typecheck:libs"],
  ].join("\n");
  assert.doesNotMatch(commands, /\bdrizzle(?:-kit)?\b[^\n;&|]*\bpush\b/i);
  assert.doesNotMatch(commands, /\b(?:push-force|db:push|push:db)\b/i);
});

test("sandbox rejects an added database push without executing a real tool", (t) => {
  const result = fixture(t, setup + "\npnpm --filter @workspace/db run push-force\n").run();
  assert.equal(result.status, 98);
  assert.equal(result.events.at(-1), "forbidden:pnpm --filter @workspace/db run push-force");
  assert.ok(!result.events.includes("reconcile"));
});

test("a missing declaration build cannot silently pass the reconciliation boundary", (t) => {
  const manifest = JSON.parse(apiPackage);
  manifest.scripts.codegen = "orval --config ./orval.config.ts";
  assert.throws(
    () => fixture(t, setup, JSON.stringify(manifest)).run(),
    /Setup succeeded before shared declarations finished/,
  );
});