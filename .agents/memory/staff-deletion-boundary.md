---
name: Staff deletion boundary
description: Durable safety rules for removing signed-in staff identities across Clerk and the app database.
---

An owner-confirmed staff deletion must reject owner-allowlisted identities, self-deletion, and ambiguous or mismatched Clerk identities. Do not delete a linked legacy helpdesk assignee implicitly: it may own ticket history independent of the platform login.

**Why:** Clerk and the application database cannot participate in one atomic transaction. Deleting only the database row could leave a working Clerk sign-in, while deleting a helpdesk identity could erase unrelated operational history.

**How to apply:** Check the exact email and linked identity before deletion; prepare database changes in a transaction and roll them back if Clerk deletion fails. If the database commit fails after Clerk succeeds, report the partial outcome explicitly rather than claiming a clean deletion.