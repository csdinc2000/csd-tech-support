---
name: Database migration boundary
description: Why automated whole-schema Drizzle push is unsafe in this mixed migration project.
---

Do not run an automatic whole-schema Drizzle push during post-merge setup while the application still has tables managed by explicit idempotent API migrations.

**Why:** The central Drizzle schema does not describe every live application table. A schema push interprets those intentionally external tables as deletions and can offer to remove populated operational and access-control data. Drizzle may also attempt redundant unique constraints when legacy constraint names differ.

**How to apply:** Keep post-merge dependency reconciliation non-destructive. Apply database changes through the project's explicit migration path until all live tables are represented by one authoritative schema. Before adopting whole-schema push, compare the full development database to the schema and resolve every unmanaged table and legacy constraint name.