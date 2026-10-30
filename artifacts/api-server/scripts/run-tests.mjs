/**
 * Runs every `src/**\/*.test.ts` file in this package.
 *
 * The tests are bundled with the SAME esbuild configuration the production
 * build uses (see ../build.mjs) — in particular `esbuild-plugin-pino`, which
 * emits the transport worker chunks pino needs. Without it, any test that
 * transitively imports `src/lib/logger.ts` dies at import time with
 * "unable to determine transport target for pino-pretty" rather than running.
 *
 * Test files are discovered rather than listed, so a new `*.test.ts` is picked
 * up automatically instead of silently never running.
 *
 * Usage:
 *   node ./scripts/run-tests.mjs            # every test file
 *   node ./scripts/run-tests.mjs roip ptt   # only files matching a substring
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

// 'esbuild-plugin-pino' resolves its dependencies with `require`.
globalThis.require = createRequire(import.meta.url);

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(packageDir, "src");

function run(command, args) {
  return (
    spawnSync(command, args, {
      stdio: "inherit",
      cwd: packageDir,
      env: process.env,
    }).status ?? 1
  );
}

async function findTestFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findTestFiles(full)));
    else if (entry.name.endsWith(".test.ts")) found.push(full);
  }
  return found.sort();
}

const filters = process.argv.slice(2);
const allTests = await findTestFiles(srcDir);
const tests = filters.length
  ? allTests.filter((f) => filters.some((needle) => f.includes(needle)))
  : allTests;

if (tests.length === 0) {
  console.error(
    filters.length
      ? `No test files match: ${filters.join(", ")}`
      : `No *.test.ts files found under ${srcDir}`,
  );
  process.exit(1);
}

const outDir = await mkdtemp(path.join(tmpdir(), "api-server-tests-"));
let status = 1;
try {
  await esbuild({
    entryPoints: tests,
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: outDir,
    outExtension: { ".js": ".mjs" },
    sourcemap: "inline",
    logLevel: "error",
    plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
    banner: {
      js: `import { createRequire as __testCreateRequire } from "node:module";
import __testPath from "node:path";
import __testUrl from "node:url";
globalThis.require = __testCreateRequire(import.meta.url);
globalThis.__filename = __testUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __testPath.dirname(globalThis.__filename);`,
    },
  });

  const bundled = tests.map((f) =>
    path.join(outDir, `${path.basename(f, ".ts")}.mjs`),
  );

  for (const file of tests) {
    console.log(`• ${path.relative(packageDir, file)}`);
  }

  // Serial: several suites bind ports and mutate process.env.
  status = run(process.execPath, [
    "--test",
    "--test-concurrency=1",
    "--enable-source-maps",
    ...bundled,
  ]);

  if (status === 0 && filters.length === 0) {
    console.log("• scripts/test-stripe-native-invoice.ts (audit concurrency)");
    status = run("pnpm", ["run", "test:stripe-document-audit-concurrency"]);
  }
} finally {
  // Clean up before exiting -- `process.exit` would skip this.
  await rm(outDir, { recursive: true, force: true });
}

process.exit(status);
