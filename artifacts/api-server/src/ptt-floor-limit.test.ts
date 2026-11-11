import assert from "node:assert/strict";
import { test } from "node:test";
import { maxTransmitMs, shouldForceReleaseFloor } from "./ptt.ts";
import { ROIP_GATEWAY_HOLDER } from "./roip.ts";

const limit = 60_000;
const holder = "operator-client-id";

test("a browser floor is force-released only once the transmit limit is reached", () => {
  const grantedAt = 1_000_000;
  const at = (now: number) =>
    shouldForceReleaseFloor({ holderId: holder, grantedAt, now, maxTransmitMs: limit });

  assert.equal(at(grantedAt), false);
  assert.equal(at(grantedAt + limit - 1), false);
  assert.equal(at(grantedAt + limit), true);
  assert.equal(at(grantedAt + limit * 10), true);
});

test("the radio gateway is never bounded by the operator transmit limit", () => {
  // The gateway is released by GATEWAY_HANGOVER_MS instead. An hour-old grant
  // must still not expire here, or a long radio transmission gets cut.
  assert.equal(
    shouldForceReleaseFloor({
      holderId: ROIP_GATEWAY_HOLDER,
      grantedAt: 0,
      now: 60 * 60 * 1000,
      maxTransmitMs: limit,
    }),
    false,
  );
});

test("an unheld or undeadlined floor is never force-released", () => {
  assert.equal(
    shouldForceReleaseFloor({ holderId: undefined, grantedAt: 0, now: 10 ** 9, maxTransmitMs: limit }),
    false,
  );
  assert.equal(
    shouldForceReleaseFloor({ holderId: holder, grantedAt: null, now: 10 ** 9, maxTransmitMs: limit }),
    false,
  );
});

test("the transmit limit falls back to the default unless the environment parses", () => {
  assert.equal(maxTransmitMs({}), 60_000);
  assert.equal(maxTransmitMs({ PTT_MAX_TRANSMIT_MS: "" }), 60_000);
  assert.equal(maxTransmitMs({ PTT_MAX_TRANSMIT_MS: "not-a-number" }), 60_000);
});

test("the transmit limit reads a prefixed or unprefixed environment variable", () => {
  assert.equal(maxTransmitMs({ PTT_MAX_TRANSMIT_MS: "5000" }), 5_000);
  assert.equal(maxTransmitMs({ MAX_TRANSMIT_MS: "5000" }), 5_000);
  assert.equal(
    maxTransmitMs({ PTT_MAX_TRANSMIT_MS: "5000", MAX_TRANSMIT_MS: "9000" }),
    5_000,
    "the PTT-prefixed name wins",
  );
});

test("the transmit limit is clamped to a usable range", () => {
  assert.equal(maxTransmitMs({ PTT_MAX_TRANSMIT_MS: "10" }), 250);
  assert.equal(maxTransmitMs({ PTT_MAX_TRANSMIT_MS: "-1" }), 250);
  assert.equal(maxTransmitMs({ PTT_MAX_TRANSMIT_MS: "99999999" }), 10 * 60 * 1000);
});
