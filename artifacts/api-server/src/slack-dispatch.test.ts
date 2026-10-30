import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchBestEffortSlack } from "./slack-dispatch";
import { logger } from "./lib/logger";

test("background dispatch returns before delivery settles", async () => {
  let started = false;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  let delivered = false;

  const result = dispatchBestEffortSlack(async () => {
    started = true;
    await pending;
    delivered = true;
  }, "automation");
  assert.equal(result, undefined);
  assert.equal(delivered, false);
  await Promise.resolve();
  assert.equal(started, true);
  assert.equal(delivered, false);
  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(delivered, true);
});

test("outbox dispatch waits for persistence, not provider delivery", async () => {
  let finish!: () => void;
  const pendingWrite = new Promise<void>((resolve) => { finish = resolve; });
  let saved = false;
  const enqueue = dispatchBestEffortSlack(async () => {
    await pendingWrite;
    saved = true;
  }, "ticket", "await-enqueue");
  assert.equal(saved, false);
  finish();
  await enqueue;
  assert.equal(saved, true);
});

test("sync throws and async rejections are sanitized and cannot escape dispatch", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = logger.warn;
  logger.warn = ((...args: unknown[]) => { warnings.push(args); }) as typeof logger.warn;
  try {
    assert.equal(dispatchBestEffortSlack(() => {
      throw new Error("private ticket content");
    }, "ticket"), undefined);
    assert.equal(dispatchBestEffortSlack(
      () => Promise.reject(new Error("private call content")),
      "call",
    ), undefined);
    await dispatchBestEffortSlack(
      () => { throw new Error("private emergency content"); },
      "emergency",
      "await-enqueue",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(warnings.length, 3);
    assert.doesNotMatch(JSON.stringify(warnings), /private|content/);
    assert.match(JSON.stringify(warnings), /ticket|call|emergency/);
  } finally {
    logger.warn = originalWarn;
  }
});