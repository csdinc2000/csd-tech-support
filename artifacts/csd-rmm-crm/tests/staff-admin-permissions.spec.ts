import { expect, test } from "@playwright/test";

const fixture = (role: string, target = "/staff") =>
  `/tests/staff-admin-permissions.fixture.html?role=${role}&target=${encodeURIComponent(target)}`;

test("owner sees Roles & Access and Dispatch Settings in the unified Staff area", async ({ page }) => {
  await page.goto(fixture("owner"));

  await expect(page.getByRole("tab", { name: "Roles & Access" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Dispatch Settings" })).toBeVisible();
  await expect(page.getByTestId("roles-access-view")).toBeVisible();

  await page.getByRole("tab", { name: "Dispatch Settings" }).click();
  await expect(page.getByTestId("dispatch-settings-view")).toBeVisible();
});

test("staff administrator sees Roles & Access without owner-only Dispatch Settings", async ({ page }) => {
  await page.goto(fixture("staff-admin"));

  await expect(page.getByTestId("roles-access-view")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Dispatch Settings" })).toHaveCount(0);
  await expect(page.getByTestId("dispatch-settings-view")).toHaveCount(0);
});

test("staff without administration access sees the approval-required state", async ({ page }) => {
  await page.goto(fixture("staff"));

  await expect(page.getByRole("heading", { name: "Feature approval required" })).toBeVisible();
  await expect(page.getByTestId("roles-access-view")).toHaveCount(0);
  await expect(page.getByTestId("dispatch-settings-view")).toHaveCount(0);
});

test("legacy staff URLs preserve the unified view authorization boundary", async ({ page }) => {
  await page.goto(fixture("staff-admin", "/staff-access"));
  await expect(page).toHaveURL(/\/staff\?tab=access$/);
  await expect(page.getByTestId("roles-access-view")).toBeVisible();

  await page.goto(fixture("staff-admin", "/dispatch-settings"));
  await expect(page).toHaveURL(/\/staff\?tab=dispatch$/);
  await expect(page.getByTestId("roles-access-view")).toBeVisible();
  await expect(page.getByTestId("dispatch-settings-view")).toHaveCount(0);

  await page.goto(fixture("owner", "/dispatch-settings"));
  await expect(page).toHaveURL(/\/staff\?tab=dispatch$/);
  await expect(page.getByTestId("dispatch-settings-view")).toBeVisible();
});

test("same-path query navigation switches Staff Admin tabs reactively", async ({ page }) => {
  await page.goto(fixture("owner", "/staff?tab=access"));
  await expect(page.getByTestId("roles-access-view")).toBeVisible();
  await page.evaluate(() => {
    window.history.pushState(null, "", "/staff?tab=dispatch");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByTestId("dispatch-settings-view")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Dispatch Settings" })).toHaveAttribute("data-state", "active");

  await page.evaluate(() => {
    window.history.pushState(null, "", "/staff?tab=access");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByTestId("roles-access-view")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Roles & Access" })).toHaveAttribute("data-state", "active");
});

test("canonical staff dispatch assignee link opens a preselected add form and keeps the dispatch tab", async ({ page }) => {
  await page.route("**/api/staff-dispatch/settings", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ recipients: [], routing: { activeCallRecipients: [], activeMessageRecipients: [] } }),
  }));
  await page.route("**/api/staff-dispatch/eligible-assignees", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([{
      id: 123,
      name: "Taylor Technician",
      email: "taylor@example.invalid",
      staffRole: "field_technician",
      approvalStatus: "approved",
    }]),
  }));
  await page.route("**/api/staff-dispatch/audit", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));

  await page.goto(`${fixture("owner", "/staff?tab=dispatch&assigneeId=123")}&realDispatch=true&assigneeHandoff=true`);
  await expect(page).toHaveURL(/\/staff\?tab=dispatch$/);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add dispatch recipient" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /Full name/ })).toHaveValue("Taylor Technician");
  await expect(page.getByLabel("Dispatch role")).toHaveValue("technician");
  await expect(page.getByRole("switch").nth(0)).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("switch").nth(1)).toHaveAttribute("aria-checked", "false");
});

test("owner can cancel a Staff Admin tab switch while dispatch is dirty", async ({ page }) => {
  await page.goto(fixture("owner", "/staff?tab=dispatch"));
  await page.getByTestId("fixture-dirty-dispatch").evaluate((element: HTMLElement) => element.click());
  const cancelTab = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.dismiss();
  });
  await Promise.all([page.getByRole("tab", { name: "Roles & Access" }).click(), cancelTab]);
  await expect(page.getByTestId("dispatch-settings-view")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Dispatch Settings" })).toHaveAttribute("data-state", "active");
});

test("owner can cancel same-path query navigation while dispatch is dirty", async ({ page }) => {
  await page.goto(fixture("owner", "/staff?tab=dispatch"));
  await page.getByTestId("fixture-dirty-dispatch").evaluate((element: HTMLElement) => element.click());
  const cancelQueryNavigation = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.dismiss();
  });
  await Promise.all([
    page.evaluate(() => {
      window.history.pushState(null, "", "/staff?tab=access");
      window.dispatchEvent(new PopStateEvent("popstate"));
    }),
    cancelQueryNavigation,
  ]);
  await expect(page).toHaveURL(/\/staff\?tab=dispatch$/);
  await expect(page.getByTestId("dispatch-settings-view")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Dispatch Settings" })).toHaveAttribute("data-state", "active");
});

test("owner keeps an actual dispatch edit when canceling browser Back", async ({ page }) => {
  await page.route("**/api/staff-dispatch/settings", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        recipients: [{ id: 1, name: "Alex", role: "staff", phone: "+15550123456", enabled: true, onDuty: true, receiveCalls: true, receiveMessages: true, canUseCommands: false, linkedUserId: null, staffAccessApproved: true, updatedAt: "" }],
        routing: { activeCallRecipients: [1], activeMessageRecipients: [1] },
      }),
    }));
  await page.route("**/api/staff-dispatch/eligible-assignees", async (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/staff-dispatch/audit", async (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto(`${fixture("owner", "/staff?tab=dispatch")}&realDispatch=true`);
  await page.evaluate(() => {
    window.history.pushState(null, "", "/other-page");
    window.history.pushState(null, "", "/staff?tab=dispatch");
  });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("textbox", { name: /Full name/ }).fill("Alex Updated");

  const cancelBack = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.dismiss();
  });
  await Promise.all([page.evaluate(() => window.history.back()), cancelBack]);
  await expect(page).toHaveURL(/\/staff\?tab=dispatch$/);
  await expect(page.getByRole("textbox", { name: /Full name/ })).toHaveValue("Alex Updated");

  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("tab", { name: "Roles & Access" }).click();
  await expect(page.getByTestId("roles-access-view")).toBeVisible();
});