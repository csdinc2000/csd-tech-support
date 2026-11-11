---
name: Managed preview port collisions
description: Why a healthy artifact preview can coexist with a failed web workflow after a duplicate Vite startup.
---

A managed web workflow can report a port-in-use failure even though the same artifact's older Vite process still serves the preview. A successful HTTP response alone does not mean the current managed workflow is healthy.

**Why:** Duplicate Vite startups for the artifact have left an earlier listener occupying its injected port on more than one occasion.

**How to apply:** Compare workflow status with the listener's command and artifact path. If it is confirmed to be an older instance of the same preview, stop only that listener and restart the existing managed workflow once; do not add a replacement workflow or change the artifact's port.