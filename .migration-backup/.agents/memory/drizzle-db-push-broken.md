---
name: db:push is broken in this repl
description: How schema migrations fail here and what to do instead
---

`npm run db:push` does NOT work in this environment.

- The script is `drizzle-kit push` (drizzle-kit pinned at ^0.18.1 in package.json).
- `drizzle-kit push` errors: `unknown command 'push'`.
- `drizzle-kit push:pg` also errors: `unknown command 'push:pg' (Did you mean up:pg?)`.
- The installed binary's command set is inconsistent with 0.18.1, suggesting a version/install mismatch.

**Why:** No working path to apply Drizzle schema changes to the Postgres DB right now.

**How to apply:** Avoid introducing `shared/schema.ts` structural changes (new tables/columns/indexes) that require a migration, because they cannot be pushed and will leave the schema ahead of the actual DB (drift). If a schema change is truly required, flag the broken db:push to the user first. `package.json` and `drizzle.config.ts` are forbidden to edit per project rules, so fixing the tooling needs user involvement. Prefer application-level solutions (e.g. a concurrency guard) over DB constraints when they achieve the same correctness.
