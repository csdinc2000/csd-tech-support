import { expect, test, type Page, type Route } from "@playwright/test";

const NOW = new Date("2026-10-30T13:00:00-04:00");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const contacts = [
  { id: 1, fullName: "Maria Alvarez", mobilePhone: "+19545550101", email: "maria@example.com" },
  { id: 2, fullName: "Devon Price", mobilePhone: "+19545550102", email: "devon@example.com" },
];

// Intake leads: source is the arrival path, campaign is the "how did you hear" answer.
const leads = [
  { id: 1, contactId: 1, source: "website_intake", campaign: "Google Search", intakeRecordId: 31, status: "won", estimatedValue: 150, serviceType: "virus_removal", createdAt: daysAgo(3) },
  { id: 2, contactId: 2, source: "website_intake", campaign: "Social Media", intakeRecordId: 32, status: "new", estimatedValue: 200, serviceType: "data_recovery", createdAt: daysAgo(5) },
  { id: 3, contactId: null, source: "referral", campaign: null, intakeRecordId: null, status: "lost", estimatedValue: 90, serviceType: "tune_up", createdAt: daysAgo(10) },
  { id: 4, contactId: null, source: "google_ads", campaign: "Old Promo", intakeRecordId: null, status: "new", estimatedValue: 75, serviceType: "tune_up", createdAt: daysAgo(200) },
];

const intakes = [
  { id: 31, customerName: "Maria Alvarez", source: "website_intake", howDidYouHear: "Google Search", campaign: null, status: "contacted", createdAt: daysAgo(3) },
  { id: 32, customerName: "Devon Price", source: "website_intake", howDidYouHear: "Social Media", campaign: "fall-promo", status: "new", createdAt: daysAgo(5) },
];

const jobs = [
  { id: 11, jobNumber: "CSD-2026-0011", leadId: 1, contactId: 1, serviceType: "virus_removal", status: "completed", finalAmount: 180, estimatedAmount: 150, updatedAt: daysAgo(1) },
  { id: 12, jobNumber: "CSD-2026-0012", leadId: 2, contactId: 2, serviceType: "data_recovery", status: "in_progress", finalAmount: null, estimatedAmount: 200, updatedAt: daysAgo(1) },
];

async function mockApi(page: Page) {
  await page.clock.setFixedTime(NOW);
  await page.route("**/api/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/crm/leads") return json(leads);
    if (path === "/api/intake") return json({ intakes, total: intakes.length, page: 1, totalPages: 1 });
    if (path === "/api/crm/jobs") return json(jobs);
    if (path === "/api/crm/contacts") return json(contacts);
    if (path === "/api/call-tracking/analytics/by-channel") return json([{ sourceChannel: "Google PPC", totalCalls: 6, uniqueCallers: 5 }]);
    if (path === "/api/call-tracking/analytics/by-number") {
      return json([
        { trackingNumberId: 1, phoneNumber: "+19545550199", campaignName: "Fall Promo", sourceChannel: "Facebook", totalCalls: 4, uniqueCallers: 4, voicemails: 0, avgDuration: 60 },
        { trackingNumberId: 2, phoneNumber: "+19545550188", campaignName: null, sourceChannel: null, totalCalls: 2, uniqueCallers: 2, voicemails: 0, avgDuration: 30 },
      ]);
    }
    if (path === "/api/call-tracking/analytics/by-day") return json([{ day: daysAgo(2).slice(0, 10), count: 6 }]);
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
}

