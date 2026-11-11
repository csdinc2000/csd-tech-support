import { expect, test, type Route } from "@playwright/test";

const balanceCheckedAt = "2026-09-16T14:30:00.000Z";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/provider-health/slack/failures", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
    });
  });
  await page.route("**/api/provider-health/email/warning-settings/history**", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], nextCursor: null }),
    });
  });
});

test("ordinary signed-in staff cannot render the Provider Health page", async ({ page }) => {
  await page.goto("/tests/provider-health-route.fixture.html");

  await expect(page.getByRole("heading", { name: "Owner access required" })).toBeVisible();
  await expect(page.getByTestId("page-provider-health")).toHaveCount(0);
});

test("owner sees the current aggregate email balance with its check time", async ({ page }) => {
  await page.goto("/tests/provider-health-route.fixture.html?owner=true&balance=current");

  const balance = page.getByTestId("email-capacity-balance");
  await expect(balance).toContainText("1,250 of 5,000 credits remaining");
  await expect(balance).toContainText("25% remaining");
  await expect(balance).toContainText("Current balance");
  await expect(balance).toContainText(new Date(balanceCheckedAt).toLocaleString());
  await expect(balance).not.toContainText("Stale reading");
  await expect(balance).not.toContainText("Balance unavailable");
});

test("owner sees a stale prior email balance without a current label", async ({ page }) => {
  await page.goto("/tests/provider-health-route.fixture.html?owner=true&balance=stale");

  const balance = page.getByTestId("email-capacity-balance");
  await expect(balance).toContainText("1,250 of 5,000 credits remaining");
  await expect(balance).toContainText("25% remaining");
  await expect(balance).toContainText("Stale reading");
  await expect(balance).toContainText(new Date(balanceCheckedAt).toLocaleString());
  await expect(balance).not.toContainText("Current balance");
});

test("owner sees no reliable email balance without counts or a current label", async ({ page }) => {
  await page.goto("/tests/provider-health-route.fixture.html?owner=true&balance=unavailable");

  const balance = page.getByTestId("email-capacity-balance");
  await expect(balance).toContainText("Balance unavailable");
  await expect(balance).toContainText("No reliable SendGrid credit balance has been checked yet.");
  await expect(balance).not.toContainText("credits remaining");
  await expect(balance).not.toContainText("% remaining");
  await expect(balance).not.toContainText("Current balance");
});

test("owner can retry a failed initial load and see the recovered status", async ({ page }) => {
  let requestCount = 0;

  await page.route("**/api/provider-health/email", async (route: Route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          message: "Provider health is temporarily unavailable.",
          providerDetails: "SENDGRID_ACCOUNT_AND_QUOTA_DETAILS",
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        provider: "SendGrid",
        proactiveCapacityMonitoring: {
          available: true,
          state: "available",
          reason: null,
          checkedAt: "2026-09-16T16:00:00.000Z",
          balance: null,
        },
        warningSettings: { mode: "default", value: null },
        safeDefaults: { percentage: 10, remainingCredits: 100 },
      }),
    });
  });

  await page.goto("/tests/provider-health-route.fixture.html?owner=true&loadFromApi=true");

  await expect(page.getByText("Provider health could not load", { exact: true })).toBeVisible();
  await expect(page.getByText("Check your connection, then try again.")).toBeVisible();
  await expect(page.getByText("SENDGRID_ACCOUNT_AND_QUOTA_DETAILS")).toHaveCount(0);

  await page.getByRole("button", { name: "Try again" }).click();

  await expect(page.getByTestId("page-provider-health")).toBeVisible();
  await expect(page.getByText("Monitoring available", { exact: true })).toBeVisible();
  expect(requestCount).toBe(2);
});

