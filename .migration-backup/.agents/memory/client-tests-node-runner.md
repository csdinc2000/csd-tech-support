---
name: Client tests via Node runner
description: How to unit-test client-side logic given only the Node test runner
---
The test harness is `tsx --test server/__tests__/*.test.ts` (the `test` validation check). There is no jsdom, no @testing-library, and package.json must not be edited.

**Rule:** To cover client behavior, extract the pure logic out of the React component into a UI-free module under `client/src/lib/` (deps injected as callbacks/factories), then import it from a `server/__tests__/*.test.ts` file and drive it with fakes.

**Why:** Component rendering can't be tested here, but the glob picks up any `server/__tests__/*.test.ts`, and a no-import client module transpiles fine under tsx via a relative import (`../../client/src/lib/...`).

**How to apply:** Example — `client/src/lib/a2p-live.ts` (EventSource subscribe/reconnect/cleanup for the Messages banner) is tested by `server/__tests__/a2p-live-client.test.ts` with a FakeEventSource. Also note: full-project `tsc` OOMs in this repl; typecheck a single file instead.
