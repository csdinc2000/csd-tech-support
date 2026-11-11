import { expect, test, type Page } from "@playwright/test";

const FIXTURE = "/tests/portal-ads.fixture.html";

const ad = (id: number, overrides: Record<string, unknown> = {}) => ({
  id, title: `Spring tune-up ${id}`, body: "20% off tune-ups this month.", imageUrl: null, imageAlt: "",
  linkUrl: "/portal/referrals", linkLabel: "See offer", priority: 0, delaySeconds: 0, suppressHours: 24, ...overrides,
});

async function serveAds(page: Page, ads: unknown[]) {
  await page.route("**/api/portal/ads/active", (route) => route.fulfill({ json: { ads } }));
  await page.route("**/api/portal/ads/*/events", (route) => route.fulfill({ status: 204 }));
}

const events = (page: Page) => page.evaluate(() => window.adEvents);

test("the ad is a labelled dialog, traps focus, and Escape returns focus to the page", async ({ page }) => {
  await serveAds(page, [ad(1, { delaySeconds: 1 })]);
  await page.goto(FIXTURE);
  // The visitor is working on the page when the ad appears.
  await page.getByTestId("page-button").focus();
  const dialog = page.getByRole("dialog", { name: "Spring tune-up 1" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription("20% off tune-ups this month.");
  await expect(page.getByRole("button", { name: "Close" })).toBeVisible();

  // Tab cycles inside the dialog only.
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]")))).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("page-button")).toBeFocused();
  expect(await events(page)).toEqual([{ type: "impression", adId: 1 }, { type: "dismiss", adId: 1, reason: "escape" }]);
});

test("every exit works without completing an action: X, No thanks, and clicking outside", async ({ page }) => {
  for (const [exit, reason] of [["x", "close-button"], ["skip", "skip"], ["outside", "outside"]] as const) {
    await serveAds(page, [ad(2)]);
    await page.goto(FIXTURE);
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.reload();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    if (exit === "x") await page.getByRole("button", { name: "Close" }).click();
    if (exit === "skip") await page.getByTestId("portal-ad-skip").click();
    if (exit === "outside") await page.mouse.click(5, 5);
    await expect(dialog).toBeHidden();
    expect((await events(page)).at(-1)).toEqual({ type: "dismiss", adId: 2, reason });
  }
});

test("a dismissed ad stays hidden on reload; the next ad by priority shows instead", async ({ page }) => {
  await serveAds(page, [ad(3, { priority: 1 }), ad(4, { priority: 9 })]);
  await page.goto(FIXTURE);
  await expect(page.getByRole("dialog", { name: "Spring tune-up 4" })).toBeVisible();
  await page.getByTestId("portal-ad-skip").click();
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Spring tune-up 3" })).toBeVisible();
  await page.getByTestId("portal-ad-skip").click();
  await page.reload();
  await page.waitForTimeout(500);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the ad waits for its configured delay before appearing", async ({ page }) => {
  await serveAds(page, [ad(5, { delaySeconds: 2 })]);
  await page.goto(FIXTURE);
  await page.waitForTimeout(1_000);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 3_000 });
});

test("no ads, or a failing ads request, leave the portal untouched", async ({ page }) => {
  await page.route("**/api/portal/ads/active", (route) => route.fulfill({ status: 500, body: "boom" }));
  await page.goto(FIXTURE);
  await page.waitForTimeout(500);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("page-button")).toBeVisible();
});

test("staff create an ad with delay and hide period, and preview it", async ({ page }) => {
  const saved: any[] = [];
  await page.route("**/api/crm/portal-ads", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      saved.push(body);
      await route.fulfill({ status: 201, json: { ...ad(10, body), isActive: true, startsAt: null, endsAt: null, state: "live", impressions: 0, dismissals: 0, clicks: 0 } });
      return;
    }
    await route.fulfill({ json: { ads: saved.map((body, i) => ({ ...ad(10 + i, body), isActive: true, startsAt: null, endsAt: null, state: "live", impressions: 12, dismissals: 3, clicks: 2 })) } });
  });
  await page.goto(`${FIXTURE}?view=manager`);
  await page.getByTestId("portal-ad-new").click();
  await page.getByLabel("Headline").fill("Free virus scan");
  await page.getByLabel("Message").fill("Bring your laptop in this week.");
  await page.getByLabel(/Delay before showing/).fill("5");
  await page.getByRole("button", { name: "7 days" }).click();
  await expect(page.getByText("Hidden for 7 days on that device.")).toBeVisible();

  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("dialog", { name: "Free virus scan" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByTestId("portal-ad-save").click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toMatchObject({ title: "Free virus scan", delaySeconds: 5, suppressHours: 168, isActive: true });
  await expect(page.getByText("Shown 12 · clicked 2 (17%) · closed 3 (25%)")).toBeVisible();
});
