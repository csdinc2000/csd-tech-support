---
name: Generator compatibility boundary
description: Why generator-upgrade checks are isolated from full API type checks
---

Check generator compatibility with a small fixture and the installed workspace runtimes, separately from baseline API type-check cleanup and authorization tests.

**Why:** Setup-order tests intentionally replace generator/compiler executables; whole-workspace compilation can fail for unrelated existing debt and cannot isolate generator regressions. Generator tests must not regenerate tracked clients or access databases.

**How to apply:** Preserve that isolation when extending generator-upgrade checks. Import production generator settings, redirect all outputs into a disposable directory, and compile representative consumers against the real dependency versions.