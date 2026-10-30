import { expect, test, type Route } from "@playwright/test";

// A label photo for the scanner: a "sticker" with readable-looking text. The
// scan endpoint is mocked, so the content only needs to be a valid image.
async function stickerPng(page: import("@playwright/test").Page): Promise<Buffer> {
  const b64 = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 1200; c.height = 800;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#e5e7eb"; ctx.fillRect(0, 0, 1200, 800);
    ctx.fillStyle = "#111"; ctx.font = "bold 48px sans-serif";
    ctx.fillText("Lenovo Legion 5 Pro 16ACH6H", 60, 120);
    ctx.font = "36px monospace";
    ctx.fillText("Ryzen 7 5800H  RTX 3070  16GB  1TB SSD", 60, 220);
    ctx.fillText("S/N PF2X9K7L   Type 82JQ", 60, 300);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  return Buffer.from(b64, "base64");
}

const scanResult = {
  detected: true,
  confidence: "high",
  brand: "Lenovo",
  model: "Legion 5 Pro 16ACH6H",
  deviceType: "laptop",
  category: "laptop",
  title: "Lenovo Legion 5 Pro 16ACH6H - RTX 3070 / 16GB",
  specs: { cpu: "AMD Ryzen 7 5800H", gpu: "NVIDIA GeForce RTX 3070", ram: "16GB DDR4", storage: "1TB NVMe SSD", os: "Windows 11 Home" },
  descriptionHook: "Factory specs: Lenovo Legion 5 Pro 16ACH6H featuring AMD Ryzen 7 5800H, NVIDIA GeForce RTX 3070, 16GB DDR4 RAM, 1TB NVMe SSD. Excellent rig for 1440p gaming.",
  identifiers: { serialNumber: "PF2X9K7L", partNumber: "82JQ" },
  rawText: "Lenovo Legion 5 Pro 16ACH6H",
  summary: "2021 16-inch gaming laptop: Ryzen 7 5800H, RTX 3070, 165 Hz QHD screen",
  releaseYear: "2021",
  pricing: null,
  candidates: [],
  grounded: false,
};

test("CyberScan decodes a label photo and syncs the form", async ({ page }) => {
  const scans: Array<{ bytes: number; isImage: boolean }> = [];
  let releaseScan: () => void = () => {};
  const scanGate = new Promise<void>((r) => { releaseScan = r; });

  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/portal/marketplace/scan/status") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true }) });
    if (path === "/api/portal/marketplace/scan" && request.method() === "POST") {
      const body = request.postDataJSON() as { dataBase64: string };
      const buf = Buffer.from(body.dataBase64, "base64");
      const isWebp = buf.subarray(0, 4).toString("ascii") === "RIFF";
      const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
      scans.push({ bytes: buf.length, isImage: isWebp || isJpeg });
      await scanGate; // hold the response so the scanning animation is observable
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(scanResult) });
    }
    return route.abort();
  });

  await page.goto("/tests/marketplace-sell.fixture.html");
  await expect(page.getByTestId("panel-cyber-scan")).toBeVisible();
  await expect(page.getByTestId("button-scan-camera")).toContainText("Scan Model Tag / Serial");
  // The camera input opens the rear camera directly on phones.
  await expect(page.getByTestId("input-scan-camera")).toHaveAttribute("capture", "environment");

  await page.getByTestId("input-scan-upload").setInputFiles({ name: "sticker.png", mimeType: "image/png", buffer: await stickerPng(page) });

  // Laser sweep, viewfinder overlay, live badge and ticking readout while
  // the model reads the label.
  await expect(page.getByTestId("scan-line")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("panel-cyber-scan")).toHaveAttribute("data-phase", "scanning");
  await expect(page.getByTestId("scan-overlay")).toBeAttached();
  await expect(page.getByTestId("badge-scan-live")).toBeVisible();
  await expect(page.getByTestId("scan-hex-feed")).toBeAttached();
  const readout = page.getByTestId("text-scan-percent");
  await expect(readout).toHaveText(/^\d{2}%$/);
  await expect.poll(async () => Number((await readout.textContent())!.replace("%", "")), { timeout: 5_000 }).toBeGreaterThan(20);
  releaseScan();

  // Success: readout snaps to 100 and the scanning dressing is gone.
  await expect(page.getByTestId("scan-overlay")).toHaveCount(0);
  await expect(page.getByTestId("badge-scan-live")).toHaveCount(0);

  await expect(page.getByTestId("text-scan-result")).toBeVisible();
  await expect(page.getByTestId("text-scan-result")).toContainText("Decoded & synced");
  expect(scans).toHaveLength(1);
  expect(scans[0].isImage).toBe(true);
  expect(scans[0].bytes).toBeLessThan(1_500_000);

  await expect(page.getByTestId("text-scan-result")).toContainText("fields auto-filled");

  // Step 1 fields pre-populated, with the "Decoded & Synced" pulse.
  await expect(page.getByTestId("input-title")).toHaveValue(scanResult.title);
  await expect(page.getByTestId("select-category")).toContainText("Laptop");
  expect(await page.locator('[data-synced="true"]').count()).toBe(2);

  // The scanned frame can be reused as a listing photo.
  await page.getByTestId("button-scan-use-photo").click();

  // Step 2: the spec matrix and description arrived from the scan too, and
  // pulse again as the step mounts.
  await page.getByTestId("button-next").click();
  await expect(page.getByTestId("form-marketplace-listing")).toHaveAttribute("data-step", "details");
  await expect(page.getByTestId("input-spec-cpu")).toHaveValue("AMD Ryzen 7 5800H");
  await expect(page.getByTestId("input-spec-gpu")).toHaveValue("NVIDIA GeForce RTX 3070");
  await expect(page.getByTestId("input-spec-ram")).toHaveValue("16GB DDR4");
  await expect(page.getByTestId("input-spec-storage")).toHaveValue("1TB NVMe SSD");
  await expect(page.getByTestId("input-spec-os")).toHaveValue("Windows 11 Home");
  await expect(page.getByTestId("input-description")).toHaveValue(new RegExp("^Factory specs: Lenovo Legion 5 Pro"));
  expect(await page.locator('[data-synced="true"]').count()).toBe(6);
  await expect(page.getByText(/Ready to upload: \d+ KB total/)).toBeVisible();

  // Editing a synced field drops its tag.
  await page.getByTestId("input-spec-ram").fill("32GB DDR4");
  expect(await page.locator('[data-synced="true"]').count()).toBe(5);
});

