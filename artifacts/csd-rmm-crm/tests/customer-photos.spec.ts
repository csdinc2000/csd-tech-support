import { expect, test, type Page, type Route } from "@playwright/test";

// A 3000x2000 noisy PNG — big and incompressible like a real phone photo.
async function makeCameraPhoto(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 3000;
    canvas.height = 2000;
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
    return btoa(bin);
  });
  return Buffer.from(base64, "base64");
}

async function choose(page: Page, label: RegExp, option: string) {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).click();
}

test("the intake form sends one compressed device photo", async ({ page }) => {
  const intakes: any[] = [];
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/booking/services") {
      return route.fulfill({ json: [{ id: 3, name: "Computer Repair", basePriceCents: 0, durationMinutes: 60 }] });
    }
    if (path === "/api/intake" && request.method() === "POST") {
      intakes.push(request.postDataJSON());
      return route.fulfill({ json: { success: true, contact: { id: 1 }, lead: { id: 2 } } });
    }
    return route.abort();
  });

  await page.goto("/tests/customer-photos.fixture.html#intake");
  await page.getByLabel(/Full Name|Your Name|Name \*/).first().fill("Dana Rivera");
  await page.getByLabel(/Phone/).first().fill("9545550123");
  await page.getByLabel(/Email/).first().fill("dana@example.com");
  await choose(page, /service/i, "Computer Repair");
  await choose(page, /type of device/i, "Laptop");
  await page.getByLabel(/Brand & Model/).fill("Dell XPS 15");
  await choose(page, /Operating System/i, "Windows 11");
  await page.getByLabel(/problem|issue/i).first().fill("Laptop will not turn on after a storm.");
  await choose(page, /How did you hear/i, "Google Search");

  await expect(page.getByTestId("input-device-photo-camera")).toHaveAttribute("capture", "environment");
  const photo = await makeCameraPhoto(page);
  await page.getByTestId("input-device-photo-camera").setInputFiles({ name: "IMG_0001.png", mimeType: "image/png", buffer: photo });
  await expect(page.getByTestId("img-device-photo-preview")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("button-submit").click();
  await expect.poll(() => intakes.length).toBe(1);
  const sent = Buffer.from(intakes[0].device_photo.dataBase64, "base64");
  expect(sent.length).toBeLessThan(200 * 1024);
  expect(photo.length).toBeGreaterThan(sent.length * 10);
});

test("the intake form submits without a photo", async ({ page }) => {
  const intakes: any[] = [];
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/booking/services") return route.fulfill({ json: [{ id: 3, name: "Computer Repair", basePriceCents: 0, durationMinutes: 60 }] });
    if (path === "/api/intake") {
      intakes.push(request.postDataJSON());
      return route.fulfill({ json: { success: true, contact: { id: 1 }, lead: { id: 2 } } });
    }
    return route.abort();
  });
  await page.goto("/tests/customer-photos.fixture.html#intake");
  await page.getByLabel(/Full Name|Your Name|Name \*/).first().fill("Dana Rivera");
  await page.getByLabel(/Phone/).first().fill("9545550123");
  await page.getByLabel(/Email/).first().fill("dana@example.com");
  await choose(page, /service/i, "Computer Repair");
  await choose(page, /type of device/i, "Desktop");
  await page.getByLabel(/Brand & Model/).fill("HP Pavilion");
  await choose(page, /Operating System/i, "Windows 10");
  await page.getByLabel(/problem|issue/i).first().fill("Running very slowly lately.");
  await choose(page, /How did you hear/i, "Google Search");
  await page.getByTestId("button-submit").click();
  await expect.poll(() => intakes.length).toBe(1);
  expect(intakes[0].device_photo).toBeUndefined();
});

test("a customer without a photo shows a placeholder a technician can replace with the camera", async ({ page }) => {
  let avatar: { url: string; source: string; updatedAt: string } | null = null;
  const uploads: string[] = [];
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/clients/42/overview") {
      return route.fulfill({ json: { client: { id: 42, name: "Rivera Household", avatar } } });
    }
    if (path === "/api/clients/42/avatar" && request.method() === "PUT") {
      uploads.push(request.postDataJSON().dataBase64);
      avatar = { url: "/api/clients/42/avatar?v=1", source: "staff", updatedAt: new Date().toISOString() };
      return route.fulfill({ json: { avatar } });
    }
    if (path === "/api/clients/42/avatar" && request.method() === "GET") {
      return route.fulfill({ contentType: "image/jpeg", body: Buffer.from(uploads.at(-1)!, "base64") });
    }
    return route.abort();
  });

  await page.goto("/tests/customer-photos.fixture.html#avatar");
  await expect(page.getByTestId("placeholder-customer-avatar")).toBeVisible();
  await page.getByTestId("button-customer-avatar").click();
  await expect(page.getByText(/No photo yet/)).toBeVisible();
  await expect(page.getByTestId("input-avatar-camera")).toHaveAttribute("capture", "environment");

  const photo = await makeCameraPhoto(page);
  await page.getByTestId("input-avatar-camera").setInputFiles({ name: "IMG_0002.png", mimeType: "image/png", buffer: photo });
  await expect.poll(() => uploads.length, { timeout: 30_000 }).toBe(1);
  expect(Buffer.from(uploads[0], "base64").length).toBeLessThan(200 * 1024);
  await expect(page.getByTestId("img-customer-avatar")).toBeVisible();
  await expect(page.getByTestId("placeholder-customer-avatar")).toHaveCount(0);
  const loaded = await page.getByTestId("img-customer-avatar").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  expect(loaded).toBe(true);
});
