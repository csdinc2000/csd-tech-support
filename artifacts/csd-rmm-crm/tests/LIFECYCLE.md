# Long-session lifecycle regression

Run from the repository root:

```sh
pnpm --filter @workspace/csd-rmm-crm run test:lifecycle
```

The focused command type-checks the fixture, fakes and spec before running.
The browser checks are also included in the app's ordinary `test` command
through Playwright's test discovery. They use the existing Chromium executable/configuration and
starts an isolated Vite server on port 4174 when `PLAYWRIGHT_BASE_URL` is unset.
No sign-in, customer data, live provider traffic, or physical accessories are
required. All API calls are intercepted; the incoming-call endpoint is simulated.

## What it measures

- Ten warmup cycles followed by 120 measured cycles in one browser document
  (no reloads or new contexts between routes).
- Real Wouter route changes mount/unmount the unsaved-form hook, carousel,
  A2P subscription helper and accessory probe. The real incoming-call session
  remains mounted outside the changing route.
- Every cycle replaces the carousel API, verifies one live A2P subscription,
  pairs BLE and HID, and returns to the idle route. Global listeners, intervals,
  animation frames, accessory listeners, notification state, GATT/HID connections,
  MediaSession handlers, and object URLs must return to their warmed baseline.
  The shared history interceptor and necessary call polling/freshness timers
  must remain active. Late A2P callbacks must not update state.
- Chromium CDP forces garbage collection and measures retained JS heap, DOM
  nodes and DOM listeners at baseline and every 20 cycles. Limits are less than
  4 MiB total retained-heap growth, 16 KiB per cycle regression slope after the
  first measurement, and 100 additional retained DOM nodes/listeners.
  These are regression budgets, not proof of zero memory leakage.
- A simulated new call must still appear at the end of the soak.
- Separate deterministic checks navigate away during seven pending BLE/HID
  stages, remount the probe, then resolve or reject the old operation. Neither
  stale resources nor stale UI may survive.
- Repeated form replacement must not disable cancellation of browser Back.

The report attachment `lifecycle-retention.json` contains the measured cycles,
resource baseline and heap/DOM samples. Playwright writes it under the usual
ignored `test-results/` directory. For a longer local soak:

```sh
LIFECYCLE_CYCLES=600 pnpm --filter @workspace/csd-rmm-crm run test:lifecycle
```

At least 60 cycles are required; increase the Playwright timeout in the spec for
very long runs. The default is a bounded, accelerated route/resource soak, not
an hours-long wall-clock endurance test. It runs real production components in
a controlled fixture, not the full authenticated staff application or physical
BLE/HID drivers. Release-build, sleep/wake and real-device behavior need separate
verification. Do not loosen the budgets to hide growth: inspect the sample trend
and retained resources first.
