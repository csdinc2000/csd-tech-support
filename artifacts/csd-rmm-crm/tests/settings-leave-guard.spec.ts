import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "PATCH" || route.request().method() === "PUT") {
      await route.fulfill({ status: 200, contentType: "application/json", body: route.request().postData() || "{}" });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: path === "/api/helpdesk/settings" ? '{"ticketNumberPrefix":"CSD"}' : "[]" });
    }
  });
});

test("phone settings retain a canceled route change and reload; discard removes the guard", async ({ page }) => {
  await page.goto("/tests/settings-leave-guard.fixture.html?page=phone");
  await page.getByTestId("input-forward-number").fill("+15559998888");
  const cancel = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.dismiss();
  });
  await Promise.all([page.getByTestId("link-leave-settings").click(), cancel]);
  await expect(page.getByTestId("input-forward-number")).toHaveValue("+15559998888");

  const reload = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("beforeunload");
    await dialog.dismiss();
  });
  await Promise.all([page.evaluate(() => window.location.reload()), reload]);
  await expect(page.getByTestId("input-forward-number")).toHaveValue("+15559998888");
  await page.getByTestId("button-discard-phone-settings").click();
  await expect(page.getByTestId("input-forward-number")).toHaveValue("+15550654321");
  await page.getByTestId("link-leave-settings").click();
  await expect(page).toHaveURL(/\/other-page$/);
});

test("phone settings warn on Back and clear the warning after a successful save", async ({ page }) => {
  await page.goto("/tests/settings-leave-guard.fixture.html?page=phone");
  await page.evaluate(() => {
    window.history.pushState({ fixtureLocation: "/phone" }, "", "/phone");
    window.history.pushState({ fixtureLocation: "/phone" }, "", "/phone?view=numbers");
  });
  await page.getByTestId("input-forward-number").fill("+15559998888");
  // First Back stays on the same page; the next Back leaves it.
  await page.evaluate(() => window.history.back());
  const cancel = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.dismiss();
  });
  await Promise.all([page.evaluate(() => window.history.back()), cancel]);
  await expect(page.getByTestId("input-forward-number")).toHaveValue("+15559998888");
  await page.getByTestId("button-save-settings").click();
  await expect(page.getByTestId("button-discard-phone-settings")).toHaveCount(0);
  await page.getByTestId("link-leave-settings").click();
  await expect(page).toHaveURL(/\/other-page$/);
});

test("helpdesk settings protect tab changes and route changes until discarded", async ({ page }) => {
  await page.goto("/tests/settings-leave-guard.fixture.html?page=helpdesk");
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.locator('input[value="CSD"]').fill("NEW");
  const cancel = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.dismiss();
  });
  await Promise.all([page.getByRole("tab", { name: "Reports" }).click(), cancel]);
  await expect(page.locator('input[value="NEW"]')).toBeVisible();
  await page.getByTestId("button-discard-helpdesk-settings").click();
  await page.locator('input[value="CSD"]').fill("SAVED");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("button-discard-helpdesk-settings")).toHaveCount(0);
  await page.getByTestId("link-leave-settings").click();
  await expect(page).toHaveURL(/\/other-page$/);
});

test("dispatch dialog retains its draft on canceled navigation and clears it on cancel", async ({ page }) => {
  await page.goto("/tests/settings-leave-guard.fixture.html?page=dispatch");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("textbox", { name: /Full name/ }).fill("Alex Updated");
  const cancel = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("beforeunload");
    await dialog.dismiss();
  });
  await Promise.all([page.evaluate(() => window.location.reload()), cancel]);
  await expect(page.getByRole("textbox", { name: /Full name/ })).toHaveValue("Alex Updated");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByTestId("link-leave-settings").click();
  await expect(page).toHaveURL(/\/other-page$/);
});