test("owner sees the recheck pending state and returned result without refreshing", async ({ page }) => {
  let releaseRecheck!: () => void;
  const recheckGate = new Promise<void>((resolve) => {
    releaseRecheck = resolve;
  });
  const returnedCheckedAt = "2026-09-16T15:45:00.000Z";

  await page.route("**/api/provider-health/email/recheck", async (route: Route) => {
    await recheckGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: false,
        state: "unavailable",
        reason: "provider_unavailable",
        checkedAt: returnedCheckedAt,
        balance: null,
      }),
    });
  });

  await page.goto("/tests/provider-health-route.fixture.html?owner=true");
  const recheckButton = page.getByTestId("button-recheck-email-capacity");
  const lastChecked = page.getByTestId("text-email-capacity-last-checked");

  await expect(page.getByText("Monitoring available", { exact: true })).toBeVisible();
  await recheckButton.click();
  await expect(recheckButton).toBeDisabled();
  await expect(recheckButton).toHaveText("Rechecking…");

  releaseRecheck();

  await expect(recheckButton).toBeEnabled();
  await expect(recheckButton).toHaveText("Recheck now");
  await expect(page.getByText("Monitoring unavailable", { exact: true })).toBeVisible();
  await expect(lastChecked).toContainText(new Date(returnedCheckedAt).toLocaleString());
});

test("owner sees every displayed balance value refresh after a successful manual recheck", async ({ page }) => {
  const returnedCheckedAt = "2026-09-16T15:45:00.000Z";

  await page.route("**/api/provider-health/email/recheck", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: true,
        state: "available",
        reason: null,
        checkedAt: returnedCheckedAt,
        balance: {
          remaining: 3_600,
          total: 6_000,
          percentage: 60,
          checkedAt: returnedCheckedAt,
          stale: false,
        },
      }),
    });
  });

  await page.goto("/tests/provider-health-route.fixture.html?owner=true&balance=stale");

  const balance = page.getByTestId("email-capacity-balance");
  await expect(balance).toContainText("1,250 of 5,000 credits remaining");
  await expect(balance).toContainText("25% remaining");
  await expect(balance).toContainText("Stale reading");

  await page.getByTestId("button-recheck-email-capacity").click();

  await expect(balance).toContainText("3,600 of 6,000 credits remaining");
  await expect(balance).toContainText("60% remaining");
  await expect(balance).toContainText("Current balance");
  await expect(balance).toContainText(new Date(returnedCheckedAt).toLocaleString());
  await expect(balance).not.toContainText("1,250 of 5,000 credits remaining");
  await expect(balance).not.toContainText("25% remaining");
  await expect(balance).not.toContainText("Stale reading");
});

test("an older background refresh cannot replace a newer successful manual recheck", async ({ page }) => {
  const initialCheckedAt = "2026-09-16T14:30:00.000Z";
  const returnedCheckedAt = "2026-09-16T15:45:00.000Z";
  let providerHealthRequestCount = 0;
  let backgroundRefreshCompleted = false;
  let releaseBackgroundRefresh!: () => void;
  const backgroundRefreshGate = new Promise<void>((resolve) => {
    releaseBackgroundRefresh = resolve;
  });

  const providerHealthResponse = (checkedAt: string, remaining: number, total: number) => ({
    provider: "SendGrid",
    proactiveCapacityMonitoring: {
      available: true,
      state: "available",
      reason: null,
      checkedAt,
      balance: {
        remaining,
        total,
        percentage: Math.round((remaining / total) * 100),
        checkedAt,
        stale: false,
      },
    },
    warningSettings: { mode: "default", value: null },
    safeDefaults: { percentage: 10, remainingCredits: 100 },
  });

  await page.route("**/api/provider-health/email", async (route: Route) => {
    providerHealthRequestCount += 1;
    if (providerHealthRequestCount > 1) {
      await backgroundRefreshGate;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(providerHealthResponse(initialCheckedAt, 1_250, 5_000)),
    });
    if (providerHealthRequestCount > 1) {
      backgroundRefreshCompleted = true;
    }
  });
  await page.route("**/api/provider-health/email/recheck", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        providerHealthResponse(returnedCheckedAt, 3_600, 6_000).proactiveCapacityMonitoring,
      ),
    });
  });

  await page.goto(
    "/tests/provider-health-route.fixture.html?owner=true&loadFromApi=true&refreshControl=true",
  );
  const balance = page.getByTestId("email-capacity-balance");
  await expect(balance).toContainText("1,250 of 5,000 credits remaining");

  await page.getByTestId("trigger-provider-health-refresh").click();
  await expect.poll(() => providerHealthRequestCount).toBe(2);

  await page.getByTestId("button-recheck-email-capacity").click();
  await expect(balance).toContainText("3,600 of 6,000 credits remaining");
  await expect(balance).toContainText("60% remaining");
  await expect(balance).toContainText("Current balance");
  await expect(balance).toContainText(new Date(returnedCheckedAt).toLocaleString());

  releaseBackgroundRefresh();
  await expect.poll(() => backgroundRefreshCompleted).toBe(true);

  await expect(balance).toContainText("3,600 of 6,000 credits remaining");
  await expect(balance).toContainText("60% remaining");
  await expect(balance).toContainText("Current balance");
  await expect(balance).toContainText(new Date(returnedCheckedAt).toLocaleString());
  await expect(balance).not.toContainText("1,250 of 5,000 credits remaining");
  await expect(balance).not.toContainText("25% remaining");
  await expect(balance).not.toContainText(new Date(initialCheckedAt).toLocaleString());
});

