---
name: Bundled CLI entrypoint guard breaks in esbuild bundle
description: Why `import.meta.url === file://${process.argv[1]}` misfires after bundling, and the safe alternative
---

# Detecting "run as a script" must survive bundling

**Rule:** A module that should only auto-execute when run directly as a CLI must NOT gate that on
`import.meta.url === \`file://${process.argv[1]}\``. Use `process.argv[1]?.endsWith("<that-file's-name>")` instead.

**Why:** The server is bundled by esbuild into a single `dist/index.js`. After bundling, every
source module shares the SAME `import.meta.url` (the bundle's URL = `dist/index.js`), so the
`import.meta.url === file://${process.argv[1]}` check evaluates to `true` for ALL of them at startup.
That made every DB migration's standalone `run()` wrapper auto-fire on server boot in production
(but not in dev under tsx, where files stay separate). Each wrapper called `pool.end()` on the
**shared** app pool; the first close killed the pool, the rest crashed with
"Cannot use a pool after calling end on the pool" / "Called end on pool more than once", the process
exited, port 5000 never opened, the healthcheck returned 500, and the deploy/publish failed.

**How to apply:**
- Migrations live in `server/migrations/*.ts`. Each exports an `applyXxxMigration()` (uses the shared
  `pool` from `server/db`, releases its client, never closes the pool) — `server/index.ts` calls these
  at startup. That path is correct and must stay.
- The standalone `run()` blocks at the bottom (for `npx tsx <file>` one-off runs) are the danger: they
  call `pool.end()`. Guard them with `process.argv[1]?.endsWith("<filename>.ts")` so they fire ONLY on a
  real direct CLI run, never inside the bundle.
- Never call `pool.end()` on the shared pool from code that can run during server startup.
- Verify after a change: `npm run build`, then grep `dist/index.js` to confirm runners are gated by
  `endsWith("<file>.ts")` and no `=== file://...` comparison remains.
