import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = (await import("node:module")).createRequire(import.meta.url);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outputDir = await mkdtemp(path.join(path.resolve(scriptDir, ".."), ".ptt-browser-test-"));
try {
  const result = await build({
    entryPoints: [path.join(scriptDir, "test-ptt-browser-audio.mjs")],
    outdir: outputDir,
    outExtension: { ".js": ".cjs" },
    platform: "node",
    bundle: true,
    format: "cjs",
    external: [
      "playwright",
      "sharp",
      "canvas",
      "bufferutil",
      "utf-8-validate",
    ],
    sourcemap: "inline",
    logLevel: "error",
    plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
    metafile: true,
  });
  const bundledEntry = Object.keys(result.metafile.outputs).find((output) =>
    output.includes("test-ptt-browser-audio"),
  );
  if (!bundledEntry) throw new Error("The browser test bundle did not contain its entry point.");

  const child = spawn(process.execPath, [bundledEntry], {
    stdio: "inherit",
    cwd: path.resolve(scriptDir, ".."),
    env: process.env,
  });
  const [code, signal] = await new Promise((resolve) => {
    child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  });
  if (signal) {
    process.kill(process.pid, signal);
  }
  process.exitCode = code ?? 1;
} finally {
  await rm(outputDir, { recursive: true, force: true });
}