test("an older background refresh cannot replace newly saved warning settings", async ({ page }) => {
  let providerHealthRequestCount = 0;
  let delayedRefreshCompleted = false;
  let releaseDelayedRefresh!: () => void;
  const delayedRefreshGate = new Promise<void>((resolve) => {
    releaseDelayedRefresh = resolve;
  });
  const providerHealthResponse = (warningSettings: { mode: string; value: number | null }) => ({
    provider: "SendGrid",
    proactiveCapacityMonitoring: {
      available: true,
      state: "available",
      reason: null,
      checkedAt: balanceCheckedAt,
      balance: null,
    },
    warningSettings,
    safeDefaults: { percentage: 10, remainingCredits: 100 },
  });

  await page.route("**/api/provider-health/email/warning-settings", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mode: "percentage", value: 35 }),
    });
  });
  await page.route("**/api/provider-health/email", async (route: Route) => {
    providerHealthRequestCount += 1;
    if (providerHealthRequestCount === 2) {
      await delayedRefreshGate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(providerHealthResponse({ mode: "default", value: null })),
      });
      delayedRefreshCompleted = true;
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(providerHealthResponse(
        providerHealthRequestCount === 1
          ? { mode: "default", value: null }
          : { mode: "percentage", value: 35 },
      )),
    });
  });

  await page.goto(
    "/tests/provider-health-route.fixture.html?owner=true&loadFromApi=true&refreshControl=true",
  );
  await expect(page.getByLabel("Warn me based on")).toContainText("Safe defaults");

  await page.getByTestId("trigger-provider-health-refresh").click();
  await expect.poll(() => providerHealthRequestCount).toBe(2);

  await page.getByLabel("Warn me based on").click();
  await page.getByRole("option", { name: "Percentage remaining" }).click();
  await page.locator("#warning-value").fill("35");
  await page.getByRole("button", { name: "Save warning threshold" }).click();

  await expect(page.getByText("Warning threshold saved", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Warn me based on")).toContainText("Percentage remaining");
  await expect(page.locator("#warning-value")).toHaveValue("35");

  releaseDelayedRefresh();
  await expect.poll(() => delayedRefreshCompleted).toBe(true);

  await expect(page.getByLabel("Warn me based on")).toContainText("Percentage remaining");
  await expect(page.locator("#warning-value")).toHaveValue("35");
});

test("a background refresh does not replace unsaved warning settings", async ({ page }) => {
  let providerHealthRequestCount = 0;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const providerHealthResponse = (warningSettings: { mode: string; value: number | null }) => ({
    provider: "SendGrid",
    proactiveCapacityMonitoring: {
      available: true,
      state: "available",
      reason: null,
      checkedAt: balanceCheckedAt,
      balance: null,
    },
    warningSettings,
    safeDefaults: { percentage: 10, remainingCredits: 100 },
  });

  await page.route("**/api/provider-health/email", async (route: Route) => {
    providerHealthRequestCount += 1;
    if (providerHealthRequestCount === 2) {
      await refreshGate;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(providerHealthResponse({ mode: "default", value: null })),
    });
  });

  await page.goto(
    "/tests/provider-health-route.fixture.html?owner=true&loadFromApi=true&refreshControl=true",
  );
  await expect(page.getByLabel("Warn me based on")).toContainText("Safe defaults");

  await page.getByTestId("trigger-provider-health-refresh").click();
  await expect.poll(() => providerHealthRequestCount).toBe(2);

  await page.getByLabel("Warn me based on").click();
  await page.getByRole("option", { name: "Percentage remaining" }).click();
  await page.locator("#warning-value").fill("42");

  releaseRefresh();
  await expect.poll(() => providerHealthRequestCount).toBe(2);

  await expect(page.getByLabel("Warn me based on")).toContainText("Percentage remaining");
  await expect(page.locator("#warning-value")).toHaveValue("42");
});

