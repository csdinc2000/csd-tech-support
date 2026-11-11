---
name: Unsaved draft history guards
description: Why route-scoped popstate effects can miss Back navigation in the web app.
---

Browser Back can move to a different route and cause the router to unmount a settings form before that form's own `popstate` listener runs. A guard attached only in a component effect may never get its callback, even when the component had an unsaved draft.

**Why:** A real Staff Admin route test showed the destination URL and lost the draft without a prompt, while a standalone fixture had passed. The parent router's subscriber can remove later form listeners in the same history event.

**How to apply:** Install history interception before route subscriptions and keep the active dirty-form registration scoped to the form lifetime. Test Back from a parent route with an actual dirty editor, not only a standalone form fixture.

Do not move the shared history interception into a component effect as a listener-cleanup optimization. Keep a single early-registered app-lifetime handler and dispose it during hot module replacement; remove individual form registrations on unmount.

**Why:** Both real Staff Admin Back navigation and Provider Health leave/return/Back checks fail when interception is installed from the page effect, even with a capture-phase listener.

**How to apply:** Treat the shared interceptor as intentionally persistent, not a per-page leak. Lifecycle cleanup must preserve its ordering ahead of router subscribers.