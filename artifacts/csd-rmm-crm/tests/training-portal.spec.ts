import { expect, test } from "@playwright/test";

test("walks modules, tracks lesson progress and keeps it across reloads", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/training-portal.fixture.html");

  const progress = page.getByTestId("training-progress");
  await expect(progress).toContainText("0 / ");

  const lesson = page.getByTestId("training-lesson-orientation-board");
  await expect(lesson).toContainText("The Technician Board");
  await expect(lesson.getByRole("link", { name: /Open Jobs & Work Orders/ })).toHaveAttribute("href", "/crm/jobs");
  await lesson.getByLabel("Mark lesson complete").click();
  await expect(progress).toContainText("1 / ");
  await expect(page.getByTestId("training-module-orientation")).toContainText("1/3 lessons");

  await page.getByTestId("training-next-module").click();
  await expect(page.getByTestId("training-module-detail")).toContainText("The repair workflow");
  await page.screenshot({ path: "test-results/training-portal.png", fullPage: true });

  await page.reload();
  await expect(progress).toContainText("1 / ");

  await page.getByTestId("training-reset").click();
  await expect(progress).toContainText("0 / ");
});

test("shows locked links for features the technician doesn't have yet", async ({ page }) => {
  await page.goto("/tests/training-portal.fixture.html?features=crm");
  await page.getByTestId("training-module-remote-support").click();
  const lesson = page.getByTestId("training-lesson-remote-session");
  await expect(lesson).toContainText("Remote Access · needs Operations access");
  await expect(lesson.getByRole("link", { name: /Remote Access/ })).toHaveCount(0);
});
