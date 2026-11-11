import { expect, test } from "@playwright/test";
import { installPttFakes, routePttApi } from "./ptt-dispatch.harness";

test("Retry Audio replaces only the failed peer and keeps the channel online", async ({ page }) => {
  await installPttFakes(page);
  await routePttApi(page);

  await page.goto("/tests/ptt-dispatch.fixture.html");
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__pttTest.pttSocket()))).toBe(true);
  await page.evaluate(() => (window as any).__pttTest.pttSocket().open());
  await expect(page.getByTestId("ptt-signaling-status")).toHaveText("Signaling Online");
  await page.evaluate(() => {
    const socket = (window as any).__pttTest.pttSocket();
    socket.receive({ type: "hello", clientId: "operator-a", operator: { name: "Test Operator" } });
    socket.receive({
      type: "channel-state",
      channelId: "dispatch",
      users: [
        { id: "operator-a", name: "Test Operator" },
        { id: "peer-failed-private-id", name: "Field One" },
        { id: "peer-healthy-private-id", name: "Field Two" },
      ],
      floorHolder: null,
    });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__pttTest.peers.length)).toBe(2);

  await page.evaluate(() => {
    const [failed, healthy] = (window as any).__pttTest.peers;
    failed.connect();
    healthy.connect();
  });
  await expect(page.getByTestId("ptt-peer-audio-status")).toHaveText("Peer Audio Ready");

  await page.evaluate(async () => {
    await (window as any).__pttTest.peers[0].becomeUnrecoverable();
  });
  const warning = page.getByTestId("ptt-peer-audio-warning");
  await expect(warning).toBeVisible();
  await expect(page.getByTestId("ptt-retry-audio")).toHaveText("Retry Audio");

  const beforeRetry = await page.evaluate(() => {
    const state = (window as any).__pttTest;
    state.pttSocket().sent = [];
    return {
      failedId: state.peers[0].instanceId,
      healthyId: state.peers[1].instanceId,
      socketId: state.pttSocket().instanceId,
      peerCount: state.peers.length,
    };
  });

  await page.getByTestId("ptt-retry-audio").click();
  await expect(page.getByTestId("ptt-retry-audio")).toHaveText("Retrying Audio");
  await expect(warning).toContainText("Retrying browser audio. Keep this channel open while audio reconnects.");
  await expect(page.getByTestId("ptt-signaling-status")).toHaveText("Signaling Online");
  await expect(page.getByText("Dispatch", { exact: true }).first()).toBeVisible();

  await expect.poll(() => page.evaluate(() => (window as any).__pttTest.peers.length)).toBe(3);
  await expect.poll(() => page.evaluate(() => {
    return (window as any).__pttTest.pttSocket().sent
      .map((payload: string) => JSON.parse(payload))
      .filter((message: any) => message.type === "signal")
      .map((message: any) => message.to);
  })).toEqual(["peer-failed-private-id"]);
  await page.evaluate(async () => {
    await (window as any).__pttTest.peers[2].becomeUnrecoverable();
  });
  await expect(page.getByTestId("ptt-retry-audio")).toHaveText("Retry Audio");
  await expect(warning).toBeVisible();

  await page.evaluate(() => {
    (window as any).__pttTest.pttSocket().sent = [];
  });
  await page.getByTestId("ptt-retry-audio").click();
  await expect.poll(() => page.evaluate(() => (window as any).__pttTest.peers.length)).toBe(4);
  await expect.poll(() => page.evaluate(() => {
    return (window as any).__pttTest.pttSocket().sent
      .map((payload: string) => JSON.parse(payload))
      .filter((message: any) => message.type === "signal")
      .map((message: any) => message.to);
  })).toEqual(["peer-failed-private-id"]);
  await page.evaluate(async () => {
    const state = (window as any).__pttTest;
    state.pttSocket().receive({
      type: "signal",
      from: "peer-failed-private-id",
      channelId: "dispatch",
      payload: { description: { type: "answer", sdp: "replacement-answer" } },
    });
    await Promise.resolve();
    await Promise.resolve();
    if (state.peers[3].signalingState !== "stable") {
      throw new Error("Replacement answer did not complete signaling.");
    }
    state.peers[3].connect();
  });
  await expect(warning).toBeHidden();
  await expect(page.getByTestId("ptt-peer-audio-status")).toHaveText("Peer Audio Ready");

  const afterRetry = await page.evaluate(() => {
    const state = (window as any).__pttTest;
    return {
      failedClosed: state.peers[0].closed,
      firstReplacementClosed: state.peers[2].closed,
      healthyId: state.peers[1].instanceId,
      healthyClosed: state.peers[1].closed,
      socketId: state.pttSocket().instanceId,
      pttSocketCount: state.sockets.filter((socket: any) => socket.url.includes("/ws/ptt")).length,
      peerCount: state.peers.length,
    };
  });
  expect(beforeRetry.peerCount).toBe(2);
  expect(afterRetry).toEqual({
    failedClosed: true,
    firstReplacementClosed: true,
    healthyId: beforeRetry.healthyId,
    healthyClosed: false,
    socketId: beforeRetry.socketId,
    pttSocketCount: 1,
    peerCount: 4,
  });

  const operatorCopy = await page.getByTestId("page-ptt-dispatch").innerText();
  expect(operatorCopy).not.toContain("peer-failed-private-id");
  expect(operatorCopy).not.toContain("peer-healthy-private-id");
  expect(operatorCopy).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  expect(operatorCopy).not.toContain("candidate:");
});