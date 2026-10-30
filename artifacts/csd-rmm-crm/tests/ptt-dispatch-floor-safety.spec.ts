import { expect, test, type Page } from "@playwright/test";
import { installPttFakes, routePttApi, type PttApiOptions } from "./ptt-dispatch.harness";

type TestWindow = Window & {
  __pttTest: {
    tracks: Array<{ enabled: boolean }>;
    getUserMediaCalls: () => number;
    pttSocket: () => { receive: (payload: unknown) => void; open: () => void };
    sentTypes: () => Array<{ type?: string; channelId?: string }>;
    hide: () => void;
  };
};

const OPERATOR = "operator-a";

/** Brings the page up to "connected, alone on Dispatch, nobody holding the floor". */
async function openConsole(page: Page, options: PttApiOptions = {}) {
  await installPttFakes(page);
  await routePttApi(page, options);
  await page.goto("/tests/ptt-dispatch.fixture.html");

  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as TestWindow).__pttTest.pttSocket())))
    .toBe(true);
  await page.evaluate(() => (window as unknown as TestWindow).__pttTest.pttSocket().open());
  await expect(page.getByTestId("ptt-signaling-status")).toHaveText("Signaling Online");

  await page.evaluate((operator) => {
    const socket = (window as unknown as TestWindow).__pttTest.pttSocket();
    socket.receive({ type: "hello", clientId: operator, operator: { name: "Test Operator" } });
    // Alone in the channel: no peers, so this exercises the floor paths only.
    socket.receive({
      type: "channel-state",
      channelId: "dispatch",
      users: [{ id: operator, name: "Test Operator" }],
      floorHolder: null,
    });
  }, OPERATOR);
}

const sent = (page: Page) =>
  page.evaluate(() => (window as unknown as TestWindow).__pttTest.sentTypes());

const trackEnabled = (page: Page) =>
  page.evaluate(() => (window as unknown as TestWindow).__pttTest.tracks.map((track) => track.enabled));

async function pressTransmit(page: Page) {
  const button = page.getByTestId("ptt-transmit-button");
  const box = await button.boundingBox();
  if (!box) throw new Error("transmit button is not visible");
  // A real mouse press: a synthetic pointerdown carries no usable pointerId
  // for the page's setPointerCapture call.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect
    .poll(async () => (await sent(page)).filter((message) => message.type === "floor-request").length)
    .toBeGreaterThan(0);
}

async function grantFloor(page: Page) {
  await page.evaluate((operator) => {
    (window as unknown as TestWindow).__pttTest
      .pttSocket()
      .receive({ type: "floor", action: "granted", clientId: operator, userName: "Test Operator" });
  }, OPERATOR);
  await expect.poll(() => trackEnabled(page)).toEqual([true]);
}

test("leaving the foreground mid-transmission releases the floor and mutes the microphone", async ({ page }) => {
  await openConsole(page);
  await pressTransmit(page);
  await grantFloor(page);
  await expect(page.getByTestId("ptt-transmit-countdown")).toBeVisible();

  await page.evaluate(() => (window as unknown as TestWindow).__pttTest.hide());

  await expect
    .poll(async () => (await sent(page)).filter((message) => message.type === "floor-release").length)
    .toBe(1);
  await expect.poll(() => trackEnabled(page)).toEqual([false]);
  await expect(page.getByTestId("ptt-transmit-countdown")).toHaveCount(0);

  // Releasing the still-held button must not send a second release.
  await page.mouse.up();
  await page.waitForTimeout(150);
  expect((await sent(page)).filter((message) => message.type === "floor-release")).toHaveLength(1);
});

test("a server-forced release clears the press so the next press transmits again", async ({ page }) => {
  await openConsole(page);
  await pressTransmit(page);
  await grantFloor(page);

  await page.evaluate((operator) => {
    (window as unknown as TestWindow).__pttTest.pttSocket().receive({
      type: "floor",
      action: "released",
      clientId: operator,
      forced: true,
      reason: "Maximum transmit time reached.",
    });
  }, OPERATOR);

  await expect.poll(() => trackEnabled(page)).toEqual([false]);
  await expect(page.getByTestId("page-ptt-dispatch")).toContainText("Maximum transmit time reached.");
  await expect(page.getByTestId("ptt-transmit-countdown")).toHaveCount(0);

  // The cut is a release, not a lockout: re-keying must raise a new request.
  await page.mouse.up();
  await pressTransmit(page);
  expect((await sent(page)).filter((message) => message.type === "floor-request")).toHaveLength(2);
});

test("the on-screen button still sends exactly one request and one release", async ({ page }) => {
  await openConsole(page);
  await pressTransmit(page);
  await grantFloor(page);
  await page.mouse.up();

  await expect
    .poll(async () => (await sent(page)).filter((message) => message.type === "floor-release").length)
    .toBe(1);
  await expect.poll(() => trackEnabled(page)).toEqual([false]);

  // onPointerUp and onPointerLeave both fire on a normal release.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);
  const messages = await sent(page);
  expect(messages.filter((message) => message.type === "floor-request")).toHaveLength(1);
  expect(messages.filter((message) => message.type === "floor-release")).toHaveLength(1);
  expect(await page.evaluate(() => (window as unknown as TestWindow).__pttTest.getUserMediaCalls())).toBe(1);
});

test("changing channel mid-transmission releases the old channel before joining the new one", async ({ page }) => {
  await openConsole(page);
  await pressTransmit(page);
  await grantFloor(page);

  await page.getByTestId("ptt-channel-field").press("Enter");

  await expect
    .poll(async () => (await sent(page)).some((message) => message.type === "join" && message.channelId === "field"))
    .toBe(true);

  const messages = await sent(page);
  const releaseIndex = messages.findIndex(
    (message) => message.type === "floor-release" && message.channelId === "dispatch",
  );
  const joinIndex = messages.findIndex(
    (message) => message.type === "join" && message.channelId === "field",
  );
  expect(releaseIndex, "the old channel is released").toBeGreaterThan(-1);
  expect(releaseIndex, "released before joining the new channel").toBeLessThan(joinIndex);
  await expect.poll(() => trackEnabled(page)).toEqual([false]);
});
