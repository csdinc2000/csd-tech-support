import { expect, test, type Page } from "@playwright/test";

const FIXTURE = "/tests/app-phone.fixture.html";

async function mockApi(page: Page, initial: boolean) {
  const state = { ringInApp: initial, saves: [] as boolean[] };
  await page.route("**/api/twilio/app-phone", async (route) => {
    if (route.request().method() === "PUT") {
      state.ringInApp = route.request().postDataJSON().ringInApp;
      state.saves.push(state.ringInApp);
    }
    await route.fulfill({ json: { ringInApp: state.ringInApp } });
  });
  await page.route("**/api/twilio/app-phone/token", (route) => route.fulfill({ json: { token: "fake-token", identity: "me", expiresInSeconds: 3600 } }));
  return state;
}

test("turning on 'Ring me in the app' connects this browser", async ({ page }) => {
  const state = await mockApi(page, false);
  await page.goto(FIXTURE);
  await page.getByTestId("app-phone-button").click();
  await expect(page.getByText("Calls ring your forwarded phone only.")).toBeVisible();
  await page.getByTestId("app-phone-ring-toggle").click();
  await expect.poll(() => state.saves).toEqual([true]);
  await expect(page.getByText(/Ready: business-line calls ring here/)).toBeVisible();
  expect(await page.evaluate(() => window.deviceToken)).toBe("fake-token");
});

test("an incoming call can be answered, muted, keyed and hung up", async ({ page }) => {
  await mockApi(page, true);
  await page.goto(FIXTURE);
  await page.getByTestId("app-phone-button").click();
  await expect(page.getByText(/Ready: business-line calls ring here/)).toBeVisible();

  await page.evaluate(() => window.fakeRing("+19545550123"));
  const ringing = page.getByRole("alertdialog", { name: "Incoming call from (954) 555-0123" });
  await expect(ringing).toBeVisible();
  await expect(page.getByTestId("app-phone-answer")).toBeFocused();
  await page.getByTestId("app-phone-answer").click();

  const active = page.getByTestId("app-phone-active");
  await expect(active).toContainText("(954) 555-0123");
  await page.getByRole("button", { name: "Mute" }).click();
  await page.getByRole("button", { name: "Keypad" }).click();
  await page.getByRole("button", { name: "Send 1" }).click();
  await page.getByTestId("app-phone-hangup").click();
  await expect(active).toHaveCount(0);
  expect(await page.evaluate(() => window.phoneLog)).toEqual(["accept", "mute", "digits:1", "disconnect"]);
});

test("declining stops the app ringing; a call answered elsewhere disappears", async ({ page }) => {
  await mockApi(page, true);
  await page.goto(FIXTURE);
  await page.getByTestId("app-phone-button").click();
  await expect(page.getByText(/Ready/)).toBeVisible();

  await page.evaluate(() => window.fakeRing("+19545550123"));
  await page.getByTestId("app-phone-decline").click();
  await expect(page.getByTestId("app-phone-incoming")).toHaveCount(0);

  await page.evaluate(() => window.fakeRing("+19545550124"));
  await expect(page.getByTestId("app-phone-incoming")).toBeVisible();
  await page.evaluate(() => window.fakeCancel());
  await expect(page.getByTestId("app-phone-incoming")).toHaveCount(0);
});

test("the dial pad offers a call once a full number is entered", async ({ page }) => {
  await mockApi(page, false);
  await page.goto(FIXTURE);
  await page.getByTestId("app-phone-button").click();
  await page.getByLabel("Call a number").fill("954555");
  await expect(page.getByTestId("call-via-csd")).toHaveCount(0);
  await page.getByLabel("Call a number").fill("9545550199");
  await page.getByTestId("call-via-csd").click();
  await expect(page.getByRole("button", { name: /Browser audio/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Saved phone/ })).toBeVisible();
});
