---
name: Publish-safe database expressions
description: Constraints for indexes and CHECK expressions that must survive development-to-production Publish diff serialization.
---

Prefer ordinary column indexes over runtime-created function expression indexes when the index will be discovered from the development database by Publish.

**Why:** A valid PostgreSQL expression index using a multi-argument function was introspected correctly in development but serialized into truncated, invalid SQL during Publish diff validation.

**How to apply:** Keep normalization in application queries unless the normalized value is represented through a publish-compatible schema design. Inspect generated migration SQL for complete function arguments before relying on expression indexes.

Avoid literal semicolons inside CHECK-expression strings that Publish must serialize. If the exact permitted value contains a semicolon, concatenate `chr(59)` instead of changing the value or removing validation.

**Why:** A valid PostgreSQL CHECK containing a fixed outcome message was truncated at its quoted semicolon in a freshly recomputed Publish diff. The subsequent parser error pointed at the next constraint, not the actual truncation.

**How to apply:** Compare `pg_get_constraintdef` with the freshly generated diff before choosing a fix. Preserve the allowed value set, replace only the equivalent development constraint atomically, and validate the regenerated SQL in isolated rollback-only objects. Production changes stay in Publish.