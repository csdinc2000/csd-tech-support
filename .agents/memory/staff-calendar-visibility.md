---
name: Shared staff calendar visibility
description: Product decision for the calendar embedded in the CSD app.
---

Use the shared booking calendar as the app's calendar source. Schedulers can manage the full calendar; technicians can see assigned customer appointments only.

**Why:** the user selected the shared booking calendar and explicitly limited technician visibility to their assigned appointments.

**How to apply:** Keep calendar writes behind scheduling access. For technician reads, reuse the app's explicit staff assignments and fail closed when an appointment has no verified assignment.
