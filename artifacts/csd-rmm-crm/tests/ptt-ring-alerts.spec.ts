import { expect, test, type Page } from "@playwright/test";

const DIRECT = "direct:11111111-2222-4333-8444-555555555555";

type Ring = { id: number; groupId: string; callerUserId: string; callerName: string; channelId: string; channelName: string; createdAt: string; expiresAt: string };

function ring(overrides: Partial<Ring> = {}): Ring {
  const now = Date.now();
  return {
    id: 7,
    groupId: "11111111-2222-4333-8444-555555555555",
    callerUserId: "staff-a",
    callerName: "Fran Desk",
    channelId: DIRECT,
    channelName: "Private call",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 45_000).toISOString(),
    ...overrides,
  };
}

async function installAudioStub(page: Page) {
  await page.addInitScript(() => {
    const win = window as any;
    win.__ringTones = 0;
    class FakeNode { connect() {} disconnect() {} }
    class FakeOscillator extends FakeNode {
      type = "sine"; frequency = { value: 0 }; onended: (() => void) | null = null;
      start() { win.__ringTones += 1; } stop() { this.onended?.(); }
    }
    class FakeGain extends FakeNode { gain = { setValueAtTime() {}, linearRampToValueAtTime() {} }; }
    class FakeAudioContext {
      state = "running"; currentTime = 0; destination = {};
      createOscillator() { return new FakeOscillator(); }
      createGain() { return new FakeGain(); }
      async resume() {} async close() { this.state = "closed"; }
    }
    Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext });
  });
}

/** Serves the incoming poll from `rings()` and records answer/decline calls. */
async function routeRingApi(page: Page, rings: () => Ring[]) {
  const responses: Array<{ id: string; action: string }> = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/ptt/pages/incoming") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ serverTime: new Date().toISOString(), rings: rings() }) });
      return;
    }
    const respond = url.pathname.match(/^\/api\/ptt\/pages\/(\d+)\/respond$/);
    if (request.method() === "POST" && respond) {
      const { action } = request.postDataJSON() as { action: string };
      responses.push({ id: respond[1], action });
      const current = rings().find((r) => String(r.id) === respond[1]);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: action === "answer" ? "answered" : "declined", channelId: current?.channelId ?? DIRECT }),
      });
      return;
    }
    await route.abort();
  });
  return responses;
}

test("a private-call ring pops up with the caller, rings, and Answer opens the PTT console in that call", async ({ page }) => {
  await installAudioStub(page);
  let rings = [ring()];
  const responses = await routeRingApi(page, () => rings);
  await page.goto("/tests/ptt-ring-alerts.fixture.html");

  const popup = page.getByTestId("ptt-ring-popup");
  await expect(popup).toBeVisible();
  await expect(popup).toHaveAttribute("role", "alertdialog");
  await expect(page.getByTestId("ptt-ring-caller")).toHaveText("Fran Desk");
  await expect(popup).toContainText("Private call");
  await expect(popup).toContainText("Answer to open a private call");
  await expect.poll(() => page.evaluate(() => (window as any).__ringTones)).toBeGreaterThan(0);

  await page.getByTestId("ptt-ring-answer").click();
  rings = [];
  await expect(popup).toBeHidden();
  expect(responses).toEqual([{ id: "7", action: "answer" }]);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/ptt");
  const url = new URL(page.url());
  expect(url.searchParams.get("channel")).toBe(DIRECT);
  expect(url.searchParams.get("with")).toBe("Fran Desk");
  // An already-open console is told to switch too.
  expect(await page.evaluate(() => (window as any).__joinEvents)).toEqual([{ channelId: DIRECT, label: "Fran Desk" }]);
});

test("an everyone ring names the talk group; Decline dismisses it without leaving the page", async ({ page }) => {
  await installAudioStub(page);
  let rings = [ring({ id: 9, channelId: "dispatch", channelName: "Dispatch", callerName: "Owner Olivia" })];
  const responses = await routeRingApi(page, () => rings);
  await page.goto("/tests/ptt-ring-alerts.fixture.html");

  const popup = page.getByTestId("ptt-ring-popup");
  await expect(popup).toContainText("All staff · Dispatch");
  await expect(popup).toContainText("Answer to join Dispatch");
  await page.getByTestId("ptt-ring-decline").click();
  rings = [];
  await expect(popup).toBeHidden();
  expect(responses).toEqual([{ id: "9", action: "decline" }]);
  expect(new URL(page.url()).pathname).toBe("/tests/ptt-ring-alerts.fixture.html");
});

test("several people calling at once are queued, and expired rings never pop up", async ({ page }) => {
  await installAudioStub(page);
  const now = Date.now();
  const rings = [
    ring({ id: 1, callerName: "Alex Tech" }),
    ring({ id: 2, callerName: "Blair Tech" }),
    ring({ id: 3, callerName: "Expired Ed", expiresAt: new Date(now - 1000).toISOString() }),
  ];
  await routeRingApi(page, () => rings);
  await page.goto("/tests/ptt-ring-alerts.fixture.html");
  await expect(page.getByTestId("ptt-ring-caller")).toHaveText("Alex Tech");
  await expect(page.getByTestId("ptt-ring-more")).toHaveText("+1 more calling you");
});

test("staff without PTT access never poll or see the pop-up", async ({ page }) => {
  let polls = 0;
  await page.route("**/api/**", async (route) => {
    polls += 1;
    await route.abort();
  });
  await page.goto("/tests/ptt-ring-alerts.fixture.html?allowed=false");
  await page.waitForTimeout(1000);
  await expect(page.getByTestId("ptt-ring-popup")).toHaveCount(0);
  expect(polls).toBe(0);
});