test("typing a model number decodes it and fills the form", async ({ page }) => {
  const queries: string[] = [];
  let releaseLookup: () => void = () => {};
  const lookupGate = new Promise<void>((r) => { releaseLookup = r; });
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/portal/marketplace/scan/status") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false }) });
    if (path === "/api/portal/marketplace/scan/lookup" && request.method() === "POST") {
      queries.push((request.postDataJSON() as { query: string }).query);
      await lookupGate; // hold so the decode animation is observable
      // Ambiguous model line: top-level specs empty, candidates offered, price range known.
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        ...scanResult,
        title: "Lenovo Legion 5 Pro 16ACH6H",
        specs: { cpu: "", gpu: "", ram: "", storage: "", os: "" },
        identifiers: { partNumber: "82JQ" },
        rawText: "82JQ",
        grounded: true,
        pricing: { low: 700, high: 950, basis: "eBay sold listings" },
        candidates: [
          { label: "Ryzen 7 5800H / RTX 3070 / 16GB / 1TB", specs: { cpu: "AMD Ryzen 7 5800H", gpu: "NVIDIA GeForce RTX 3070", ram: "16GB DDR4", storage: "1TB NVMe SSD", os: "Windows 11 Home" } },
          { label: "Ryzen 5 5600H / RTX 3060 / 16GB / 512GB", specs: { cpu: "AMD Ryzen 5 5600H", gpu: "NVIDIA GeForce RTX 3060", ram: "16GB DDR4", storage: "512GB NVMe SSD", os: "Windows 11 Home" } },
        ],
      }) });
    }
    return route.abort();
  });
  await page.goto("/tests/marketplace-sell.fixture.html");
  // With no vision model configured the photo option is hidden, but the
  // model-number path still works (regex on the server, model when available).
  await expect(page.getByTestId("button-scan-camera")).toHaveCount(0);
  await page.getByTestId("input-scan-query").fill("82JQ");
  await page.getByTestId("input-scan-query").press("Enter");
  // No photo to sweep, so the model number itself "decodes" glyph by glyph.
  const scramble = page.getByTestId("scan-scramble");
  await expect(scramble).toHaveAttribute("aria-label", "82JQ");
  await expect(scramble).toHaveText(/^.{4}.?$/s);
  releaseLookup();
  await expect(page.getByTestId("text-scan-result")).toBeVisible();
  await expect(scramble).toHaveCount(0);
  expect(queries).toEqual(["82JQ"]);
  await expect(page.getByTestId("text-scan-result")).toContainText("Part 82JQ");
  await expect(page.getByTestId("badge-grounded")).toBeVisible();
  await expect(page.getByTestId("text-scan-summary")).toContainText("2021 16-inch gaming laptop");
  await expect(page.getByTestId("text-scan-pricing")).toContainText("$700–$950");
  await expect(page.getByTestId("text-scan-pricing")).toContainText("suggested asking $825");
  await expect(page.getByTestId("input-title")).toHaveValue("Lenovo Legion 5 Pro 16ACH6H");
  await expect(page.getByTestId("select-category")).toContainText("Laptop");
  // No photo was involved, so there's nothing to "add to the listing".
  await expect(page.getByTestId("button-scan-use-photo")).toHaveCount(0);

  // Ambiguous line → pick a configuration; specs and title follow.
  await expect(page.getByTestId("panel-candidates")).toBeVisible();
  await page.getByTestId("button-candidate-1").click();
  await expect(page.getByTestId("input-title")).toHaveValue("Lenovo Legion 5 Pro 16ACH6H - RTX 3060 / 16GB");
  await page.getByTestId("button-next").click();
  await expect(page.getByTestId("input-spec-cpu")).toHaveValue("AMD Ryzen 5 5600H");
  await expect(page.getByTestId("input-spec-gpu")).toHaveValue("NVIDIA GeForce RTX 3060");
  // Suggested asking price (middle of the range, rounded) lands in the price field, tagged as synced.
  await expect(page.getByTestId("input-price")).toHaveValue("825");
  await expect(page.getByText(/going rate used: \$700–\$950/)).toBeVisible();
});

