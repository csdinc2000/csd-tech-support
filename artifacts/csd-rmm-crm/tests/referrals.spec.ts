import { expect, test, type Page, type Route } from "@playwright/test";

const program = {
  active: true,
  referrerReward: "$25 service credit",
  friendReward: "$10 off your first repair",
  terms: "Rewards are issued after your friend's first paid service.",
};

const dashboard = {
  referrer: { firstName: "Maria", code: "MARIA-7K3QD", shareUrl: "https://support.computersystemsdepot.com/intake?ref=MARIA-7K3QD", status: "active" },
  program,
  summary: { total: 2, pending: 1, qualified: 0, rewarded: 1, declined: 0 },
  referrals: [
    { friendName: "Devon P.", status: "pending", createdAt: "2026-10-28T15:00:00Z", rewardedAt: null },
    { friendName: "Priya N.", status: "rewarded", createdAt: "2026-10-01T15:00:00Z", rewardedAt: "2026-10-12T15:00:00Z" },
  ],
};

const staffData = {
  settings: program,
  summary: { total: 2, pending: 1, qualified: 1, rewarded: 0, declined: 0 },
  referrals: [
    {
      id: 7, status: "pending", friendName: "Devon Price", friendEmail: "devon@example.com", friendPhone: "+19545550102",
      existingCustomer: false, note: null, intakeRecordId: 31, leadId: 4, contactId: 2, createdAt: "2026-10-28T15:00:00Z",
      qualifiedAt: null, rewardedAt: null, referrer: { id: 1, name: "Maria Alvarez", email: "maria@example.com", code: "MARIA-7K3QD" },
      leadStatus: "won", jobCompleted: true,
    },
    {
      id: 8, status: "qualified", friendName: "Sam Okafor", friendEmail: null, friendPhone: "+19545550103",
      existingCustomer: true, note: null, intakeRecordId: 32, leadId: 5, contactId: 3, createdAt: "2026-10-20T15:00:00Z",
      qualifiedAt: "2026-10-25T15:00:00Z", rewardedAt: null, referrer: { id: 1, name: "Maria Alvarez", email: "maria@example.com", code: "MARIA-7K3QD" },
      leadStatus: "won", jobCompleted: true,
    },
  ],
  referrers: [
    { id: 1, code: "MARIA-7K3QD", fullName: "Maria Alvarez", email: "maria@example.com", phone: null, status: "active", createdAt: "2026-09-01T15:00:00Z", referralCount: 2, rewardedCount: 0, shareUrl: dashboard.referrer.shareUrl },
  ],
};

async function mockApi(page: Page, options: { active?: boolean } = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push({ method: request.method(), path, body: request.postDataJSON?.() ?? null });
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/portal/referrals/program") return json({ ...program, active: options.active ?? true });
    if (path === "/api/portal/referrals/join") return json({ ok: true, message: "Check your email for your referral link." });
    if (path === "/api/portal/referrals/r/good-token") return json(dashboard);
    if (path.startsWith("/api/portal/referrals/r/")) return json({ message: "This link is no longer valid." }, 404);
    if (path === "/api/portal/referrals/code/MARIA-7K3QD") return json({ valid: true, code: "MARIA-7K3QD", referrerFirstName: "Maria", friendReward: program.friendReward });
    if (path.startsWith("/api/portal/referrals/code/")) return json({ valid: false });
    if (path === "/api/crm/referrals") return json(staffData);
    if (path === "/api/crm/referrals/7" && request.method() === "PATCH") return json({ ok: true, emailed: false });
    if (path === "/api/crm/referrals/8" && request.method() === "PATCH") return json({ ok: true, emailed: true });
    return json({}, 404);
  });
  return calls;
}

test("portal home features the referral program", async ({ page }) => {
  await mockApi(page);
  await page.goto("/tests/referrals.fixture.html?path=/portal");
  await expect(page.getByTestId("card-refer-friend")).toContainText("Give $10 off your first repair. Get $25 service credit.");
});

