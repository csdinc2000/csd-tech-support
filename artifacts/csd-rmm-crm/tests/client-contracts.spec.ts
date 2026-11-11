import { expect, test } from "@playwright/test";

const token = "a".repeat(43);
const nextToken = "b".repeat(43);
const contract = {
  id: 7, title: "Test agreement", status: "sent", effectiveDate: "2026-09-27",
  annualValueCents: 0, terms: { includedSupport: "Included", deviceLimits: "Two", onsiteWork: "Separate", backups: "Monitored" },
};

test("staff parses a created link response and never copies an undefined URL", async ({ page }) => {
  const copied: string[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: (text: string) => {
        (window as any).__copied.push(text);
        return Promise.resolve();
      } },
    });
    (window as any).__copied = [];
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/clients") return route.fulfill({ json: [{ id: 42, name: "Isolated test client" }] });
    if (path === "/api/clients/42/contracts") return route.fulfill({ json: [contract] });
    if (path === "/api/service-contracts" && route.request().method() === "POST") {
      return route.fulfill({ status: 201, json: { id: 8, status: "sent", signingPath: `/sign/contract/${token}` } });
    }
    if (path === "/api/service-contracts/7/signing-link") {
      return route.fulfill({ json: { id: 7, status: "sent", signingPath: `/sign/contract/${nextToken}` } });
    }
    return route.abort();
  });
  await page.goto("/tests/client-contracts.fixture.html");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: "Create draft" }).click();
  const field = page.getByRole("textbox", { name: "Current signing link" });
  await expect(field).toHaveValue(`${new URL(page.url()).origin}/sign/contract/${token}`);
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toEqual([`${new URL(page.url()).origin}/sign/contract/${token}`]);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "New link" }).click();
  await expect(field).toHaveValue(`${new URL(page.url()).origin}/sign/contract/${nextToken}`);
  copied.push(...await page.evaluate(() => (window as any).__copied));
  expect(copied).toEqual([`${new URL(page.url()).origin}/sign/contract/${token}`, `${new URL(page.url()).origin}/sign/contract/${nextToken}`]);
  expect(copied.every((url) => !url.endsWith("undefined"))).toBe(true);
});

test("staff does not display or copy a malformed replacement response", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: (text: string) => { (window as any).__copied.push(text); return Promise.resolve(); },
    } });
  });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/clients") return route.fulfill({ json: [{ id: 42, name: "Isolated test client" }] });
    if (path === "/api/clients/42/contracts") return route.fulfill({ json: [contract] });
    if (path === "/api/service-contracts/7/signing-link") return route.fulfill({ json: { id: 7, status: "sent" } });
    return route.abort();
  });
  await page.goto("/tests/client-contracts.fixture.html");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "New link" }).click();
  await expect(page.getByText("Could not read the new signing link")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Current signing link" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__copied)).toEqual([]);
});

test("staff does not claim a sent agreement has a usable link when creation omits its path", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: (text: string) => { (window as any).__copied.push(text); return Promise.resolve(); },
    } });
  });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/clients") return route.fulfill({ json: [{ id: 42, name: "Isolated test client" }] });
    if (path === "/api/clients/42/contracts") return route.fulfill({ json: [] });
    if (path === "/api/service-contracts" && route.request().method() === "POST") {
      return route.fulfill({ status: 201, json: { id: 8, status: "sent" } });
    }
    return route.abort();
  });
  await page.goto("/tests/client-contracts.fixture.html");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByText("Agreement created, but its signing link is unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Current signing link" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__copied)).toEqual([]);
});