# Website Discovery & Security Intelligence — Initial Development Branch

Branch: `feature/website-discovery-intelligence`

## Implemented
- Separate CRM-gated `/website-discovery` page; existing `/dashboard` Technician Board is unchanged.
- CSD-style cards, red accents and existing sidebar layout.
- Search form and empty states that clearly identify disconnected provider services.
- Backend-independent analysis logic for licensed/authorized technology observations.
- Human-review-only quote calculation using supplied prices, with unit tests.

## Not yet connected
- Wappalyzer/BuiltWith or other licensed discovery API; searches are deliberately disabled.
- Business lead persistence, CRM insertion, reports, and PDF proposals.
- Any active website scans or version/vulnerability verification.

## Before launch
Configure provider credentials using secrets, apply explicit staff permissions and rate limiting to any new API endpoints, establish geographic coverage and usage rights, add database migrations, generate reports from verified evidence, and run all integration/build tests. Owner approval and a real test deployment are required before merging to the live application.
