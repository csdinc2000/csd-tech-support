import { expect, test, type Route } from "@playwright/test";

// Camera photos come in at 12 MP+ and several MB. The sell form must shrink
// them on-device before upload so listing from a phone is fast and the
// server never sees a multi-megabyte body.
test("a camera photo is downscaled and compressed before it is uploaded", async ({ page }) => {
  const submissions: Array<{ images: Array<{ dataBase64: string }> }> = [];
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/portal/marketplace/listings" && request.method() === "POST") {
      submissions.push(request.postDataJSON());
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: 7, managePath: "/portal/marketplace/manage/abc", emailed: true }) });
    }
    return route.abort();
  });

  await page.goto("/tests/marketplace-sell.fixture.html");
  await expect(page.getByTestId("form-marketplace-listing")).toBeVisible();

  // Build a 4032x3024 (12 MP, typical phone camera) PNG full of noise in the
  // browser so it's large, incompressible and not something a fixture file
  // would have to carry.
  const photo = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 4032;
    canvas.height = 3024;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = Math.random() * 255;
      img.data[i + 1] = Math.random() * 255;
      img.data[i + 2] = Math.random() * 255;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png"));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { base64: btoa(bin), bytes: buf.length };
  });
  expect(photo.bytes).toBeGreaterThan(5 * 1024 * 1024);

  // Step 1 — identify (typed by hand here; CyberScan has its own spec).
  await expect(page.getByTestId("form-marketplace-listing")).toHaveAttribute("data-step", "identify");
  await page.getByTestId("input-title").fill("Gaming desktop");
  await page.getByTestId("button-next").click();

  // Step 2 — details + photos. The camera input opens the rear camera on phones.
  await expect(page.getByTestId("form-marketplace-listing")).toHaveAttribute("data-step", "details");
  const cameraInput = page.getByTestId("input-photo-camera");
  await expect(cameraInput).toHaveAttribute("capture", "environment");
  await cameraInput.setInputFiles({ name: "IMG_0001.png", mimeType: "image/png", buffer: Buffer.from(photo.base64, "base64") });
  await expect(page.getByText(/Ready to upload: \d+ KB total/)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("input-price").fill("500");
  await page.getByTestId("input-description").fill("Runs great, selling because I upgraded.");
  await page.getByTestId("button-next").click();

  // Step 3 — contact + launch.
  await expect(page.getByTestId("form-marketplace-listing")).toHaveAttribute("data-step", "contact");
  await expect(page.getByTestId("launch-summary")).toContainText("Gaming desktop");
  await page.getByTestId("input-seller-name").fill("Test Seller");
  await page.getByTestId("input-seller-email").fill("seller@example.com");
  await page.getByTestId("button-submit-listing").click();
  await expect(page.getByTestId("text-listing-submitted")).toBeVisible();

  expect(submissions).toHaveLength(1);
  expect(submissions[0].images).toHaveLength(1);
  const uploaded = Buffer.from(submissions[0].images[0].dataBase64, "base64");
  expect(uploaded.length).toBeLessThanOrEqual(160 * 1024);
  // Chromium encodes WebP; Safari would fall back to JPEG. Either is accepted by the server.
  const isWebp = uploaded.subarray(0, 4).toString("ascii") === "RIFF" && uploaded.subarray(8, 12).toString("ascii") === "WEBP";
  const isJpeg = uploaded[0] === 0xff && uploaded[1] === 0xd8;
  expect(isWebp || isJpeg).toBe(true);

  // Noise is the worst case for JPEG, so the compressor is allowed to step the
  // size below 1024px to hit the budget — but never below 640px, and it must
  // keep the 4:3 aspect ratio.
  const dims = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:application/octet-stream;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    return { w: bmp.width, h: bmp.height };
  }, submissions[0].images[0].dataBase64);
  expect(dims.w).toBeLessThanOrEqual(1024);
  expect(dims.w).toBeGreaterThanOrEqual(640);
  expect(Math.abs(dims.w / dims.h - 4 / 3)).toBeLessThan(0.01);
});