test("overview attributes leads to how-heard channels and switches range", async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/marketing.fixture.html");

  await expect(page.getByTestId("mkt-stat-leads")).toContainText("3");
  await expect(page.getByTestId("mkt-stat-intakes")).toContainText("2");
  await expect(page.getByTestId("mkt-stat-calls")).toContainText("6");
  await expect(page.getByTestId("mkt-stat-close")).toContainText("50%");
  await expect(page.getByTestId("mkt-stat-revenue")).toContainText("$180");

  const table = page.getByTestId("mkt-attribution");
  await expect(table.getByTestId("mkt-channel-row-Google Search")).toContainText("$180");
  await expect(table.getByTestId("mkt-channel-row-Social Media")).toBeVisible();
  await expect(table.getByTestId("mkt-channel-row-Google Ads")).toContainText("6");
  await expect(table.getByTestId("mkt-channel-row-Website")).toHaveCount(0);
  await page.screenshot({ path: "test-results/marketing-overview.png", fullPage: true });

  await page.getByTestId("mkt-range-365").click();
  await expect(page.getByTestId("mkt-stat-leads")).toContainText("4");
});

test("campaigns merge UTM-tagged intakes with tracking numbers", async ({ page }) => {
  await mockApi(page);
  await page.goto("/tests/marketing.fixture.html?path=/marketing/campaigns");

  const campaign = page.getByTestId("mkt-campaign-Fall Promo");
  await expect(campaign).toContainText("Social Media");
  await expect(campaign).toContainText("4"); // calls from the Fall Promo number
  await expect(page.getByTestId("marketing-campaigns")).toContainText("1 number has no campaign name");
  await expect(page.getByTestId("marketing-campaigns")).not.toContainText("Google Search");
});

test("tools build tracked links and personalized review requests", async ({ page }) => {
  await mockApi(page);
  await page.goto("/tests/marketing.fixture.html?path=/marketing/tools");

  await expect(page.getByTestId("mkt-review-body")).toHaveValue(/Hi Maria, thanks for choosing Computer Systems Depot for your virus removal/);
  await expect(page.getByTestId("mkt-review-job-12")).toHaveCount(0); // not completed

  await page.getByTestId("mkt-tool-utm").click();
  await expect(page.getByTestId("mkt-utm-error")).toContainText("Campaign is required");
  await page.getByLabel("Campaign").fill("Fall Promo");
  await expect(page.getByTestId("mkt-utm-result")).toHaveText(
    "https://support.computersystemsdepot.com/intake?utm_source=facebook&utm_medium=social&utm_campaign=fall-promo",
  );

  await page.getByTestId("mkt-tool-content").click();
  await page.getByTestId("mkt-idea-promo-offer").click();
  await page.getByLabel("Offer or quote").fill("$20 off virus removal");
  await expect(page.getByTestId("mkt-post")).toHaveValue(/This week only at Computer Systems Depot: \$20 off virus removal/);
});

test("playbook progress persists and modules respect access", async ({ page }) => {
  await mockApi(page);
  await page.goto("/tests/marketing.fixture.html?path=/marketing/playbook&features=crm");
  await page.getByTestId("playbook-w-reviews").check();
  await page.reload();
  await expect(page.getByTestId("playbook-w-reviews")).toBeChecked();

  await page.goto("/tests/marketing.fixture.html?path=/marketing/channels&features=crm&admin=0");
  await expect(page.getByTestId("mkt-module-leads")).toBeVisible();
  await expect(page.getByTestId("mkt-module-inbox")).toHaveCount(0);
  await expect(page.getByTestId("mkt-module-tracking")).toHaveCount(0);
  // Without Communications the call metric is withheld rather than shown as zero.
  await page.goto("/tests/marketing.fixture.html?features=crm");
  await expect(page.getByTestId("mkt-stat-calls")).toContainText("Needs Communications");
});

test("stays usable on phone and tablet widths", async ({ page }) => {
  await mockApi(page);
  for (const [width, height, name] of [[390, 844, "phone"], [820, 1180, "tablet"]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/tests/marketing.fixture.html");
    await expect(page.getByTestId("mkt-stat-leads")).toContainText("3");
    // Phones get channel cards instead of the wide table.
    if (name === "phone") await expect(page.getByTestId("mkt-channel-Google Search")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `test-results/marketing-${name}.png`, fullPage: true });
  }
});
