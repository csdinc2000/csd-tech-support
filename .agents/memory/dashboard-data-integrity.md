---
name: Dashboard data integrity
description: Rules for keeping the operational dashboard truthful and current.
---

The RMM dashboard must count only endpoints carrying a real remote-management provider identity. Manually seeded or disconnected demonstration rows must not be presented as monitored devices. Current online percentage is device availability, not historical uptime.

**Why:** Legacy sample devices made production look healthy despite the remote-management integration being unable to authenticate, while fixed trend and incident labels presented invented values as facts.

**How to apply:** Calculate dashboard breakdowns from current stored records, label each metric according to what it actually measures, poll operational data with a finite interval, and show an explicit empty or failure state when the upstream provider is unavailable.