test("customers join from the portal and are told to check their email", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/tests/referrals.fixture.html");
  await expect(page.getByTestId("referral-headline")).toHaveText("Give $10 off your first repair. Get $25 service credit.");
  await page.getByLabel("Your name").fill("Maria Alvarez");
  await page.getByLabel("Email").fill("maria@example.com");
  await page.getByTestId("referral-join-submit").click();
  await expect(page.getByTestId("referral-join-success")).toContainText("maria@example.com");
  expect(calls.find((c) => c.path === "/api/portal/referrals/join")?.body).toEqual({ fullName: "Maria Alvarez", email: "maria@example.com", phone: "" });
  await page.screenshot({ path: "test-results/referrals-join.png", fullPage: true });
});

test("a paused program hides the join form", async ({ page }) => {
  await mockApi(page, { active: false });
  await page.goto("/tests/referrals.fixture.html");
  await expect(page.getByTestId("referral-paused")).toBeVisible();
  await expect(page.getByTestId("referral-join-submit")).toHaveCount(0);
});

test("the private dashboard shows the code, share options and masked referrals", async ({ page }) => {
  await mockApi(page);
  await page.goto("/tests/referrals.fixture.html?path=/portal/referrals/r/good-token");
  await expect(page.getByTestId("referral-dashboard-title")).toHaveText("Hi Maria!");
  await expect(page.getByTestId("referral-code")).toHaveText("MARIA-7K3QD");
  await expect(page.getByTestId("referral-share-url")).toHaveText(dashboard.referrer.shareUrl);
  await expect(page.getByTestId("share-sms")).toHaveAttribute("href", /^sms:\?&body=.*MARIA-7K3QD/);
  await expect(page.getByTestId("share-email")).toHaveAttribute("href", /^mailto:\?subject=/);
  const list = page.getByTestId("referral-list");
  await expect(list).toContainText("Devon P.");
  await expect(list).toContainText("Waiting for first service");
  await expect(list).toContainText("Reward issued");
  await page.screenshot({ path: "test-results/referrals-dashboard.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "test-results/referrals-dashboard-phone.png", fullPage: true });
});

test("an old dashboard link explains how to get a new one", async ({ page }) => {
  await mockApi(page);
  await page.goto("/tests/referrals.fixture.html?path=/portal/referrals/r/stale");
  await expect(page.getByTestId("referral-dashboard-invalid")).toContainText("no longer valid");
});

test("a friend arriving through a share link is greeted and can remove the code", async ({ page }) => {
  await mockApi(page);
  await page.goto("/tests/referrals.fixture.html?path=/intake&ref=MARIA-7K3QD");
  const banner = page.getByTestId("referral-banner");
  await expect(banner).toContainText("Maria referred you!");
  await expect(banner).toContainText("$10 off your first repair");
  // The code survives navigation (stored), so it still applies on a later visit.
  await page.goto("/tests/referrals.fixture.html?path=/intake");
  await expect(banner).toBeVisible();
  await banner.getByLabel("Remove referral code").click();
  await expect(banner).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("csd:referral-code"))).toBeNull();

  await page.goto("/tests/referrals.fixture.html?path=/intake&ref=BOGUS-ZZZZZ");
  await expect(page.getByTestId("referral-banner")).toHaveCount(0);
});

test("staff qualify and reward referrals; only owners edit rewards", async ({ page }) => {
  const calls = await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/tests/referrals.fixture.html?path=/staff");
  await expect(page.getByTestId("ref-stat-pending")).toContainText("1 with a completed job");
  const row = page.getByTestId("ref-row-7");
  await expect(row).toContainText("Job completed");
  await row.getByTestId("ref-action-7-qualified").click();
  await expect.poll(() => calls.find((c) => c.method === "PATCH" && c.path === "/api/crm/referrals/7")?.body).toEqual({ status: "qualified" });

  await page.getByTestId("ref-filter-qualified").click();
  const ready = page.getByTestId("ref-row-8");
  await expect(ready).toContainText("Existing customer");
  await ready.getByTestId("ref-action-8-rewarded").click();
  await expect(page.getByText("The referrer was emailed.").first()).toBeVisible();
  await expect(page.getByTestId("ref-settings").getByLabel("Referrer reward")).toBeEnabled();
  await page.screenshot({ path: "test-results/referrals-staff.png", fullPage: true });

  await page.goto("/tests/referrals.fixture.html?path=/staff&admin=0");
  await expect(page.getByTestId("ref-settings").getByLabel("Referrer reward")).toBeDisabled();
  await expect(page.getByTestId("ref-settings").getByRole("button", { name: "Save settings" })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "test-results/referrals-staff-phone.png", fullPage: true });
});