test("owner can discard a draft and restore the latest refreshed warning settings", async ({ page }) => {
  let providerHealthRequestCount = 0;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const providerHealthResponse = (warningSettings: { mode: string; value: number | null }) => ({
    provider: "SendGrid",
    proactiveCapacityMonitoring: {
      available: true,
      state: "available",
      reason: null,
      checkedAt: balanceCheckedAt,
      balance: null,
    },
    warningSettings,
    safeDefaults: { percentage: 10, remainingCredits: 100 },
  });

  await page.route("**/api/provider-health/email", async (route: Route) => {
    providerHealthRequestCount += 1;
    if (providerHealthRequestCount === 2) {
      await refreshGate;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(providerHealthResponse(
        providerHealthRequestCount === 1
          ? { mode: "default", value: null }
          : { mode: "remainingCredits", value: 275 },
      )),
    });
  });

  await page.goto(
    "/tests/provider-health-route.fixture.html?owner=true&loadFromApi=true&refreshControl=true",
  );
  const discardButton = page.getByTestId("button-discard-email-warning-settings");
  await expect(discardButton).toHaveCount(0);

  await page.getByTestId("trigger-provider-health-refresh").click();
  await expect.poll(() => providerHealthRequestCount).toBe(2);

  await page.getByLabel("Warn me based on").click();
  await page.getByRole("option", { name: "Percentage remaining" }).click();
  await page.locator("#warning-value").fill("42");
  await expect(discardButton).toBeVisible();

  releaseRefresh();
  await expect(page.getByLabel("Warn me based on")).toContainText("Percentage remaining");
  await expect(page.locator("#warning-value")).toHaveValue("42");

  await discardButton.click();

  await expect(page.getByLabel("Warn me based on")).toContainText("Credits remaining");
  await expect(page.locator("#warning-value")).toHaveValue("275");
  await expect(discardButton).toHaveCount(0);
});

test("owner can stay on provider health after canceling navigation with an unsaved draft", async ({ page }) => {
  await page.goto("/tests/provider-health-route.fixture.html?owner=true");
  await page.getByLabel("Warn me based on").click();
  await page.getByRole("option", { name: "Percentage remaining" }).click();
  await page.locator("#warning-value").fill("42");

  const canceledNavigation = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.dismiss();
  });
  await Promise.all([
    page.getByTestId("link-leave-provider-health").click(),
    canceledNavigation,
  ]);

  await expect(page.getByTestId("page-provider-health")).toBeVisible();
  await expect(page.locator("#warning-value")).toHaveValue("42");
  await expect(page.getByTestId("button-discard-email-warning-settings")).toBeVisible();

  const confirmedNavigation = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.accept();
  });
  await Promise.all([
    page.getByTestId("link-leave-provider-health").click(),
    confirmedNavigation,
  ]);
  await expect(page.getByTestId("page-provider-health")).toHaveCount(0);
});

test("owner is warned before reloading with an unsaved email warning draft", async ({ page }) => {
  await page.goto("/tests/provider-health-route.fixture.html?owner=true");
  await page.getByLabel("Warn me based on").click();
  await page.getByRole("option", { name: "Percentage remaining" }).click();
  await page.locator("#warning-value").fill("42");

  const canceledReload = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("beforeunload");
    await dialog.dismiss();
  });
  await Promise.all([
    page.evaluate(() => window.location.reload()),
    canceledReload,
  ]);

  await expect(page.getByTestId("page-provider-health")).toBeVisible();
  await expect(page.locator("#warning-value")).toHaveValue("42");
});

