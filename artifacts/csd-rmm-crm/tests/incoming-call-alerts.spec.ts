import { expect, test, type Page, type Route } from "@playwright/test";

type RingingCall = { id: string };

async function installAudioStub(page: Page) {
  await page.addInitScript(() => {
    const win = window as any;
    win.__fakeAudio = { contexts: [], oscillatorStarts: 0, behavior: "allowed" };

    class FakeOscillator {
      frequency = { value: 0 };
      onended: (() => void) | null = null;
      connect() {}
      disconnect() {}
      start() { win.__fakeAudio.oscillatorStarts += 1; }
      stop() { this.onended?.(); }
    }

    class FakeGain {
      gain = {
        setValueAtTime() {},
        linearRampToValueAtTime() {},
      };
      connect() {}
      disconnect() {}
    }

    class FakeAudioContext {
      state: AudioContextState = "suspended";
      currentTime = 0;
      destination = {};
      constructor() { win.__fakeAudio.contexts.push(this); }
      createOscillator() { return new FakeOscillator(); }
      createGain() { return new FakeGain(); }
      async resume() {
        if (win.__fakeAudio.behavior === "blocked") throw new Error("audio blocked");
        this.state = "running";
      }
      async suspend() { this.state = "suspended"; }
      async close() { this.state = "closed"; }
    }

    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: FakeAudioContext,
    });
  });
}

async function stubRingingEndpoint(
  page: Page,
  response: () => Promise<{ status?: number; ringing?: RingingCall[] }> | { status?: number; ringing?: RingingCall[] },
) {
  const requests: string[] = [];
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/twilio/ringing-calls") {
      requests.push(request.method());
      const result = await response();
      await route.fulfill({
        status: result.status ?? 200,
        contentType: "application/json",
        body: JSON.stringify(result.status && result.status >= 400
          ? { error: "Call alert status is unavailable" }
          : { ringing: result.ringing ?? [], checkedAt: new Date().toISOString() }),
      });
      return;
    }
    // These tests must never send calls, texts, or other mutations.
    await route.abort();
  });
  return requests;
}

async function openAlerts(page: Page, query = "", viewport = { width: 1280, height: 800 }) {
  await page.setViewportSize(viewport);
  await page.goto(`/tests/incoming-call-alerts.fixture.html${query}`);
  return page.getByRole("region", { name: "Incoming call alerts" });
}

test.beforeEach(async ({ page }) => {
  await installAudioStub(page);
});

