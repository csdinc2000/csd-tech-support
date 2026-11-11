#!/bin/bash
set -e
pnpm install --frozen-lockfile

# Reconcile generated React Query exports and Zod schemas before workflows
# restart. The codegen script also runs typecheck:libs to build shared types;
# keep this after install and fail setup if generation or that build fails.
pnpm --filter @workspace/api-spec run codegen

# Do not run `drizzle-kit push` here. This application still has tables managed
# by explicit idempotent API migrations that are intentionally absent from the
# central Drizzle schema; a whole-schema push would attempt to drop live data.