// A realistic photo (smooth gradients, a few edges) should keep the full
// 1024px and land comfortably under budget without hitting the fallback.
test("an ordinary photo keeps 1024px and lands under the size budget", async ({ page }) => {
  const submissions: Array<{ images: Array<{ dataBase64: string }> }> = [];
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    if (new URL(request.url()).pathname === "/api/portal/marketplace/listings" && request.method() === "POST") {
      submissions.push(request.postDataJSON());
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: 8, managePath: "/portal/marketplace/manage/def", emailed: true }) });
    }
    return route.abort();
  });
  await page.goto("/tests/marketplace-sell.fixture.html");
  const photo = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 3000;
    canvas.height = 4000; // portrait, like a phone held upright
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, 3000, 4000);
    g.addColorStop(0, "#f3f4f6"); g.addColorStop(1, "#1f2937");
    ctx.fillStyle = g; ctx.fillRect(0, 0, 3000, 4000);
    ctx.fillStyle = "#111827"; ctx.fillRect(600, 900, 1800, 2000); // a "tower case"
    ctx.fillStyle = "#dc2626"; ctx.fillRect(700, 1000, 1600, 120);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.95));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  await page.getByTestId("input-title").fill("Tower PC");
  await page.getByTestId("button-next").click();
  await page.getByTestId("input-photo-gallery").setInputFiles({ name: "tower.jpg", mimeType: "image/jpeg", buffer: Buffer.from(photo, "base64") });
  await expect(page.getByText(/Ready to upload: \d+ KB total/)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("input-price").fill("300");
  await page.getByTestId("input-description").fill("Clean tower, works perfectly.");
  await page.getByTestId("button-next").click();
  await page.getByTestId("input-seller-name").fill("Test Seller");
  await page.getByTestId("input-seller-email").fill("seller@example.com");
  await page.getByTestId("button-submit-listing").click();
  await expect(page.getByTestId("text-listing-submitted")).toBeVisible();

  const b64 = submissions[0].images[0].dataBase64;
  expect(Buffer.from(b64, "base64").length).toBeLessThanOrEqual(160 * 1024);
  const dims = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:application/octet-stream;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    return { w: bmp.width, h: bmp.height };
  }, b64);
  expect(dims).toEqual({ w: 768, h: 1024 });
});

// Sellers without a spec label to scan can run one PowerShell line on the PC
// and paste its output; the spec matrix fills in and tags those fields as
// synced, just like a CyberScan hit.
test("pasting the Windows spec one-liner's output fills the spec matrix", async ({ page }) => {
  await page.route("**/api/**", (route: Route) => route.abort());
  await page.goto("/tests/marketplace-sell.fixture.html");
  await page.getByTestId("input-title").fill("Gaming desktop");
  await page.getByTestId("button-next").click();
  await expect(page.getByTestId("form-marketplace-listing")).toHaveAttribute("data-step", "details");

  await page.getByTestId("button-toggle-windows-specs").click();
  await expect(page.getByTestId("text-windows-specs-command")).toContainText("Get-CimInstance Win32_Processor");

  const output = JSON.stringify({
    CPU: "AMD Ryzen 7 7800X3D 8-Core Processor",
    GPU: ["NVIDIA GeForce RTX 4070", "Microsoft Basic Display Adapter"],
    RAMBytes: 34359738368, MemType: 34, MemSpeed: 5600,
    Disks: [{ Model: "Samsung SSD 990 PRO 1TB", Size: 1000204886016, MediaType: "SSD", BusType: "NVMe" }],
    OS: "Microsoft Windows 11 Pro",
  });
  await page.getByTestId("input-windows-specs").fill(`PS C:\\Users\\seller> ${output}`);

  await expect(page.getByTestId("input-spec-cpu")).toHaveValue("AMD Ryzen 7 7800X3D");
  await expect(page.getByTestId("input-spec-gpu")).toHaveValue("NVIDIA GeForce RTX 4070");
  await expect(page.getByTestId("input-spec-ram")).toHaveValue("32GB DDR5-5600");
  await expect(page.getByTestId("input-spec-storage")).toHaveValue("1TB NVMe SSD");
  await expect(page.getByTestId("input-spec-os")).toHaveValue("Windows 11 Pro");
  await expect(page.getByTestId("text-windows-specs-result")).toContainText("Filled processor, graphics, memory, storage, OS");
  await expect(page.getByTestId("spec-matrix-form").locator("[data-synced=true]")).toHaveCount(5);

  // Editing a filled field drops its Synced tag; the rest keep theirs.
  await page.getByTestId("input-spec-ram").fill("32GB DDR5");
  await expect(page.getByTestId("spec-matrix-form").locator("[data-synced=true]")).toHaveCount(4);
});
