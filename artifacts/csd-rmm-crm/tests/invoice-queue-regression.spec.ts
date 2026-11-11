import { expect, test, type Page, type Route } from "@playwright/test";

const party = {
  key: "contact:41", kind: "contact", contactId: 41, clientId: null, name: "Riley Test",
  org: null, email: "riley@example.test", phone: null, invoiceCount: 0, lastInvoiceAt: null,
  openBalanceCents: 0, openJobCount: 0, openRequestCount: 0, openJobs: [],
};
const baseInquiry = {
  id: "request-316", offerName: "Website tune-up", unitAmountCents: 12500, name: "Riley Test",
  email: "riley@example.test", phone: "", message: "Please invoice me.", contactId: 41,
  contactName: "Riley Test", accountId: null, createdAt: "2025-01-01T00:00:00Z",
  invoiceId: null, invoiceNumber: null, invoiceStatus: null,
};
const settings = { businessName: "Test", accentColor: "red", contactEmail: "", contactPhone: "", footer: "", defaultDueDays: 15, defaultTaxRateBps: 0, defaultNotes: "" };

async function mockBilling(page: Page, mode: "save" | "conflict" | "send-failure", correction = false) {
  let saved = false;
  const posts: { url: string; body: any }[] = [];
  const inquiry = correction ? { ...baseInquiry, invoiceId: 88, invoiceNumber: "INV-0088", invoiceStatus: "sent" } : baseInquiry;
  await page.route("**/api/**", async (route: Route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (path === "/api/catalog/inquiries" && req.method() === "GET") {
      return route.fulfill({ json: { inquiries: [saved ? { ...inquiry, invoiceId: 316, invoiceNumber: "INV-0316", invoiceStatus: "draft" } : inquiry] } });
    }
    if (path === "/api/invoices/billing-parties") return route.fulfill({ json: [party] });
    if (path === "/api/invoices/settings") return route.fulfill({ json: settings });
    if (path === "/api/invoices/service-presets" || path === "/api/invoices/templates" || (path === "/api/invoices" && req.method() === "GET")) return route.fulfill({ json: [] });
    if (path === "/api/catalog/items") return route.fulfill({ json: { items: [] } });
    if (path === "/api/invoices" && req.method() === "POST") {
      const body = req.postDataJSON(); posts.push({ url: path, body });
      if (mode === "conflict") return route.fulfill({ status: 409, json: { error: "Request already invoiced", invoiceId: 88 } });
      saved = true;
      return route.fulfill({ status: 201, json: { id: 316, status: "draft" } });
    }
    if (path === "/api/invoices/316/send" && req.method() === "POST") {
      posts.push({ url: path, body: null });
      return route.fulfill({ status: 500, json: { error: "Mock send failure" } });
    }
    return route.abort();
  });
  await page.goto("/tests/invoice-queue.fixture.html");
  await expect(page.getByTestId(`catalog-inquiry-${baseInquiry.id}`)).toBeVisible();
  return posts;
}

test("invoice request draft, correction confirmation, 409 and send-failure reconciliation", async ({ page }) => {
  let posts = await mockBilling(page, "save");
  await page.getByRole("button", { name: "Create invoice from request" }).click();
  await page.getByTestId("button-save-draft").click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].body.originInquiryId).toBe(baseInquiry.id);
  await expect(page.getByText("Already invoiced. Open the invoice to edit a draft or review its status.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open INV-0316" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create invoice from request" })).toHaveCount(0);

  await page.unrouteAll();
  posts = await mockBilling(page, "conflict", true);
  page.once("dialog", d => d.dismiss());
  await page.getByRole("button", { name: "Create correction invoice…" }).click();
  await expect(page.getByRole("heading", { name: "Create an invoice" })).toHaveCount(0);
  page.once("dialog", d => d.accept());
  await page.getByRole("button", { name: "Create correction invoice…" }).click();
  await expect(page.getByText(/Correction: this creates a separate invoice\. The original is not cancelled or refunded\./)).toBeVisible();
  await page.getByTestId("button-save-draft").click();
  await expect(page.getByTestId("text-quick-invoice-error")).toContainText("Request already invoiced");
  await expect(page.getByRole("status").getByRole("link", { name: "Open saved invoice" })).toHaveAttribute("href", "/invoices/88");
  expect(posts).toHaveLength(1);
  expect(posts[0].body.correctionOfInvoiceId).toBe(88);
  await page.getByTestId("button-save-draft").click();
  await expect(page).toHaveURL(/\/invoices\/88$/);
  expect(posts).toHaveLength(1);

  await page.unrouteAll();
  posts = await mockBilling(page, "send-failure");
  await page.getByRole("button", { name: "Create invoice from request" }).click();
  await page.getByTestId("input-line-description-0").fill("Edited line item");
  await page.getByTestId("input-line-price-0").fill("99");
  const before = await page.getByTestId("input-line-description-0").inputValue();
  await page.getByTestId("input-notes").fill("Keep this note");
  const partiesRefresh = page.waitForResponse(r => r.url().includes("/api/invoices/billing-parties"));
  await page.evaluate(() => (window as any).__invoiceTestQueryClient.invalidateQueries({ queryKey: ["/api/invoices/billing-parties"] }));
  await partiesRefresh;
  await expect(page.getByTestId("input-line-description-0")).toHaveValue(before);
  await expect(page.getByTestId("input-notes")).toHaveValue("Keep this note");
  await page.getByTestId("button-create-and-send").click();
  await expect(page.getByRole("link", { name: "Open saved invoice" })).toBeVisible();
  await expect(page.getByTestId("catalog-inquiry-request-316")).toContainText("INV-0316");
  expect(posts.filter(p => p.url === "/api/invoices")).toHaveLength(1);
  await page.getByTestId("button-create-and-send").click();
  await expect(page).toHaveURL(/\/invoices\/316$/);
  expect(posts.filter(p => p.url === "/api/invoices")).toHaveLength(1);
  expect(posts.filter(p => p.url.endsWith("/send"))).toHaveLength(1);
});