test("owner can cancel browser Back without losing the unsaved warning draft", async ({ page }) => {
  await page.goto("/tests/provider-health-route.fixture.html?owner=true");
  await page.getByTestId("link-leave-provider-health").click();
  await page.getByTestId("link-return-provider-health").click();
  await expect(page.getByTestId("page-provider-health")).toBeVisible();
  await page.getByLabel("Warn me based on").click();
  await page.getByRole("option", { name: "Percentage remaining" }).click();
  await page.locator("#warning-value").fill("42");

  const canceledBackNavigation = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.dismiss();
  });
  await Promise.all([
    page.evaluate(() => window.history.back()),
    canceledBackNavigation,
  ]);

  await expect(page.getByTestId("page-provider-health")).toBeVisible();
  await expect(page.locator("#warning-value")).toHaveValue("42");
  await expect(page.getByTestId("button-discard-email-warning-settings")).toBeVisible();
});

test("failed warning threshold save keeps the draft guarded until retry succeeds", async ({ page }) => {
  let saveAttempts = 0;
  await page.route("**/api/provider-health/email/warning-settings", async (route) => {
    saveAttempts += 1;
    await route.fulfill({
      status: saveAttempts === 1 ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(saveAttempts === 1
        ? { message: "Temporarily unavailable" }
        : { mode: "percentage", value: 42 }),
    });
  });
  await page.goto("/tests/provider-health-route.fixture.html?owner=true");
  await page.getByLabel("Warn me based on").click();
  await page.getByRole("option", { name: "Percentage remaining" }).click();
  await page.locator("#warning-value").fill("42");
  await page.getByRole("button", { name: "Save warning threshold" }).click();

  await expect(page.getByText("Warning threshold could not be saved", { exact: true })).toBeVisible();
  await expect(page.getByText("Your changes are still here. Try saving again or discard them.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Warn me based on")).toContainText("Percentage remaining");
  await expect(page.locator("#warning-value")).toHaveValue("42");
  await expect(page.getByTestId("button-discard-email-warning-settings")).toBeVisible();

  const canceledNavigation = page.waitForEvent("dialog").then(async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.dismiss();
  });
  await Promise.all([page.getByTestId("link-leave-provider-health").click(), canceledNavigation]);
  await expect(page.getByTestId("page-provider-health")).toBeVisible();
  await expect(page.locator("#warning-value")).toHaveValue("42");

  await page.getByRole("button", { name: "Save warning threshold" }).click();
  await expect(page.getByText("Warning threshold saved", { exact: true })).toBeVisible();
  expect(saveAttempts).toBe(2);
  await expect(page.getByTestId("button-discard-email-warning-settings")).toHaveCount(0);
});

test("owner can explicitly discard a warning draft after saving fails", async ({ page }) => {
  await page.route("**/api/provider-health/email/warning-settings", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "Temporarily unavailable" }),
    });
  });
  await page.goto("/tests/provider-health-route.fixture.html?owner=true");
  await page.getByLabel("Warn me based on").click();
  await page.getByRole("option", { name: "Credits remaining" }).click();
  await page.locator("#warning-value").fill("275");
  await page.getByRole("button", { name: "Save warning threshold" }).click();
  await expect(page.getByText("Warning threshold could not be saved", { exact: true })).toBeVisible();

  await page.getByTestId("button-discard-email-warning-settings").click();
  await expect(page.getByLabel("Warn me based on")).toContainText("Safe defaults");
  await expect(page.locator("#warning-value")).toHaveCount(0);
  await expect(page.getByTestId("button-discard-email-warning-settings")).toHaveCount(0);
});

test("saving or discarding warning settings clears the navigation warning", async ({ page }) => {
  await page.route("**/api/provider-health/email/warning-settings", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mode: "percentage", value: 42 }),
    });
  });
  await page.goto("/tests/provider-health-route.fixture.html?owner=true");

  let unexpectedDialog = false;
  page.on("dialog", async (dialog) => {
    unexpectedDialog = true;
    await dialog.dismiss();
  });

  await page.getByLabel("Warn me based on").click();
  await page.getByRole("option", { name: "Percentage remaining" }).click();
  await page.locator("#warning-value").fill("42");
  await page.getByTestId("button-discard-email-warning-settings").click();
  await page.getByTestId("link-leave-provider-health").click();
  await expect(page.getByTestId("page-provider-health")).toHaveCount(0);
  await expect.poll(() => unexpectedDialog).toBe(false);

  await page.getByTestId("link-return-provider-health").click();
  await expect(page.getByTestId("page-provider-health")).toBeVisible();
  await page.getByLabel("Warn me based on").click();
  await page.getByRole("option", { name: "Percentage remaining" }).click();
  await page.locator("#warning-value").fill("42");
  await page.getByRole("button", { name: "Save warning threshold" }).click();
  await expect(page.getByText("Warning threshold saved", { exact: true })).toBeVisible();
  await page.getByTestId("link-leave-provider-health").click();
  await expect(page.getByTestId("page-provider-health")).toHaveCount(0);
  await expect.poll(() => unexpectedDialog).toBe(false);
});