test("approved staff session can unlock and test sound, mute, and re-enable it", async ({ page }) => {
  await stubRingingEndpoint(page, () => ({ ringing: [] }));
  const alerts = await openAlerts(page);

  await expect(alerts).toContainText("Incoming call sound is off");
  await page.getByRole("button", { name: "Enable call sound" }).click();
  await expect(page.getByRole("button", { name: "Test sound" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__fakeAudio.oscillatorStarts)).toBeGreaterThan(0);

  const startsBeforeTest = await page.evaluate(() => (window as any).__fakeAudio.oscillatorStarts);
  await page.getByRole("button", { name: "Test sound" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__fakeAudio.oscillatorStarts)).toBeGreaterThan(startsBeforeTest);

  await page.getByRole("button", { name: "Mute" }).click();
  await expect(page.getByRole("button", { name: "Enable call sound" })).toBeVisible();
  await expect(alerts).toContainText("Incoming call sound is off");

  await page.getByRole("button", { name: "Enable call sound" }).click();
  await expect(page.getByRole("button", { name: "Test sound" })).toBeVisible();
});

test("a blocked audio unlock reports the problem and can be retried", async ({ page }) => {
  await stubRingingEndpoint(page, () => ({ ringing: [] }));
  const alerts = await openAlerts(page);
  await page.evaluate(() => { (window as any).__fakeAudio.behavior = "blocked"; });

  await page.getByRole("button", { name: "Enable call sound" }).click();
  await expect(alerts.getByRole("alert")).toContainText("Your browser blocked sound");
  await expect(page.getByRole("button", { name: "Enable call sound" })).toBeVisible();

  await page.evaluate(() => { (window as any).__fakeAudio.behavior = "allowed"; });
  await page.getByRole("button", { name: "Enable call sound" }).click();
  await expect(page.getByRole("button", { name: "Test sound" })).toBeVisible();
});

test("sound can be enabled after a browser suspension", async ({ page }) => {
  await stubRingingEndpoint(page, () => ({ ringing: [{ id: "call-parent-a" }] }));
  const alerts = await openAlerts(page);
  await expect(alerts).toContainText("Incoming CSD call — phones ringing.");
  await page.getByRole("button", { name: "Enable call sound" }).click();
  await expect(page.getByRole("button", { name: "Test sound" })).toBeVisible();

  await page.evaluate(() => {
    (window as any).__fakeAudio.contexts.at(-1).state = "suspended";
  });
  await expect(alerts.getByRole("alert")).toContainText("Sound was paused by your browser", { timeout: 5_000 });
  await expect(page.getByRole("button", { name: "Enable call sound" })).toBeVisible();
});

test("silence follows the same parent call across backup-leg polling", async ({ page }) => {
  let responseCount = 0;
  await stubRingingEndpoint(page, () => {
    responseCount += 1;
    // The endpoint reports the same parent-call ID while different backup
    // forwarding legs continue to ring.
    return { ringing: [{ id: "same-parent-call" }] };
  });
  const alerts = await openAlerts(page);
  await page.getByRole("button", { name: "Enable call sound" }).click();
  const startsBeforeSilence = await page.evaluate(() => (window as any).__fakeAudio.oscillatorStarts);
  await page.getByRole("button", { name: "Silence this call" }).click();
  await expect(alerts).toContainText("Incoming CSD call — phones ringing.");
  await expect.poll(() => responseCount).toBeGreaterThan(1);
  await expect.poll(() => page.evaluate(() => (window as any).__fakeAudio.oscillatorStarts))
    .toBe(startsBeforeSilence);
});

test("reload starts muted and requires a new audio unlock", async ({ page }) => {
  await stubRingingEndpoint(page, () => ({ ringing: [] }));
  let alerts = await openAlerts(page);
  await page.getByRole("button", { name: "Enable call sound" }).click();
  await expect(page.getByRole("button", { name: "Test sound" })).toBeVisible();

  await page.reload();
  alerts = page.getByRole("region", { name: "Incoming call alerts" });
  await expect(alerts).toContainText("Incoming call sound is off");
  await expect(page.getByRole("button", { name: "Enable call sound" })).toBeVisible();
});

test("stale ringing data is hidden while the status request is still pending", async ({ page }) => {
  let requestCount = 0;
  await stubRingingEndpoint(page, async () => {
    requestCount += 1;
    if (requestCount === 1) return { ringing: [{ id: "stale-parent-call" }] };
    return new Promise(() => {});
  });
  const alerts = await openAlerts(page);
  await expect(alerts).toContainText("Incoming CSD call — phones ringing.");
  await expect.poll(() => requestCount).toBeGreaterThan(1, { timeout: 5_000 });
  await expect(alerts).toContainText("Reconnecting call alerts…", { timeout: 10_000 });
  await expect(alerts).not.toContainText("Incoming CSD call — phones ringing.");
  await expect(page.getByRole("button", { name: "Silence this call" })).toHaveCount(0);
});

test("a polling error hides the last ringing result and reports the connection problem", async ({ page }) => {
  let requestCount = 0;
  await stubRingingEndpoint(page, () => {
    requestCount += 1;
    return requestCount === 1
      ? { ringing: [{ id: "failed-parent-call" }] }
      : { status: 503 };
  });
  const alerts = await openAlerts(page);
  await expect(alerts).toContainText("Incoming CSD call — phones ringing.");
  await expect.poll(() => requestCount).toBeGreaterThan(1, { timeout: 5_000 });
  await expect(alerts).toContainText("Live call alerts unavailable");
  await expect(alerts).not.toContainText("Incoming CSD call — phones ringing.");
  await expect(page.getByRole("button", { name: "Silence this call" })).toHaveCount(0);
});

test("call sound and silence reset when the signed-in identity changes", async ({ page }) => {
  await stubRingingEndpoint(page, () => ({ ringing: [{ id: "identity-call" }] }));
  const alerts = await openAlerts(page);
  await page.getByRole("button", { name: "Enable call sound" }).click();
  await page.getByRole("button", { name: "Silence this call" }).click();

  await page.evaluate(() => (window as any).__incomingCallFixture.setUserId("replacement-staff"));
  await expect(alerts).toContainText("Incoming CSD call — phones ringing.");
  await expect(page.getByRole("button", { name: "Enable call sound" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Silence this call" })).toBeVisible();
  const startsAfterIdentityChange = await page.evaluate(() => (window as any).__fakeAudio.oscillatorStarts);
  await page.getByRole("button", { name: "Enable call sound" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__fakeAudio.oscillatorStarts))
    .toBeGreaterThan(startsAfterIdentityChange);
});

test("revoking communications access hides calls, stops sound, and stops polling", async ({ page }) => {
  const requests = await stubRingingEndpoint(page, () => ({ ringing: [{ id: "revoked-access-call" }] }));
  const alerts = await openAlerts(page);
  await expect(alerts).toContainText("Incoming CSD call — phones ringing.");
  await page.getByRole("button", { name: "Enable call sound" }).click();
  await expect(page.getByRole("button", { name: "Test sound" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__fakeAudio.oscillatorStarts))
    .toBeGreaterThan(0);

  await page.evaluate(() => (window as any).__incomingCallFixture.setAccessProfile({
    approvalStatus: "approved",
    canCommunicate: false,
  }));
  await expect(page.getByRole("region", { name: "Incoming call alerts" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() =>
    (window as any).__fakeAudio.contexts.at(-1)?.state,
  )).toBe("closed");

  const requestsAfterRevocation = requests.length;
  const oscillatorStartsAfterRevocation = await page.evaluate(() => (window as any).__fakeAudio.oscillatorStarts);
  await page.waitForTimeout(3_500);
  await expect(page.getByRole("region", { name: "Incoming call alerts" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__fakeAudio.oscillatorStarts))
    .toBe(oscillatorStartsAfterRevocation);
  expect(requests.length).toBe(requestsAfterRevocation);
});

test("staff session without sign-in, approval, or communications access cannot see or poll call alerts", async ({ page }) => {
  let requestCount = 0;
  await stubRingingEndpoint(page, () => {
    requestCount += 1;
    return { ringing: [{ id: "denied-call" }] };
  });
  await openAlerts(page, "?signedIn=false");
  await expect(page.getByRole("region", { name: "Incoming call alerts" })).toHaveCount(0);
  await expect.poll(() => requestCount).toBe(0);

  await page.goto("/tests/incoming-call-alerts.fixture.html?approval=pending");
  await expect(page.getByRole("region", { name: "Incoming call alerts" })).toHaveCount(0);
  await expect.poll(() => requestCount).toBe(0);

  await page.goto("/tests/incoming-call-alerts.fixture.html?communications=false");
  await expect(page.getByRole("region", { name: "Incoming call alerts" })).toHaveCount(0);
  expect(requestCount).toBe(0);
});

for (const viewport of [
  { name: "desktop", size: { width: 1280, height: 800 } },
  { name: "mobile", size: { width: 390, height: 844 } },
]) {
  test(`alert controls fit the ${viewport.name} layout`, async ({ page }) => {
    await stubRingingEndpoint(page, () => ({ ringing: [{ id: "layout-parent-call" }] }));
    const alerts = await openAlerts(page, "", viewport.size);
    await expect(alerts).toBeVisible();
    await expect(alerts.getByRole("button", { name: "Enable call sound" })).toBeVisible();
    await expect(alerts.getByRole("button", { name: "Silence this call" })).toBeVisible();
    const dimensions = await alerts.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  });
}
