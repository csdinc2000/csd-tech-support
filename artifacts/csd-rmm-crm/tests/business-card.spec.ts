import { expect, test } from "@playwright/test";

const card = {
  name: "Tess Tech",
  firstName: "Tess",
  lastName: "Tech",
  title: "Bench Technician",
  headline: "Laptop & gaming PC repair specialist",
  email: "tess@example.com",
  directPhone: "+19545550101",
  photoUrl: null,
  company: { name: "Computer Systems Depot", phone: "(954) 555-0100", email: "support@example.com", website: "https://csd.example.com", accentColor: "red" },
  cardUrl: "https://csd.example.com/card/tok_test_1234567890",
  vcardUrl: "/api/portal/business-card/tok_test_1234567890/vcard",
  bookingUrl: "https://csd.example.com/intake",
};

test("shows the technician's public card with contact links, save button and QR code", async ({ page }) => {
  await page.route("**/api/portal/business-card/tok_test_1234567890", (route) => route.fulfill({ json: card }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tests/business-card.fixture.html");

  // The company logo sits centred above the profile picture.
  const logo = page.getByTestId("card-company-logo").locator("img");
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute("alt", "Computer Systems Depot");
  expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  const logoBox = (await logo.boundingBox())!;
  const photoBox = (await page.getByTestId("business-card").locator(".rounded-full").first().boundingBox())!;
  expect(logoBox.y + logoBox.height).toBeLessThanOrEqual(photoBox.y);
  expect(Math.abs((logoBox.x + logoBox.width / 2) - (photoBox.x + photoBox.width / 2))).toBeLessThan(2);
  await expect(page.getByTestId("card-name")).toHaveText("Tess Tech");
  await expect(page.getByTestId("card-title")).toHaveText("Bench Technician");
  await expect(page.getByTestId("card-headline")).toContainText("repair specialist");
  await expect(page.getByTestId("card-direct-phone")).toHaveAttribute("href", "tel:+19545550101");
  await expect(page.getByTestId("card-company-phone")).toHaveAttribute("href", "tel:+19545550100");
  await expect(page.getByTestId("card-email")).toHaveAttribute("href", "mailto:tess@example.com");
  await expect(page.getByTestId("button-save-contact")).toHaveAttribute("href", card.vcardUrl);
  await expect(page.getByTestId("button-request-service")).toHaveAttribute("href", card.bookingUrl);
  await expect(page.getByTestId("qr-code").locator("svg")).toBeVisible();
  await expect(page).toHaveTitle("Tess Tech | Computer Systems Depot");
  await page.screenshot({ path: "test-results/business-card.png", fullPage: true });
});

test("explains when a card link no longer works", async ({ page }) => {
  await page.route("**/api/portal/business-card/old_token_1234567890", (route) =>
    route.fulfill({ status: 404, json: { error: "This card is no longer available" } }));
  await page.goto("/tests/business-card.fixture.html?token=old_token_1234567890");
  await expect(page.getByTestId("card-unavailable")).toContainText("no longer available");
});
