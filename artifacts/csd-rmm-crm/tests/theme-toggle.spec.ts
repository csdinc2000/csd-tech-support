import { expect, test, type Page } from "@playwright/test";

const bg = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => getComputedStyle(el).backgroundColor);
const fg = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => getComputedStyle(el).color);
const htmlIsDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains("dark"));

test("light by default; choosing Dark flips the app, persists, and leaves the marketplace frame alone", async ({ page }) => {
  await page.goto("/tests/theme-toggle.fixture.html");
  await expect(page.getByTestId("button-theme-toggle")).toBeVisible();
  expect(await htmlIsDark(page)).toBe(false);
  expect(await bg(page, "card")).toBe("rgb(255, 255, 255)");
  const lightBadgeBg = await bg(page, "badge");

  await page.getByTestId("button-theme-toggle").click();
  await page.getByTestId("menu-theme-dark").click();
  await expect.poll(() => htmlIsDark(page)).toBe(true);
  await expect(page.getByTestId("button-theme-toggle")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => localStorage.getItem("csd-theme"))).toBe("dark");

  // Compat layer: literal light colours are remapped…
  expect(await bg(page, "card")).not.toBe("rgb(255, 255, 255)");
  expect(await bg(page, "page")).not.toBe("rgb(249, 250, 251)");
  expect(await bg(page, "badge")).not.toBe(lightBadgeBg);
  expect(await fg(page, "muted")).not.toBe("rgb(107, 114, 128)");
  // …but not inside the marketplace's own palette.
  expect(await bg(page, "cyber-white")).toBe("rgb(255, 255, 255)");

  // Survives a reload without a flash back to light.
  await page.reload();
  await expect.poll(() => htmlIsDark(page)).toBe(true);
  await expect(page.getByTestId("button-theme-toggle")).toHaveAttribute("data-theme", "dark");
});

test("System follows the OS preference", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/tests/theme-toggle.fixture.html");
  await page.getByTestId("button-theme-toggle").click();
  await page.getByTestId("menu-theme-system").click();
  await expect.poll(() => htmlIsDark(page)).toBe(true);

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => htmlIsDark(page)).toBe(false);
  await expect(page.getByTestId("button-theme-toggle")).toHaveAttribute("data-theme", "system");
});
