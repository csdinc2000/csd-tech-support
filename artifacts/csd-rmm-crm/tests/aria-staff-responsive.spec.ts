import { expect, test, type Locator, type Page } from "@playwright/test";

const routes = [
  { path: "/tickets", action: (page: Page) => page.getByRole("button", { name: "New Ticket" }) },
  { path: "/crm/contacts", action: (page: Page) => page.getByTestId("button-add-contact") },
  { path: "/invoices", action: (page: Page) => page.getByTestId("button-new-invoice") },
  { path: "/scheduling", action: (page: Page) => page.getByTestId("button-save-calendar") },
  // Transmission is intentionally disabled until an audio session connects.
  { path: "/ptt", action: (page: Page) => page.getByTestId("ptt-channel-dispatch") },
];

async function navigate(page: Page, path: string) {
  await page.evaluate((target) => {
    history.pushState(null, "", target);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

async function assertActionReachable(page: Page, action: Locator, widget: Locator) {
  await expect(action).toBeVisible();
  await action.scrollIntoViewIfNeeded();
  // A trial click checks Playwright's hit testing without triggering a mutation.
  await action.click({ trial: true, timeout: 3000 });
  const actionBox = await action.boundingBox();
  const widgetBox = await widget.boundingBox();
  expect(actionBox).not.toBeNull();
  expect(widgetBox).not.toBeNull();
  const a = actionBox!;
  const w = widgetBox!;
  expect(Math.min(a.x + a.width, w.x + w.width) - Math.max(a.x, w.x) > 0 &&
    Math.min(a.y + a.height, w.y + w.height) - Math.max(a.y, w.y) > 0).toBe(false);
}

test("staff actions remain reachable around ARIA at phone widths; desktop floats and chat survives route changes", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/auth/access") return json({
      approvalStatus: "approved",
      features: { helpdesk: true, crm: true, invoices: true, scheduling: true, communications: true },
    });
    if (path === "/api/aria/status") return json({ configured: true, defaultModel: "claude", models: [{ name: "claude", configured: true }] });
    if (path === "/api/aria/conversations" && route.request().method() === "POST") return json({ id: 1 });
    if (path === "/api/aria/chat/stream") return route.fulfill({
      contentType: "text/event-stream",
      body: 'data: {"type":"chunk","content":"Ready to help"}\n\ndata: {"type":"done","messageId":2}\n\n',
    });
    if (path === "/api/aria/conversations") return json([]);
    if (path === "/api/twilio/settings") return json({ schedulingCalendarId: "", schedulingCalendarBlockBusy: false, schedulingCalendarPushEvents: false });
    if (path === "/api/calendar/status") return json({ connected: false, calendars: [] });
    if (path === "/api/ptt/session") return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    if (path === "/api/invoices" || path === "/api/invoices/billing-parties" || path === "/api/tickets" ||
        path === "/api/crm/contacts" || path === "/api/clients" || path === "/api/helpdesk/departments" ||
        path === "/api/crm/interactions") return json([]);
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/aria-staff.fixture.html?target=%2Ftickets");
  const launcher = page.getByRole("button", { name: "Chat with ARIA" });
  await expect(launcher).toBeVisible();

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const { path, action } of routes) {
      await navigate(page, path);
      await assertActionReachable(page, action(page), launcher);
    }
  }

  await navigate(page, "/tickets");
  await launcher.click();
  const chat = page.getByRole("button", { name: "Minimize ARIA chat" }).locator("..").locator("..").locator("..");
  await expect(page.getByPlaceholder("Ask Aria anything...")).toBeVisible();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const { path, action } of routes) {
      await navigate(page, path);
      await assertActionReachable(page, action(page), chat);
    }
  }

  await page.getByRole("button", { name: "Minimize ARIA chat" }).click();
  const minimized = page.getByRole("button", { name: "Expand ARIA chat" }).locator("..").locator("..").locator("..");
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const { path, action } of routes) {
      await navigate(page, path);
      await assertActionReachable(page, action(page), minimized);
    }
  }

  await page.getByRole("button", { name: "Expand ARIA chat" }).click();
  await page.getByPlaceholder("Ask Aria anything...").fill("Keep this draft while navigating");
  await navigate(page, "/crm/contacts");
  await expect(page.getByPlaceholder("Ask Aria anything...")).toHaveValue("Keep this draft while navigating");
  await page.getByPlaceholder("Ask Aria anything...").press("Enter");
  await expect(page.getByText("Ready to help")).toBeVisible();
  await navigate(page, "/tickets");
  await expect(page.getByText("Ready to help")).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => chat.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
  await assertActionReachable(page, routes[0].action(page), chat);
  await page.getByRole("button", { name: "Minimize ARIA chat" }).click();
  await expect.poll(() => minimized.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
  await page.getByRole("button", { name: "Close ARIA chat" }).click();
  await expect.poll(() => launcher.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
});

// Run this against the real Clerk-gated app with an approved staff session:
// ARIA_STAFF_STORAGE_STATE=/path/to/staff-storage-state.json pnpm exec playwright test aria-staff-responsive
// Never check in the storage-state file (it contains session credentials).
test.describe("real signed-in staff route smoke", () => {
  test.skip(!process.env.ARIA_STAFF_STORAGE_STATE, "Provide ARIA_STAFF_STORAGE_STATE for the real authenticated run");
  test.use({ storageState: process.env.ARIA_STAFF_STORAGE_STATE });

  test("staff access, responsive actions and ARIA state work through the real layout", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/tickets");
    const launcher = page.getByRole("button", { name: "Chat with ARIA" });
    await expect(launcher).toBeVisible();
    for (const { path, action } of routes) {
      await page.goto(path);
      await assertActionReachable(page, action(page), launcher);
    }
    await page.goto("/tickets");
    await launcher.click();
    const input = page.getByPlaceholder("Ask Aria anything...");
    await input.fill("Draft survives navigation");
    await page.getByRole("button", { name: "Minimize ARIA chat" }).click();
    const minimized = page.getByRole("button", { name: "Expand ARIA chat" }).locator("..").locator("..").locator("..");
    // Client-side navigation preserves the mounted widget; a full reload does not.
    await navigate(page, "/crm/contacts");
    await assertActionReachable(page, routes[1].action(page), minimized);
    await page.getByRole("button", { name: "Expand ARIA chat" }).click();
    await expect(input).toHaveValue("Draft survives navigation");
    const chat = page.getByRole("button", { name: "Minimize ARIA chat" }).locator("..").locator("..").locator("..");
    for (const { path, action } of routes) {
      await navigate(page, path);
      await assertActionReachable(page, action(page), chat);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => chat.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
    await assertActionReachable(page, routes[4].action(page), chat);
  });
});