test("a scan that finds nothing leaves the form untouched and explains why", async ({ page }) => {
  await page.route("**/api/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/portal/marketplace/scan/status") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true }) });
    if (path === "/api/portal/marketplace/scan") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...scanResult, detected: false, title: "", specs: { cpu: "", gpu: "", ram: "", storage: "", os: "" }, descriptionHook: "" }) });
    }
    return route.abort();
  });
  await page.goto("/tests/marketplace-sell.fixture.html");
  await page.getByTestId("input-title").fill("My own title");
  await page.getByTestId("input-scan-upload").setInputFiles({ name: "blur.png", mimeType: "image/png", buffer: await stickerPng(page) });
  await expect(page.getByTestId("text-scan-error")).toContainText("Couldn't find a model number");
  await expect(page.getByTestId("input-title")).toHaveValue("My own title");
  expect(await page.locator('[data-synced="true"]').count()).toBe(0);
  await page.getByTestId("button-next").click();
  await expect(page.getByTestId("input-spec-cpu")).toHaveValue("");
});

test("the funnel gates each step and lets you jump back", async ({ page }) => {
  await page.route("**/api/**", (route: Route) => route.abort());
  await page.goto("/tests/marketplace-sell.fixture.html");
  await expect(page.getByTestId("step-identify")).toHaveAttribute("data-state", "active");
  await expect(page.getByTestId("step-details")).toBeDisabled();

  // Can't leave Identify without a title.
  await page.getByTestId("button-next").click();
  await expect(page.getByTestId("text-form-error")).toContainText("title");
  await page.getByTestId("input-title").fill("RTX 3060 build");
  await page.getByTestId("button-next").click();
  await expect(page.getByTestId("step-identify")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("step-details")).toHaveAttribute("data-state", "active");

  // Details requires a price + description (+ photo).
  await page.getByTestId("button-next").click();
  await expect(page.getByTestId("text-form-error")).toContainText("price");

  // Completed steps are clickable to go back; values survive the round trip.
  await page.getByTestId("step-identify").click();
  await expect(page.getByTestId("input-title")).toHaveValue("RTX 3060 build");
  await page.getByTestId("button-next").click();
  await expect(page.getByTestId("form-marketplace-listing")).toHaveAttribute("data-step", "details");
  await page.getByTestId("button-back").click();
  await expect(page.getByTestId("form-marketplace-listing")).toHaveAttribute("data-step", "identify");
});