test("a delayed unchecked response cannot replace a successful manual recheck", async ({ page }) => {
  const initialCheckedAt = "2026-09-16T14:30:00.000Z";
  const returnedCheckedAt = "2026-09-16T15:45:00.000Z";
  let providerHealthRequestCount = 0;
  let backgroundRefreshCompleted = false;
  let releaseBackgroundRefresh!: () => void;
  const backgroundRefreshGate = new Promise<void>((resolve) => {
    releaseBackgroundRefresh = resolve;
  });
  const balanceStatus = {
    available: true,
    state: "available",
    reason: null,
    checkedAt: initialCheckedAt,
    balance: {
      remaining: 1_250,
      total: 5_000,
      percentage: 25,
      checkedAt: initialCheckedAt,
      stale: false,
    },
  };
  const providerHealthResponse = (proactiveCapacityMonitoring: Record<string, unknown>) => ({
    provider: "SendGrid",
    proactiveCapacityMonitoring,
    warningSettings: { mode: "default", value: null },
    safeDefaults: { percentage: 10, remainingCredits: 100 },
  });

  await page.route("**/api/provider-health/email", async (route: Route) => {
    providerHealthRequestCount += 1;
    const isBackgroundRefresh = providerHealthRequestCount > 1;
    if (isBackgroundRefresh) {
      await backgroundRefreshGate;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(providerHealthResponse(
        isBackgroundRefresh
          ? {
              available: false,
              state: "not_checked",
              reason: "not_checked",
              checkedAt: null,
              balance: null,
            }
          : balanceStatus,
      )),
    });
    if (isBackgroundRefresh) {
      backgroundRefreshCompleted = true;
    }
  });
  await page.route("**/api/provider-health/email/recheck", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...balanceStatus,
        checkedAt: returnedCheckedAt,
        balance: {
          remaining: 3_600,
          total: 6_000,
          percentage: 60,
          checkedAt: returnedCheckedAt,
          stale: false,
        },
      }),
    });
  });

  await page.goto(
    "/tests/provider-health-route.fixture.html?owner=true&loadFromApi=true&refreshControl=true",
  );
  const balance = page.getByTestId("email-capacity-balance");
  await expect(balance).toContainText("1,250 of 5,000 credits remaining");

  await page.getByTestId("trigger-provider-health-refresh").click();
  await expect.poll(() => providerHealthRequestCount).toBe(2);
  await page.getByTestId("button-recheck-email-capacity").click();
  await expect(balance).toContainText("3,600 of 6,000 credits remaining");

  releaseBackgroundRefresh();
  await expect.poll(() => backgroundRefreshCompleted).toBe(true);

  await expect(balance).toContainText("3,600 of 6,000 credits remaining");
  await expect(balance).toContainText("60% remaining");
  await expect(balance).toContainText("Current balance");
  await expect(balance).toContainText(new Date(returnedCheckedAt).toLocaleString());
  await expect(balance).not.toContainText("Balance unavailable");
});

test("owner sees a sanitized rate-limit error without provider details", async ({ page }) => {
  await page.route("**/api/provider-health/email/recheck", async (route: Route) => {
    await route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({
        message: "Please wait before checking again.",
        providerDetails: "SENDGRID_ACCOUNT_AND_QUOTA_DETAILS",
      }),
    });
  });

  await page.goto("/tests/provider-health-route.fixture.html?owner=true");
  await page.getByTestId("button-recheck-email-capacity").click();

  await expect(page.getByText("Email capacity could not be rechecked", { exact: true })).toBeVisible();
  await expect(page.getByText("429: Please wait before checking again.", { exact: true })).toBeVisible();
  await expect(page.getByText("SENDGRID_ACCOUNT_AND_QUOTA_DETAILS")).toHaveCount(0);
  await expect(page.getByTestId("button-recheck-email-capacity")).toBeEnabled();
});