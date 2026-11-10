import { expect, test, type Page, type Route } from "@playwright/test";

const base = {
  maxDiscountCents: null, contactId: null, message: null, redeemedAt: null, redemptionNote: null,
  lastEmailedAt: "2026-11-01T15:00:00Z", emailCount: 1, createdAt: "2026-11-01T15:00:00Z",
};
const active = { ...base, id: 1, code: "CSD-7K3QDM", percentOff: 15, expiresOn: "2026-12-31", recipientName: "Dana Lee", recipientEmail: "dana@example.com", status: "active", state: "active" };
const redeemed = { ...base, id: 2, code: "CSD-AB23CD", percentOff: 10, expiresOn: null, recipientName: "Sam Okafor", recipientEmail: "sam@example.com", status: "redeemed", state: "redeemed", redeemedAt: "2026-11-05T15:00:00Z", redemptionNote: "INV-1042" };
const listData = { today: "2026-11-10", summary: { total: 2, active: 1, redeemed: 1, expired: 0, void: 0 }, vouchers: [active, redeemed] };

async function mockApi(page: Page) {
  const calls: { method: string; path: string; search: string; body: any }[] = [];
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON?.() ?? null;
    calls.push({ method: request.method(), path: url.pathname, search: url.search, body });
    const json = (payload: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
    if (url.pathname === "/api/crm/vouchers" && request.method() === "GET") return json(listData);
    if (url.pathname === "/api/crm/vouchers" && request.method() === "POST") {
      return json({ voucher: { ...active, id: 3, code: "CSD-NEW234", percentOff: body.percentOff, recipientName: body.recipientName, recipientEmail: body.recipientEmail }, emailed: true }, 201);
    }
    if (url.pathname === "/api/crm/vouchers/1" && request.method() === "PATCH") return json({ voucher: { ...active, ...body }, emailed: Boolean(body.resend) });
    if (url.pathname === "/api/crm/vouchers/lookup/CSD-7K3QDM") return json({ voucher: active, discountCents: 1_500 });
    if (url.pathname === "/api/crm/vouchers/redeem") return json({ voucher: { ...active, status: "redeemed", state: "redeemed", redeemedAt: "2026-11-10T15:00:00Z", redemptionNote: body.note ?? null } });
    return json({ message: "Not found" }, 404);
  });
  return calls;
}

test("staff pick any percentage, preview it, and email the voucher", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/tests/vouchers.fixture.html");
  await expect(page.getByTestId("voucher-row-1")).toContainText("15%");
  await expect(page.getByTestId("voucher-row-2")).toBeHidden(); // filtered to Active

  await page.getByLabel("Customer name").fill("Jordan Reyes");
  await page.getByLabel("Customer email").fill("jordan@example.com");
  await page.getByTestId("voucher-preset-25").click();
  await expect(page.getByTestId("voucher-preview")).toContainText("25% OFF");
  await page.getByTestId("voucher-percent").fill("37");
  await page.getByLabel("Max discount ($)").fill("40");
  await expect(page.getByTestId("voucher-preview")).toContainText("37% off your next service (up to $40.00)");
  await page.getByTestId("voucher-send").click();

  await expect(page.getByTestId("voucher-create-result")).toContainText("CSD-NEW234");
  const create = calls.find((c) => c.method === "POST" && c.path === "/api/crm/vouchers");
  expect(create?.body).toMatchObject({ recipientName: "Jordan Reyes", recipientEmail: "jordan@example.com", percentOff: 37, maxDiscountCents: 4_000 });
  await page.screenshot({ path: "test-results/vouchers-staff.png", fullPage: true });
});

test("staff adjust an active voucher's percentage and re-send it", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/tests/vouchers.fixture.html");
  await page.getByTestId("voucher-adjust-1").click();
  await page.getByTestId("voucher-1-preset-20").click();
  await expect(page.getByTestId("voucher-adjust-form-1")).toContainText("20% off your next service");
  await page.getByRole("button", { name: "Save & email update" }).click();
  await expect.poll(() => calls.find((c) => c.method === "PATCH")?.body).toMatchObject({ percentOff: 20, resend: true, expiresOn: "2026-12-31" });
});

test("counter lookup shows the discount for the bill and redeems the code", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/tests/vouchers.fixture.html");
  await page.getByTestId("voucher-check-code").fill("CSD-7K3QDM");
  await page.getByLabel("Bill subtotal in dollars").fill("100");
  await page.getByRole("button", { name: "Check code" }).click();
  const result = page.getByTestId("voucher-check-result");
  await expect(result).toContainText("Take $15.00 off $100.00");
  expect(calls.find((c) => c.path.includes("/lookup/"))?.search).toBe("?subtotalCents=10000");
  await result.getByLabel("Redemption note").fill("INV-2001");
  await page.getByTestId("voucher-check-redeem").click();
  await expect(result).toContainText("redeemed");
  expect(calls.find((c) => c.path === "/api/crm/vouchers/redeem")?.body).toEqual({ code: "CSD-7K3QDM", note: "INV-2001" });
});
