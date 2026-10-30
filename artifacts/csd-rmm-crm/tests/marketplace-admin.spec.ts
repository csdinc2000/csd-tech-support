import { expect, test, type Route } from "@playwright/test";

const tinyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]);

function listing(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    title: "Custom RTX 4070 Gaming Desktop",
    description: "Built 6 months ago, plays everything at 1440p ultra.",
    category: "gaming_pc",
    condition: "like_new",
    priceCents: 135000,
    specs: { cpu: "Ryzen 7 7800X3D", gpu: "RTX 4070" },
    location: "Lauderhill, FL",
    sellerName: "Marcus Thompson",
    sellerEmail: "marcus@example.com",
    sellerPhone: "954-555-0192",
    showPhone: false,
    status: "pending",
    source: "portal",
    imageIds: [7],
    coverImageId: 7,
    publishedAt: null,
    soldAt: null,
    createdAt: "2026-09-16T12:00:00.000Z",
    updatedAt: "2026-09-16T12:00:00.000Z",
    viewCount: 0,
    reviewNote: null,
    reviewedAt: null,
    createdByUserId: null,
    inquiryCount: 0,
    ...overrides,
  };
}

test("staff can review a pending listing and approve it", async ({ page }) => {
  let current = listing();
  const statusCalls: unknown[] = [];

  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path.startsWith("/api/portal/marketplace/images/")) {
      await route.fulfill({ status: 200, contentType: "image/jpeg", body: tinyJpeg });
      return;
    }
    if (path === "/api/marketplace/listings" && request.method() === "GET") {
      const counts = { pending: 0, active: 0, sold: 0, rejected: 0, removed: 0 };
      counts[current.status as keyof typeof counts] = 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ listings: [current], counts }) });
      return;
    }
    if (path === "/api/marketplace/listings/42" && request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ listing: current, inquiries: [] }) });
      return;
    }
    if (path === "/api/marketplace/listings/42/status" && request.method() === "POST") {
      const body = request.postDataJSON();
      statusCalls.push(body);
      current = listing({ status: body.status, publishedAt: "2026-09-16T13:00:00.000Z" });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ listing: current, inquiries: [], emailed: true }) });
      return;
    }
    await route.abort();
  });

  await page.goto("/tests/marketplace-admin.fixture.html");

  await expect(page.getByTestId("page-marketplace-admin")).toBeVisible();
  await expect(page.getByTestId("stat-pending")).toHaveText("1");
  await page.getByTestId("row-listing-42").click();

  await expect(page.getByTestId("drawer-listing")).toBeVisible();
  await expect(page.getByTestId("drawer-listing").getByText("marcus@example.com")).toBeVisible();
  await page.getByTestId("button-approve").click();

  await expect.poll(() => statusCalls.length).toBe(1);
  expect(statusCalls[0]).toEqual({ status: "active" });
  await expect(page.getByText("Listing approved and live", { exact: true })).toBeVisible();
  await expect(page.getByTestId("stat-active")).toHaveText("1");
  await expect(page.getByTestId("stat-pending")).toHaveText("0");
});

test("rejecting a listing requires a note for the seller", async ({ page }) => {
  const current = listing();
  const statusCalls: Array<{ status: string; note?: string }> = [];
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/portal/marketplace/images/")) return route.fulfill({ status: 200, contentType: "image/jpeg", body: tinyJpeg });
    if (path === "/api/marketplace/listings" && request.method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ listings: [current], counts: { pending: 1, active: 0, sold: 0, rejected: 0, removed: 0 } }) });
    }
    if (path === "/api/marketplace/listings/42" && request.method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ listing: current, inquiries: [] }) });
    }
    if (path === "/api/marketplace/listings/42/status") {
      statusCalls.push(request.postDataJSON());
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ listing: listing({ status: "rejected", reviewNote: "Add a real photo" }), inquiries: [], emailed: true }) });
    }
    return route.abort();
  });

  await page.goto("/tests/marketplace-admin.fixture.html");
  await page.getByTestId("row-listing-42").click();
  await page.getByTestId("button-reject").click();
  await expect(page.getByTestId("button-confirm-reject")).toBeDisabled();
  await page.getByTestId("input-reject-note").fill("Add a real photo");
  await page.getByTestId("button-confirm-reject").click();
  await expect.poll(() => statusCalls.length).toBe(1);
  expect(statusCalls[0]).toEqual({ status: "rejected", note: "Add a real photo" });
  await expect(page.getByText("Note sent to seller:")).toBeVisible();
});
