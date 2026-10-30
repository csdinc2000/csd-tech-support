---
name: Customer identity model
description: The durable distinction between customer accounts and individual CRM contacts.
---

The canonical customer/company account is a `clients` record. Individual people are `crm_contacts` records linked to an account; devices, tickets, alerts, jobs, invoices, and bookings should resolve back to that account without replacing either identifier.

**Why:** RMM and helpdesk records are company-scoped, while sales, jobs, bookings, and invoices are person-scoped. Treating both tables as interchangeable produced duplicate customer destinations and orphaned operational context.

**How to apply:** Put company accounts in the Customers directory, manage people within their account, derive account context from the selected contact, and never guess ambiguous links or trust public callers to submit internal contact IDs.