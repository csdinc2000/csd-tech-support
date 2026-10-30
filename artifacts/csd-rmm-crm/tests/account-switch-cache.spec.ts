import { expect, test, type Route } from "@playwright/test";

const accountData = {
  "staff-a": {
    "/api/dashboard/metrics": { label: "STAFF_A_DASHBOARD_SECRET" },
    "/api/clients": [{ name: "STAFF_A_CUSTOMER_SECRET" }],
    "/api/alerts/active": [{ title: "STAFF_A_ALERT_SECRET" }],
  },
  "staff-b": {
    "/api/dashboard/metrics": { label: "STAFF_B_DASHBOARD" },
    "/api/clients": [{ name: "STAFF_B_CUSTOMER" }],
    "/api/alerts/active": [{ title: "STAFF_B_ALERT" }],
  },
} as const;

test("clears prior staff data on rapid account switching and retains same-user cache", async ({ page }) => {
  let activeUser: keyof typeof accountData = "staff-a";
  const requestCounts = new Map<string, number>();

  await page.route("**/api/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname as keyof (typeof accountData)["staff-a"];
    requestCounts.set(`${activeUser}:${path}`, (requestCounts.get(`${activeUser}:${path}`) ?? 0) + 1);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(accountData[activeUser][path]),
    });
  });

  await page.goto("/tests/account-switch-cache.fixture.html");
  await page.getByRole("button", { name: "Sign in Staff A" }).click();
  await expect(page.getByTestId("dashboard-data")).toHaveText("STAFF_A_DASHBOARD_SECRET");
  await expect(page.getByTestId("customer-data")).toHaveText("STAFF_A_CUSTOMER_SECRET");
  await expect(page.getByTestId("alert-data")).toHaveText("STAFF_A_ALERT_SECRET");

  await page.getByRole("button", { name: "Customers" }).click();
  await expect(page.getByTestId("customers-page")).toBeVisible();
  await page.getByRole("button", { name: "Alerts" }).click();
  await expect(page.getByTestId("alerts-page")).toBeVisible();
  await page.getByRole("button", { name: "Dashboard" }).click();
  await expect(page.getByTestId("dashboard-page")).toBeVisible();

  for (const path of Object.keys(accountData["staff-a"])) {
    expect(requestCounts.get(`staff-a:${path}`)).toBe(1);
  }

  await page.getByRole("button", { name: "Sign out" }).click();
  activeUser = "staff-b";
  await page.getByRole("button", { name: "Sign in Staff B" }).click();

  await expect(page.getByTestId("current-user")).toHaveText("staff-b");
  await expect(page.getByTestId("dashboard-data")).toHaveText("STAFF_B_DASHBOARD");
  await expect(page.getByTestId("customer-data")).toHaveText("STAFF_B_CUSTOMER");
  await expect(page.getByTestId("alert-data")).toHaveText("STAFF_B_ALERT");

  const staffBHistory = await page.evaluate(() => window.__accountSwitchRenderHistory);
  expect(staffBHistory).not.toContain("staff-b:STAFF_A_DASHBOARD_SECRET");
  expect(staffBHistory).not.toContain("staff-b:STAFF_A_CUSTOMER_SECRET");
  expect(staffBHistory).not.toContain("staff-b:STAFF_A_ALERT_SECRET");
});

test("ignores first-account responses that resolve after a direct identity switch", async ({ page }) => {
  let activeUser: keyof typeof accountData = "staff-a";
  let releaseStaffA!: () => void;
  const staffAResponseGate = new Promise<void>((resolve) => {
    releaseStaffA = resolve;
  });

  await page.route("**/api/**", async (route: Route) => {
    const requestUser = activeUser;
    const path = new URL(route.request().url()).pathname as keyof (typeof accountData)["staff-a"];
    if (requestUser === "staff-a") await staffAResponseGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(accountData[requestUser][path]),
    });
  });

  await page.goto("/tests/account-switch-cache.fixture.html");
  await page.getByRole("button", { name: "Sign in Staff A" }).click();
  await expect(page.getByTestId("loading")).toBeVisible();

  activeUser = "staff-b";
  await page.getByRole("button", { name: "Sign in Staff B" }).click();
  releaseStaffA();

  await expect(page.getByTestId("dashboard-data")).toHaveText("STAFF_B_DASHBOARD");
  await expect(page.getByTestId("customer-data")).toHaveText("STAFF_B_CUSTOMER");
  await expect(page.getByTestId("alert-data")).toHaveText("STAFF_B_ALERT");

  const renderHistory = await page.evaluate(() => window.__accountSwitchRenderHistory);
  expect(renderHistory.filter((value) => value.startsWith("staff-b:STAFF_A_"))).toEqual([]);
});