---
name: Internal alert visibility
description: Authorization boundary for alerts that describe internal staff or access incidents.
---

Alerts about internal staff access or recovery incidents must require explicit approved staff-administrator access. Do not infer permission from unrestricted customer or device scope.

**Why:** Assignment scope and internal administration are separate privileges. Treating broad operational visibility as administrative authority can expose sensitive internal incidents through shared alert feeds and metrics.

**How to apply:** When adding an internal alert source, enforce its visibility in the central server-side alert policy before customer/device checks, and keep ordinary customer and device alert behavior unchanged.