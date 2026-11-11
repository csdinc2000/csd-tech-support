---
name: Date-range API boundaries
description: How to preserve a user's local calendar range across browser, API, and timestamptz storage.
---

Convert user-selected local calendar dates into explicit UTC start-inclusive and end-exclusive instants in the browser. Compare stored `timestamptz` values directly against those instants.

**Why:** The UI renders timestamps in the user's local timezone. Database `date` casts use the session timezone, so implicit calendar-day boundaries can disagree with what the user sees and can change with database configuration.

**How to apply:** Keep the selected date labels in UI state, send their UTC boundary instants to the API, validate both bounds, and use `>= start AND < end`. Test records around midnight with a non-UTC offset.