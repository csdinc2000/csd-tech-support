import { expect, test } from "@playwright/test";

const rows = [
  { full_name: "Ada Lovelace", action: "create", action_label: "Add new contact" },
  { full_name: "Grace Hopper", action: "create", action_label: "Add new contact" },
  { full_name: "Alan Turing", action: "enrich", action_label: "Fill blank fields" },
  { full_name: "Kara Hopper", action: "create", action_label: "Add new contact" },
  { full_name: "Invalid Person", action: "skip", action_label: "Skip", issue: "Email is invalid" },
  { full_name: "Existing Person", action: "unchanged", action_label: "Already up to date" },
].map((row, position) => ({
  email: `contact-${position}@example.invalid`, detail: null, issue: null,
  valid: row.action !== "skip", ...row,
}));

test.beforeEach(async ({ page }) => {
  await page.route("**/api/contact-import/preview", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      source: "generic", sourceLabel: "Generic CSV", headers: ["full_name", "email"],
      mappings: [], unmappedColumns: [], rows, errors: [], warnings: [],
      counts: { create: 3, enrich: 1, unchanged: 1, skip: 1 },
    }),
  }));
  await page.goto("/tests/import-contacts.fixture.html");
  await page.locator('input[type="file"]').setInputFiles({
    name: "contacts.csv", mimeType: "text/csv",
    buffer: Buffer.from("Name,Email\nAda Lovelace,ada@example.invalid"),
  });
  await page.getByRole("button", { name: "Preview contacts", exact: true }).click();
  await expect(page.getByRole("button", { name: "Import 4 selected contacts", exact: true })).toBeVisible();
});

test("name search and select-visible import only chosen rows, with selections retained when search changes", async ({ page }) => {
  let imported: { selectedRows: number[] } | undefined;
  await page.route("**/api/contact-import/import", async (route) => {
    imported = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ sourceLabel: "Generic CSV", created: 2, enriched: 0, unchanged: 0, skipped: 0, errors: [] }),
    });
  });
  await page.getByRole("button", { name: "Clear all selections" }).click();
  await expect(page.getByRole("button", { name: "Select contacts to import", exact: true })).toBeDisabled();
  await page.getByRole("searchbox", { name: "Search contacts by name" }).fill("hOpPeR");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.getByRole("checkbox", { name: "Select visible (2)", exact: true }).check();
  await page.getByRole("searchbox").fill("");
  await expect(page.getByTestId("checkbox-import-contact-0")).not.toBeChecked();
  await expect(page.getByTestId("checkbox-import-contact-1")).toBeChecked();
  await expect(page.getByTestId("checkbox-import-contact-3")).toBeChecked();
  await page.getByRole("button", { name: "Import 2 selected contacts", exact: true }).click();
  await expect(page.getByText("Import complete", { exact: true })).toBeVisible();
  expect(imported?.selectedRows).toEqual([1, 3]);
});

test("action filters and empty searches preserve selection; skipped and unchanged rows stay disabled", async ({ page }) => {
  const filter = page.getByRole("combobox", { name: "Filter contacts by import action" });
  await filter.selectOption("skip");
  await expect(page.getByTestId("checkbox-import-contact-4")).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Select visible (0)", exact: true })).toBeDisabled();
  await filter.selectOption("unchanged");
  await expect(page.getByTestId("checkbox-import-contact-5")).toBeDisabled();
  await filter.selectOption("enrich");
  await page.getByRole("checkbox", { name: "Select visible (1)", exact: true }).uncheck();
  await expect(page.getByRole("button", { name: "Import 3 selected contacts", exact: true })).toBeEnabled();
  await page.getByRole("searchbox").fill("No matching name");
  await expect(page.getByText(/No contacts match/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Import 3 selected contacts", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Choose another file" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "replacement.csv", mimeType: "text/csv", buffer: Buffer.from("Name,Email\nReplacement,replacement@example.invalid"),
  });
  await page.getByRole("button", { name: "Preview contacts", exact: true }).click();
  await expect(page.getByRole("searchbox")).toHaveValue("");
  await expect(page.getByRole("combobox")).toHaveValue("all");
  await expect(page.getByRole("button", { name: "Import 4 selected contacts", exact: true })).toBeEnabled();
});
