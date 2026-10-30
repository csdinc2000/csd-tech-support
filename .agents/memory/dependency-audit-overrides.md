---
name: Dependency audit overrides
description: Why audited transitive packages may need narrow, major-aware pnpm overrides in this workspace.
---

When a compatible direct dependency still resolves an audited transitive package to a vulnerable version, prefer a patched release within the transitive package's existing major range. Keep parallel major versions separate rather than forcing all parents onto one version.

**Why:** A lockfile refresh can retain vulnerable transitive versions even when most direct dependencies are already current. Broad parent upgrades or one global override across incompatible majors create unnecessary runtime risk for a security-only change.

**How to apply:** Check the actual lockfile and a fresh audit first. Upgrade direct parents when a compatible fix exists; otherwise use narrow pnpm overrides for the affected transitive version ranges, regenerate the lockfile, and verify the audit, build, and affected app startup.