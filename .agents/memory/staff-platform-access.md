---
name: Staff platform access
description: Identity and default-access rules for staff capabilities in the signed-in platform.
---

Platform roles and feature capabilities must attach to Clerk-backed `auth_users`, not the separate legacy helpdesk `users` identities. The verified owner allowlist determines owner identity and cannot be edited from the app, but explicit owner Pending or Suspended status revokes owner privileges, including Billing. Never disable the last active owner. Supported staff roles are Administrator, Field Technicians, Software Developer, Accounting, IT Manager, Legal Team, and Secretary. Public signup alone never provisions staff access. An owner-issued invitation establishes the intended role, but acceptance with the verified invited email and completed profile remains pending until an active owner explicitly approves access.

**Why:** The current onboarding requirement adds a distinct owner approval gate after invitation acceptance, superseding the earlier automatic-activation decision. Owner status controls also apply to owner accounts: allowlist-only authorization would silently ignore a suspended owner's status; disabling the last owner would lock the app. The two user stores serve different purposes. Using legacy ticket-assignee records for application authorization would leave signed-in technicians unmapped and could make toggles ineffective. Migrated local identities may already own history and assignments when the invited Clerk identity arrives. Automatically merging by email alone could take over another login or erase history; inferring a helpdesk link from email alone can silently change after an address edit. Administrator-granted changes also need a durable before/after audit trail.

**How to apply:** Fail closed for pending or suspended users, enforce every feature on the server as well as in navigation, keep billing active-owner-only, and limit staff role/permission mutation to Administrator or active owner accounts. For owners, keep role and feature grants immutable while allowing explicit status changes by another active owner; count distinct active owner emails before disabling one. Preserve legacy owner access until status was explicitly changed under the new controls. Distinguish manually created pending accounts from owner-invited accounts; do not reactivate an already approved or suspended profile through an invitation. Reconcile an invited existing local identity only after verified-email and invitation checks, never take over a different Clerk identity, and preserve the temporary sign-in bridge rather than deleting it. Link helpdesk assignees only through a separate owner action, and make Dispatch routing depend on that link and current approval.

For short-lived real-time credentials, bind an owner's token to the approval revision and reject it if the revision changes, even when the owner is currently approved again.

**Why:** Immediate in-process revocation closes live sockets, but a token issued in a concurrent request or held across suspension and reapproval must not become valid again.

**How to apply:** Check the current owner approval and the token's approval revision at redemption; disconnect live sessions on committed status changes for every local identity sharing that owner's verified email. Keep other owners' sessions untouched.

Staff Access directory visibility is separate from staff enrollment. Owners must be able to find all registered sign-in accounts in the people list, including accounts without local staff profiles. Unenrolled accounts must not be described as staff awaiting approval.

**Why:** The owner expects people with sign-in accounts to appear in Staff Access itself, not only a separate invitation finder. Displaying those accounts must not turn public signup into staff access or bypass invitation acceptance.

**How to apply:** Include sign-in-only identities in the owner-facing roster with an explicit onboarding status and invitation action. Only accepted, verified, completed staff onboarding can proceed to owner approval; showing an account never grants permissions or links another identity.

Staff enrollment is invitation-only. Invited people may use an existing sign-in account through email or Google; the verified account email must match the invitation. Do not offer direct email-based sign-in recovery that bypasses invitation acceptance.

**Why:** The user explicitly clarified: "I want by invitation only. If the user already have a sign in he or she can do it by email or google sign in."

**How to apply:** Require invitation acceptance and subsequent owner approval for new staff enrollment, including sign-in-only accounts already registered with Clerk. Preserve existing staff access and history; never guess an email or merge a legacy record by name.
